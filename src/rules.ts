import {
  Category,
  categoryNames,
  type Period,
  parse,
  type Repo,
  retiredCategories,
} from "./config.ts";
import type { Issue, PullRequest, Review } from "./github.ts";
import { Manifest } from "./project.ts";
import type { Git } from "./workspace.ts";

export const labels = {
  "milo:task": "64748b",
  "milo:ready": "16a34a",
  "milo:blocked": "dc2626",
};
const branchPattern = /^milo\/issue-[1-9][0-9]*$/;

// Markers lead a bot comment, so report text after them cannot forge one.
export const reviewStamp = (sha: string, merge = false) =>
  `<!-- milo:review:${sha} -->${merge ? "<!-- milo:merge -->" : ""}`;
// Records that a scheduled review or revision left nothing on this head for these change requests.
export const failedStamp = (sha: string, requests: Review[]) =>
  `<!-- milo:failed:${sha}:${requests.map((review) => review.id).join(",")} -->`;
export const ticketStamp = (category: Category, key: string) =>
  `<!-- milo:${category}:${key} -->`;
export const reviewed = (body: string, sha: string) =>
  body.startsWith(reviewStamp(sha));
export const mergeApproved = (body: string, sha: string) =>
  body.startsWith(reviewStamp(sha, true));
export const failed = (body: string, sha: string, requests: Review[]) =>
  body.startsWith(failedStamp(sha, requests));

function week(date: Date): string {
  const day = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const first = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  return `${day.getUTCFullYear()}-W${String(Math.ceil(((+day - +first) / 86400000 + 1) / 7)).padStart(2, "0")}`;
}
export function periodKey(period: Period, today = new Date()): string {
  return period === "week"
    ? week(today)
    : today.toISOString().slice(0, period === "day" ? 10 : 7);
}
// The category label's description records the last scan, so clean scans leave no issue behind.
export const scannedNote = (key: string) => `Milo scanned ${key}`;
export function finding(
  report: string,
): { title: string; body: string } | undefined {
  if (/(?:^|\n)\s*verdict:\s*clean\s*$/i.test(report)) return;
  const [first = "", ...rest] = report.split("\n");
  const title = /^(?:\*\*)?title:(?:\*\*)?\s*(.+)$/i.exec(first.trim())?.[1];
  if (!title) throw new Error("Scan report has neither a title nor a verdict");
  return { title: title.trim().slice(0, 200), body: rest.join("\n").trim() };
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
    !branchPattern.test(pr.head.ref)
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
  for (const path of manifests) {
    const [before, after] = await Promise.all(
      [from, "HEAD"].map((ref) =>
        git("show", `${ref}:${path}`).then(
          (text) => {
            const manifest = parse(Manifest, JSON.parse(text));
            return new Map(
              fields.flatMap((field) =>
                Object.entries(manifest[field]).map(([name, value]) => [
                  `${field}:${name}`,
                  value,
                ]),
              ),
            );
          },
          () => undefined,
        ),
      ),
    );
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
