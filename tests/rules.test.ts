import { expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import type { Issue, PullRequest, Review } from "../src/github.ts";
import {
  failed,
  failedStamp,
  finding,
  fixedStamp,
  fixesLeft,
  fixRequested,
  issueCategory,
  latestRequests,
  mergeApproved,
  nextReviewStep,
  ReviewResult,
  reviewed,
  reviewStamp,
  ScanResult,
  scannedNote,
  shouldScan,
  taskBranch,
  ticketDraft,
  ticketNumber,
  VerifiedResult,
  validateIssue,
  validatePR,
} from "../src/rules.ts";
import { issue } from "./helpers.ts";

test("retired categories map to their replacements in tickets and config", () => {
  const labelled = (...names: string[]): Issue => ({
    ...issue(),
    labels: names.map((name) => ({ name: `milo:${name}` })),
  });
  expect(issueCategory(labelled("organisation"))).toBe("architecture");
  // Authors can edit the body, so a body marker alone grants no category.
  expect(
    issueCategory(issue("<!-- milo:organisation:2026-W42 -->")),
  ).toBeUndefined();
  // Two retired names for one category are not ambiguous.
  expect(issueCategory(labelled("cleanup", "modernisation"))).toBe("simplify");
  expect(issueCategory(labelled("cleanup", "bugs"))).toBeUndefined();
  expect(
    parseConfig({
      agent: { provider: "claude" },
      repos: [
        {
          name: "owner/repo",
          categories: ["cleanup", "modernisation", "simplify", "organisation"],
        },
      ],
    }).repos[0]?.categories,
  ).toEqual(["simplify", "architecture"]);
});
test("scan results become a titled finding or nothing", () => {
  const result = { clean: false, title: " Bump\nhono ", body: "Evidence\n" };
  expect(finding({ ...result, clean: true })).toBeUndefined();
  expect(finding(result)).toEqual({
    title: "Bump hono",
    body: "Evidence",
    ready: false,
    blockedBy: [],
  });
  expect(finding({ ...result, ready: true })?.ready).toBe(true);
  expect(() => finding({ ...result, title: " " })).toThrow("title");
  // Missing or mistyped fields fail validation instead of filing a ticket.
  expect(VerifiedResult.safeParse(result).success).toBe(false);
  expect(ScanResult.safeParse({ ...result, clean: "no" }).success).toBe(false);
});
test("only approved tickets and same-repo Milo PRs may run", () => {
  validateIssue(issue());
  expect(() => validateIssue({ ...issue(), labels: [] })).toThrow();
  expect(() => validateIssue({ ...issue(), pull_request: {} })).toThrow();
  expect(() =>
    validateIssue({
      ...issue(),
      labels: [...issue().labels, { name: "milo:blocked" }],
    }),
  ).toThrow();
  const pr: PullRequest = {
    number: 34,
    state: "open",
    body: "",
    html_url: "",
    head: {
      ref: "milo/issue-12",
      sha: "head",
      repo: { full_name: "owner/repo" },
    },
    base: { ref: "main", sha: "base" },
  };
  validatePR(pr, { name: "owner/repo" });
  expect(() =>
    validatePR(
      { ...pr, head: { ...pr.head, repo: { full_name: "attacker/repo" } } },
      { name: "owner/repo" },
    ),
  ).toThrow();
  expect(() =>
    validatePR({ ...pr, state: "closed" }, { name: "owner/repo" }),
  ).toThrow();
});
test("a task branch names exactly one ticket", () => {
  for (const ticket of [1, 12, Number.MAX_SAFE_INTEGER])
    expect(ticketNumber(taskBranch(ticket))).toBe(ticket);
  for (const ref of [
    "feature/x",
    "milo/issue-",
    "milo/issue-0",
    "milo/issue-012",
    "milo/issue-12x",
    "milo/issue-1e3",
    "milo/issue-99999999999999999999",
    "refs/heads/milo/issue-12",
  ])
    expect(ticketNumber(ref)).toBeUndefined();
});
test("review revisions use the current effective review on the current commit", () => {
  const request: Review = {
    id: 1,
    state: "CHANGES_REQUESTED",
    commit_id: "head",
    user: { login: "owner" },
    body: "fix",
  };
  expect(latestRequests([request], "head")).toEqual([request]);
  expect(latestRequests([request], "new-head")).toEqual([]);
  expect(
    latestRequests([request, { ...request, id: 2, state: "APPROVED" }], "head"),
  ).toEqual([]);
  expect(
    latestRequests(
      [request, { ...request, id: 2, state: "COMMENTED" }],
      "head",
    ),
  ).toEqual([request]);
});
test("markers match only at the start of a comment and only for their commit", () => {
  const request: Review = {
    id: 1,
    state: "CHANGES_REQUESTED",
    commit_id: "abc",
    user: { login: "owner" },
    body: "",
  };
  expect(reviewed(`${reviewStamp("abc")}\n\nreport`, "abc")).toBeTrue();
  expect(
    reviewed(`${reviewStamp("abc", "merge")}\n\nreport`, "abc"),
  ).toBeTrue();
  expect(reviewed(`quoted ${reviewStamp("abc")}`, "abc")).toBeFalse();
  expect(reviewed(reviewStamp("abc"), "ab")).toBeFalse();
  expect(reviewed(reviewStamp("abc"), "abcd")).toBeFalse();
  expect(mergeApproved(reviewStamp("abc", "merge"), "abc")).toBeTrue();
  expect(mergeApproved(reviewStamp("abc"), "abc")).toBeFalse();
  expect(mergeApproved(reviewStamp("abc", "merge"), "def")).toBeFalse();
  expect(mergeApproved(`x${reviewStamp("abc", "merge")}`, "abc")).toBeFalse();
  expect(failed(failedStamp("abc", [request]), "abc", [request])).toBeTrue();
  expect(failed(failedStamp("abc", []), "abc", [request])).toBeFalse();
  expect(failed(failedStamp("abc", [request]), "abc", [])).toBeFalse();
  expect(failed(failedStamp("abc", []), "def", [])).toBeFalse();
  expect(failed(` ${failedStamp("abc", [])}`, "abc", [])).toBeFalse();
  expect(failed(failedStamp("abc", [], true), "abc", [])).toBeFalse();
  expect(failed(failedStamp("abc", []), "abc", [], true)).toBeFalse();
  expect(fixRequested(reviewStamp("abc", "fix"), "abc")).toBeTrue();
  expect(fixRequested(reviewStamp("abc", "merge"), "abc")).toBeFalse();
  expect(mergeApproved(reviewStamp("abc", "fix"), "abc")).toBeFalse();
  expect(fixesLeft([`${fixedStamp}\n\nReview findings addressed.`])).toBeTrue();
  expect(fixesLeft([fixedStamp, `quoted ${fixedStamp}`])).toBeTrue();
  expect(fixesLeft([fixedStamp, fixedStamp])).toBeFalse();
});

test("next review step follows the bot-comment stamps", () => {
  const request: Review = {
    id: 1,
    state: "CHANGES_REQUESTED",
    commit_id: "abc",
    user: { login: "owner" },
    body: "",
  };
  const cases: [Review[], string[], ReturnType<typeof nextReviewStep>][] = [
    [[request], [], "revise"],
    [[request], [reviewStamp("abc", "merge")], "revise"],
    // An already-failed revision falls through to the remaining stamps.
    [[request], [failedStamp("abc", [request])], "review"],
    [
      [request],
      [failedStamp("abc", [request]), reviewStamp("abc", "merge")],
      "merge",
    ],
    [[], [reviewStamp("abc", "merge")], "merge"],
    [[], [reviewStamp("abc")], "skip"],
    // Only the stamp itself can approve a merge, not a marker later in the report.
    [[], [`${reviewStamp("abc")}\n\n<!-- milo:merge -->`], "skip"],
    [[], [reviewStamp("old", "merge")], "review"],
    [[], [failedStamp("abc", [])], "skip"],
    // A fix verdict queues one fix attempt per head; a human's request still comes first.
    [[], [reviewStamp("abc", "fix")], "fix"],
    [[request], [reviewStamp("abc", "fix")], "revise"],
    [[], [failedStamp("abc", [], true), reviewStamp("abc", "fix")], "skip"],
    [[], [failedStamp("abc", []), reviewStamp("abc", "fix")], "fix"],
    [[], [reviewStamp("old", "fix")], "review"],
    [[], [failedStamp("old", [])], "review"],
    [[], [], "review"],
  ];
  for (const [requests, comments, step] of cases)
    expect(nextReviewStep("abc", requests, comments)).toBe(step);
});

test("a review result missing reversibility fails validation, so no verdict can merge it", () => {
  const result = {
    verdict: "merge",
    reversibility: "two-way",
    blastRadius: "Saved settings",
    body: "Report",
  };
  expect(ReviewResult.safeParse(result).success).toBe(true);
  const { reversibility: _, ...missing } = result;
  expect(ReviewResult.safeParse(missing).success).toBe(false);
});

test("a category scans unless this period's note or an open labelled ticket says otherwise", () => {
  const labelled = { ...issue(), labels: [{ name: "milo:security" }] };
  expect(shouldScan(null, "2026-W44", [], "security")).toBe(true);
  expect(shouldScan(scannedNote("2026-W43"), "2026-W44", [], "security")).toBe(
    true,
  );
  expect(shouldScan(scannedNote("2026-W44"), "2026-W44", [], "security")).toBe(
    false,
  );
  expect(shouldScan(null, "2026-W44", [labelled], "security")).toBe(false);
  // Another category's ticket does not hold this one.
  expect(shouldScan(null, "2026-W44", [labelled], "simplify")).toBe(true);
  // Anyone can file an issue with a body marker, so it does not skip a scan.
  expect(
    shouldScan(
      null,
      "2026-W44",
      [issue("<!-- milo:security:2026-W44 -->")],
      "security",
    ),
  ).toBe(true);
});
test("a ticket is ready through autoReady or the verifier, and names its merge policy", () => {
  const repo = { name: "owner/repo", setup: [], checks: [] };
  const found = {
    title: "Patch hono",
    body: "Reproduced",
    ready: false,
    blockedBy: [],
  };
  const held = ticketDraft(found, repo, "security", "2026-W44");
  expect(held).toEqual({
    title: "Patch hono",
    labels: ["milo:task", "milo:security"],
    body: "<!-- milo:security:2026-W44 -->\n\nReproduced\n\nAdd `milo:ready` to authorise execution. Milo never merges this category.",
  });
  for (const draft of [
    ticketDraft({ ...found, ready: true }, repo, "security", "2026-W44"),
    ticketDraft(
      found,
      { ...repo, autoReady: ["security"] },
      "security",
      "2026-W44",
    ),
  ]) {
    expect(draft.labels).toEqual(["milo:task", "milo:security", "milo:ready"]);
    expect(draft.body).toContain("remove `milo:ready` to hold it.");
  }
  // autoReady and autoMerge are per category.
  expect(
    ticketDraft(found, { ...repo, autoReady: ["simplify"] }, "security", "k")
      .labels,
  ).not.toContain("milo:ready");
  expect(
    ticketDraft(found, { ...repo, autoMerge: ["security"] }, "security", "k")
      .body,
  ).toEndWith(" Milo may merge a minor, reviewed PR after CI passes.");
});
