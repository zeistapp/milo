import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { command, temporary } from "../src/process.ts";
import { openWorkspace } from "../src/workspace.ts";

const repo = { name: "owner/repo" };
const open = (root: string) =>
  openWorkspace(repo, root, async (_repo, root, git) => {
    await command(["git", "init", "-q", root]);
    await git("config", "user.name", "Test");
  });

test("Milo's git refuses to run after config changes it did not make", () =>
  temporary("milo-workspace-", async (folder) => {
    const cases = [
      ["config", "[milo], tampered"],
      ["commondir", ".git/commondir"],
      ["config.worktree", ".git/config.worktree"],
    ] as const;
    for (const [mode, error] of cases) {
      const root = join(folder, mode);
      const { git } = await open(root);
      if (mode === "config")
        await appendFile(join(root, ".git/config"), "[milo]\n\ttampered = 1\n");
      if (mode === "commondir")
        await Bun.write(join(root, ".git/commondir"), ".");
      if (mode === "config.worktree")
        await Bun.write(
          join(root, ".git/config.worktree"),
          "[core]\n\thooksPath = .\n",
        );
      await expect(git("status")).rejects.toThrow(error);
    }
    const root = join(folder, "trusted");
    const { git } = await open(root);
    // Claude's sandbox leaves an empty config.worktree; it sets nothing.
    await Bun.write(join(root, ".git/config.worktree"), "");
    // Config Milo's own git writes is the new baseline.
    await git("config", "milo.own", "1");
    expect(await git("config", "milo.own")).toBe("1");
  }));

test("a read-only run must leave the clone unchanged", () =>
  temporary("milo-workspace-", async (folder) => {
    const root = join(folder, "repo");
    const { assertUnchanged } = await open(root);
    await assertUnchanged();
    await Bun.write(join(root, "file.txt"), "x");
    await expect(assertUnchanged()).rejects.toThrow("Read-only run");
  }));

test("tasks cannot change agent instruction or CI action files", () =>
  temporary("milo-protected-", async (folder) => {
    const root = join(folder, "repo");
    const { changes } = await open(root);
    for (const file of [
      "AGENTS.md",
      "CLAUDE.md",
      "app/CLAUDE.md",
      ".claude/rules/a.md",
      "action.yml",
      "actions/setup/action.yaml",
    ]) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await Bun.write(join(root, file), "changed policy");
      await expect(changes()).rejects.toThrow("protected");
      await command(["git", "rm", "--cached", "--quiet", "-r", "."], {
        cwd: root,
      });
      await command(["git", "clean", "-fdq"], { cwd: root });
    }
    await Bun.write(join(root, "src.ts"), "ok");
    expect(await changes()).toBe(true);
  }));

test("a global git config cannot run programs from Milo's git", () =>
  temporary("milo-global-", async (folder) => {
    const root = join(folder, "repo");
    const home = join(folder, "home");
    const marker = join(folder, "ran");
    await mkdir(home);
    const { changes } = await open(root);
    await Bun.write(join(root, "file.txt"), "x");
    const hook = join(folder, "hook.sh");
    await Bun.write(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    await command(["chmod", "+x", hook]);
    await Bun.write(
      join(home, ".gitconfig"),
      `[core]\n\tfsmonitor = ${hook}\n`,
    );
    const previous = {
      HOME: process.env.HOME,
      XDG: process.env.XDG_CONFIG_HOME,
    };
    try {
      process.env.HOME = home;
      process.env.XDG_CONFIG_HOME = join(home, ".config");
      expect(await changes()).toBeTrue();
      expect(existsSync(marker)).toBeFalse();
      // Plain git in the same environment does run it, so the check above is meaningful.
      await command(["git", "status"], { cwd: root });
      expect(existsSync(marker)).toBeTrue();
    } finally {
      process.env.HOME = previous.HOME;
      if (previous.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous.XDG;
    }
  }));
