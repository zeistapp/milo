import { lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Repo } from "./config.ts";
import { author } from "./github.ts";
import { command } from "./process.ts";

export type Git = (...args: string[]) => Promise<string>;
// Receives git for the fresh clone; config it sets is trusted, since no untrusted code has run yet.
export type Clone = (repo: Repo, root: string, git: Git) => Promise<void>;
export interface Workspace {
  // Throws if the clone's git config changed since Milo's previous git call.
  git: Git;
  // Stages everything; throws if protected files changed. True when anything is staged.
  changes(): Promise<boolean>;
  // Throws unless a read-only run left the clone exactly as it was.
  assertUnchanged(): Promise<void>;
}
// Git config can make git run programs, and Milo's git holds the write token. It skips global
// and system config, which untrusted code running as the same user could edit, and reads only
// the clone's config, which every call pins to the bytes Milo's previous call left.
const gitEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const readConfig = (root: string) => readFile(join(root, ".git", "config"));
// CEILING: a process that outlives its step (the agent is not in the step sandbox) could
// rewrite config during Milo's own git call; running untrusted code in a separate copy would close that.
function assertIntact(root: string, snapshot: Buffer, config: Buffer): void {
  // Claude's Linux sandbox leaves an empty config.worktree as a mount point; empty sets nothing.
  const added = ["commondir", "config.worktree"].filter((name) => {
    const file = lstatSync(join(root, ".git", name), { throwIfNoEntry: false });
    return file && (name === "commondir" || !file.isFile() || file.size > 0);
  });
  if (config.equals(snapshot) && !added.length) return;
  // Names only: values could carry whatever untrusted code wrote.
  const lines = (text: Buffer) => new Set(text.toString().split("\n"));
  const changed = lines(snapshot).symmetricDifference(lines(config));
  const names = [...changed].map((line) => line.split("=")[0]?.trim());
  throw new Error(
    `Untrusted code changed the clone's git config: ${[...new Set([...names, ...added.map((name) => `.git/${name}`)])].join(", ")}`,
  );
}
const protectedParts = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude",
  "action.yml",
  "action.yaml",
];
export async function openWorkspace(
  repo: Repo,
  root: string,
  cloneRepo: Clone,
): Promise<Workspace> {
  const run: Git = (...args) =>
    command(["git", ...args], { cwd: root, env: gitEnv });
  await cloneRepo(repo, root, run);
  let snapshot = await readConfig(root);
  const git: Git = async (...args) => {
    assertIntact(root, snapshot, await readConfig(root));
    try {
      return await run(...args);
    } finally {
      snapshot = await readConfig(root);
    }
  };
  return {
    git,
    async changes() {
      await git("add", "--all");
      // --no-renames lists a moved file's old path too, so moving a
      // protected file away cannot hide it from the check below.
      const files = (
        await git("diff", "--cached", "--no-renames", "--name-only", "-z")
      ).split("\0");
      if (
        files.some(
          (file) =>
            file.split("/").some((part) => protectedParts.includes(part)) ||
            [".github/", ".milo/"].some((prefix) => file.startsWith(prefix)) ||
            [".gitmodules", "milo.config.json"].includes(file),
        )
      ) {
        throw new Error("Task changed protected automation or policy files");
      }
      return Boolean(await git("diff", "--cached", "--stat"));
    },
    async assertUnchanged() {
      if (await git("status", "--porcelain"))
        throw new Error("Read-only run changed files");
    },
  };
}

export async function clone(repo: Repo, root: string, git: Git): Promise<void> {
  await command(["gh", "repo", "clone", repo.name, root, "--", "--no-tags"]);
  const [name, email] = await author();
  for (const [key, value] of [
    ["user.name", name],
    ["user.email", email],
    ["core.hooksPath", "/dev/null"],
    ["credential.helper", "!gh auth git-credential"],
  ] as const) {
    await git("config", key, value);
  }
}
