import { z } from "zod";
import {
  Category,
  categoryNames,
  type Period,
  parse,
  type Repo,
  retiredCategories,
} from "./config.ts";
import {
  type GitHubClient,
  type Issue,
  type PullRequest,
  Review,
} from "./github.ts";
import { Manifest } from "./project.ts";
import type { Git } from "./workspace.ts";

export const labels = {
  "milo:task": "64748b",
  "milo:ready": "16a34a",
  "milo:blocked": "dc2626",
};
const taskBranchPrefix = "milo/issue-";
// Ticket N is worked on, and its PR opened from, this branch.
export const taskBranch = (ticket: number) => `${taskBranchPrefix}${ticket}`;
// The ticket a task branch belongs to, or undefined for any other ref.
export function ticketNumber(ref: string): number | undefined {
  if (!ref.startsWith(taskBranchPrefix)) return;
  const digits = ref.slice(taskBranchPrefix.length);
  const ticket = Number(digits);
  return /^[1-9][0-9]*$/.test(digits) && Number.isSafeInteger(ticket)
    ? ticket
    : undefined;
}

// Markers lead a bot comment, so report text after them cannot forge one.
export const reviewStamp = (sha: string, mark?: "merge" | "fix") =>
  `<!-- milo:review:${sha} -->${mark ? `<!-- milo:${mark} -->` : ""}`;
// Records that a scheduled review, revision or fix left nothing on this head for these change requests.
export const failedStamp = (sha: string, requests: Review[], fix = false) =>
  `<!-- milo:failed:${sha}:${requests.map((review) => review.id).join(",")}${fix ? ":fix" : ""} -->`;
// Leads the comment on each commit Milo pushed to fix its own review's findings.
export const fixedStamp = "<!-- milo:fixed -->";
export const ticketStamp = (category: Category, key: string) =>
  `<!-- milo:${category}:${key} -->`;
export const reviewed = (body: string, sha: string) =>
  body.startsWith(reviewStamp(sha));
export const mergeApproved = (body: string, sha: string) =>
  body.startsWith(reviewStamp(sha, "merge"));
export const fixRequested = (body: string, sha: string) =>
  body.startsWith(reviewStamp(sha, "fix"));
export const failed = (
  body: string,
  sha: string,
  requests: Review[],
  fix = false,
) => body.startsWith(failedStamp(sha, requests, fix));
// Bounds what one PR can spend on fixing its own reviews; past it, a human takes over.
const autoFixLimit = 2;
export const fixesLeft = (botComments: string[]) =>
  botComments.filter((body) => body.startsWith(fixedStamp)).length <
  autoFixLimit;

function week(date: Date): string {
  const day = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const first = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  return `${day.getUTCFullYear()}-W${String(Math.ceil(((+day - +first) / 86400000 + 1) / 7)).padStart(2, "0")}`;
}
// Daily windows of more than one day count from the Unix epoch, so every run agrees on the window's first day.
export function periodKey(
  period: Period,
  today = new Date(),
  everyDays = 1,
): string {
  const window = 86400000 * everyDays;
  return period === "week"
    ? week(today)
    : period === "day"
      ? new Date(Math.floor(+today / window) * window)
          .toISOString()
          .slice(0, 10)
      : today.toISOString().slice(0, 7);
}
// The category label's description records the last scan, so clean scans leave no issue behind.
export const scannedNote = (key: string) => `Milo scanned ${key}`;
export function finding(
  report: string,
): { title: string; body: string } | undefined {
  // Models wrap these lines in markdown, narrate around them and put the verdict first, so tolerate all three.
  if (/^[\s>#*_`]*verdict:[\s*_`]*clean[\s*_`.]*$/im.test(report)) return;
  const match = /^[\s>#*_]*title:[*_]*[ \t]*(\S.*)$/im.exec(report);
  if (!match?.[1])
    throw new Error("Scan report has neither a title nor a verdict");
  return {
    title: match[1].trim().slice(0, 200),
    body: report.slice(match.index + match[0].length).trim(),
  };
}
// Labels only: issue authors can edit the body, but labelling needs triage access.
export function issueCategory(issue: Issue): Category | undefined {
  const matches = new Set(
    [...categoryNames, ...Object.keys(retiredCategories)]
      .filter((name) =>
        issue.labels.some((label) => label.name === `milo:${name}`),
      )
      .map((name) => parse(Category, name)),
  );
  return matches.size === 1 ? [...matches][0] : undefined;
}
export function validateIssue(issue: Issue): void {
  const names = new Set(issue.labels.map((label) => label.name));
  if (
    issue.state !== "open" ||
    Object.hasOwn(issue, "pull_request") ||
    !names.has("milo:task") ||
    !names.has("milo:ready") ||
    names.has("milo:blocked")
  ) {
    throw new Error("Issue must be open, ready, a Milo task, and not blocked");
  }
}
export function validatePR(pr: PullRequest, repo: Repo): void {
  if (
    pr.state !== "open" ||
    pr.head.repo?.full_name.toLowerCase() !== repo.name.toLowerCase() ||
    ticketNumber(pr.head.ref) === undefined
  ) {
    throw new Error(
      "Only open Milo PRs from the configured repository are supported",
    );
  }
}
export function latestRequests(reviews: Review[], sha?: string): Review[] {
  const latest = new Map<string, Review>();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state))
      // A review without a user stands alone, so it is never superseded.
      latest.set(review.user?.login ?? `#${review.id}`, review);
  }
  return [...latest.values()].filter(
    (review) =>
      review.state === "CHANGES_REQUESTED" &&
      (sha === undefined || review.commit_id === sha),
  );
}
export type CheckRun = { status: string; conclusion: string | null };
export type CombinedStatus = { state: string; total_count: number };
// Failed CI waits too: a later run retries once a new commit or rerun passes.
export function ciState(
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
export type MergeFacts = {
  outstandingRequests: number;
  ci: ReturnType<typeof ciState>;
  behindBy: number;
};
// Reads what mergeAction needs about an auto-merge-eligible PR's head commit.
export async function mergeFacts(
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
export type MergeAction = {
  kind: "skip" | "waiting" | "no-ci" | "update-branch" | "merge";
};
// Merges only once CI on the head passed and the branch includes its base.
export function mergeAction(facts: MergeFacts): MergeAction {
  if (facts.outstandingRequests) return { kind: "skip" };
  if (facts.ci === "none") return { kind: "no-ci" };
  if (facts.ci === "waiting") return { kind: "waiting" };
  return { kind: facts.behindBy ? "update-branch" : "merge" };
}
// Only the report's last line counts, so a verdict quoted from the diff or ticket cannot set it.
export function reviewVerdict(report: string): "merge" | "fix" | "hold" {
  const last = report.trim().split("\n").at(-1) ?? "";
  const verdict = /^[\s>*_`]*verdict:[\s*_`]*(merge|fix)[\s*_`.]*$/i
    .exec(last)?.[1]
    ?.toLowerCase();
  return verdict === "merge" || verdict === "fix" ? verdict : "hold";
}
// Turns the verdict into the review stamp's mark: fix queues a revision, merge queues an
// auto-merge for an eligible PR that no deterministic limit blocks.
export async function reviewOutcome(
  report: string,
  eligible: boolean,
  canFix: boolean,
  blocker: () => Promise<string | undefined>,
): Promise<{ mark?: "merge" | "fix"; note: string }> {
  const verdict = reviewVerdict(report);
  if (verdict === "fix")
    return canFix
      ? { mark: "fix", note: "\n\nMilo fixes these findings next." }
      : {
          note: "\n\nMilo has used its automatic fixes on this PR; a human must address these findings.",
        };
  if (!eligible) return { note: "" };
  const held = verdict === "merge" ? await blocker() : "review verdict";
  return held
    ? { note: `\n\nAuto-merge held (${held}); a human must review this PR.` }
    : {
        mark: "merge",
        note: "\n\nAuto-merge queued: Milo merges this commit after its CI passes.",
      };
}
// Picks what a scheduled run does with an open Milo PR from its bot-comment stamps.
export function nextReviewStep(
  sha: string,
  requests: Review[],
  botComments: string[],
): "revise" | "fix" | "review" | "merge" | "skip" {
  const attempted = (requests: Review[], fix = false) =>
    botComments.some((body) => failed(body, sha, requests, fix));
  if (requests.length && !attempted(requests)) return "revise";
  const review = botComments.find((body) => reviewed(body, sha));
  if (review) {
    if (mergeApproved(review, sha)) return "merge";
    // The review checked the fix budget when it stamped fix, and only a new head spends it.
    return fixRequested(review, sha) && !attempted([], true) ? "fix" : "skip";
  }
  return attempted([]) ? "skip" : "review";
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
export async function mergeBlocker(
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
