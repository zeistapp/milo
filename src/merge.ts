import { z } from "zod";
import { parse } from "./config.ts";
import { type GitHubClient, type PullRequest, Review } from "./github.ts";
import { Manifest } from "./project.ts";
import { latestRequests, type ReviewResult } from "./rules.ts";
import type { Git } from "./workspace.ts";

// The auto-merge policy: what a review's verdict marks, and what a later run does with a marked PR.

type CheckRun = { status: string; conclusion: string | null };
type CombinedStatus = { state: string; total_count: number };
// Failed CI waits too: a later run retries once a new commit or rerun passes.
function ciState(
  runs: CheckRun[],
  status: CombinedStatus,
): "none" | "waiting" | "passed" {
  if (!runs.length && !status.total_count) return "none";
  return runs.some(
    (run) =>
      run.status !== "completed" ||
      !["success", "neutral", "skipped"].includes(run.conclusion ?? ""),
  ) ||
    (status.total_count && status.state !== "success")
    ? "waiting"
    : "passed";
}
type MergeFacts = {
  outstandingRequests: number;
  ci: ReturnType<typeof ciState>;
  behindBy: number;
};
// Reads what mergeAction needs about an auto-merge-eligible PR's head commit.
async function mergeFacts(
  gh: GitHubClient,
  pr: PullRequest,
): Promise<MergeFacts> {
  const [reviews, runs, status, compare] = await Promise.all([
    gh.pages(`pulls/${pr.number}/reviews`),
    // Every page: a failing run past the first 100 must still block the merge.
    gh.pages(`commits/${pr.head.sha}/check-runs`, "check_runs"),
    gh.api(`commits/${pr.head.sha}/status`),
    gh.api(`compare/${pr.base.ref}...${pr.head.sha}`),
  ]);
  return {
    outstandingRequests: latestRequests(parse(z.array(Review), reviews)).length,
    ci: ciState(
      parse(
        z.array(
          z.object({ status: z.string(), conclusion: z.string().nullable() }),
        ),
        runs,
      ),
      parse(z.object({ state: z.string(), total_count: z.number() }), status),
    ),
    behindBy: parse(z.object({ behind_by: z.number() }), compare).behind_by,
  };
}
type MergeAction = {
  kind: "skip" | "waiting" | "no-ci" | "update-branch" | "merge";
};
// Merges only once CI on the head passed and the branch includes its base.
function mergeAction(facts: MergeFacts): MergeAction {
  if (facts.outstandingRequests) return { kind: "skip" };
  if (facts.ci === "none") return { kind: "no-ci" };
  if (facts.ci === "waiting") return { kind: "waiting" };
  return { kind: facts.behindBy ? "update-branch" : "merge" };
}
// What a run does with an auto-merge-eligible PR whose head Milo's review marked for merge.
export async function mergeDecision(
  gh: GitHubClient,
  pr: PullRequest,
): Promise<MergeAction> {
  return mergeAction(await mergeFacts(gh, pr));
}

const lockfiles = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
// CEILING: line count is a crude proxy for "minor"; make it configurable if it holds safe changes.
const mergeLineLimit = 300;
const plainVersion = /^[\^~]?(\d+)\.(\d+)\.(\d+)$/;
function breakingPart(version: string): string | undefined {
  const match = plainVersion.exec(version);
  if (!match) return;
  const [, major, minor, patch] = match;
  return major !== "0" ? major : minor !== "0" ? `0.${minor}` : `0.0.${patch}`;
}
// Deterministic limits an agent's merge verdict cannot override. Returns why a change needs a human.
async function mergeBlocker(
  git: Git,
  base: string,
): Promise<string | undefined> {
  const from = await git("merge-base", base, "HEAD");
  const stats = await git(
    "diff",
    "--numstat",
    "--no-renames",
    from,
    "HEAD",
    "--",
  );
  let lines = 0;
  const manifests: string[] = [];
  for (const row of stats.split("\n").filter(Boolean)) {
    const [added = "-", deleted = "-", path = ""] = row.split("\t");
    if (added === "-" || deleted === "-") return "binary change";
    const name = path.split("/").at(-1) ?? "";
    if (name === "package.json") manifests.push(path);
    if (!lockfiles.has(name)) lines += Number(added) + Number(deleted);
  }
  if (lines > mergeLineLimit) return `${lines} changed lines`;
  const fields = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const;
  // Absent at ref: undefined. Present but invalid JSON or schema: "unreadable".
  const dependencies = async (ref: string, path: string) => {
    let text: string;
    try {
      text = await git("show", `${ref}:${path}`);
    } catch {
      return;
    }
    try {
      const manifest = parse(Manifest, JSON.parse(text));
      return new Map(
        fields.flatMap((field) =>
          Object.entries(manifest[field]).map(([name, value]) => [
            `${field}:${name}`,
            value,
          ]),
        ),
      );
    } catch {
      return "unreadable" as const;
    }
  };
  for (const path of manifests) {
    const [before, after] = await Promise.all(
      [from, "HEAD"].map((ref) => dependencies(ref, path)),
    );
    if (before === "unreadable" || after === "unreadable")
      return `${path} unreadable`;
    if (!before || !after) return `${path} added or removed`;
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const [old, next] = [before.get(key), after.get(key)];
      if (old === next) continue;
      if (old === undefined || next === undefined)
        return `dependency added or removed in ${path}`;
      const part = breakingPart(old);
      if (!part || part !== breakingPart(next))
        return `major or non-semver change to ${key.split(":")[1]}`;
    }
  }
}
// Turns the verdict into the review stamp's mark: fix queues a revision, merge queues an
// auto-merge for an eligible two-way-door PR that no deterministic limit blocks.
// `git` runs in the PR's checkout at its head; `base` is the base commit to diff from.
export async function reviewMark(
  { verdict, reversibility, blastRadius }: ReviewResult,
  {
    eligible,
    canFix,
    git,
    base,
  }: { eligible: boolean; canFix: boolean; git: Git; base: string },
): Promise<{ mark?: "merge" | "fix"; note: string }> {
  if (verdict === "fix")
    return canFix
      ? { mark: "fix", note: "\n\nMilo fixes these findings next." }
      : {
          note: "\n\nMilo has used its automatic fixes on this PR; a human must address these findings.",
        };
  if (!eligible) return { note: "" };
  const held =
    verdict !== "merge"
      ? "review verdict"
      : reversibility === "one-way"
        ? `one-way door; if this is wrong: ${blastRadius.split("\n")[0]?.trim()}`
        : await mergeBlocker(git, base);
  return held
    ? { note: `\n\nAuto-merge held (${held}); a human must review this PR.` }
    : {
        mark: "merge",
        note: "\n\nAuto-merge queued: Milo merges this commit after its CI passes.",
      };
}
