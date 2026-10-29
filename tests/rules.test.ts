import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import type {
  GitHubClient,
  Issue,
  PullRequest,
  Review,
} from "../src/github.ts";
import { command, temporary } from "../src/process.ts";
import {
  ciState,
  failed,
  failedStamp,
  finding,
  fixedStamp,
  fixesLeft,
  fixRequested,
  issueCategory,
  latestRequests,
  mergeAction,
  mergeApproved,
  mergeBlocker,
  mergeFacts,
  nextReviewStep,
  ReviewResult,
  reviewed,
  reviewOutcome,
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

function issue(body = "", state = "open"): Issue {
  return {
    number: 12,
    title: "Maintenance",
    body,
    state,
    html_url: "https://example.test/issue/12",
    created_at: "2026-10-15T09:00:00Z",
    labels: [{ name: "milo:task" }, { name: "milo:ready" }],
    user: { login: "milo" },
  };
}
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
test("auto-merge blocks majors, dependency changes and large diffs", () =>
  temporary("milo-merge-", async (root) => {
    const git = (...args: string[]) => command(["git", ...args], { cwd: root });
    const manifest = (dependencies: Record<string, string>) =>
      Bun.write(join(root, "package.json"), JSON.stringify({ dependencies }));
    const commit = async () => {
      await git("add", ".");
      await git("commit", "-qm", "change");
      return git("rev-parse", "HEAD");
    };
    await git("init", "-q");
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.test");
    await manifest({ hono: "^4.1.0", tiny: "0.3.1", exact: "1.0.0" });
    const base = await commit();
    await manifest({ hono: "^4.9.2", tiny: "0.3.9", exact: "1.0.1" });
    await Bun.write(join(root, "bun.lock"), "x\n".repeat(1000));
    await commit();
    expect(await mergeBlocker(git, base)).toBeUndefined();
    const cases: [Record<string, string>, string][] = [
      [{ hono: "^5.0.0", tiny: "0.3.1", exact: "1.0.0" }, "major"],
      [{ hono: "^4.1.0", tiny: "0.4.0", exact: "1.0.0" }, "major"],
      [{ hono: "latest", tiny: "0.3.1", exact: "1.0.0" }, "non-semver"],
      [{ hono: "^4.1.0", tiny: "0.3.1" }, "removed"],
    ];
    for (const [dependencies, reason] of cases) {
      await git("checkout", "-q", "--detach", base);
      await manifest(dependencies);
      await commit();
      expect(await mergeBlocker(git, base)).toContain(reason);
    }
    for (const text of ["{", '{"dependencies":[]}']) {
      await git("checkout", "-q", "--detach", base);
      await Bun.write(join(root, "package.json"), text);
      const broken = await commit();
      expect(await mergeBlocker(git, base)).toBe("package.json unreadable");
      await manifest({ hono: "^4.1.0", tiny: "0.3.1", exact: "1.0.1" });
      await commit();
      expect(await mergeBlocker(git, broken)).toBe("package.json unreadable");
    }
    await git("checkout", "-q", "--detach", base);
    await Bun.write(join(root, "big.ts"), "x\n".repeat(300));
    await commit();
    expect(await mergeBlocker(git, base)).toBeUndefined();
    await git("checkout", "-q", "--detach", base);
    await Bun.write(join(root, "big.ts"), "x\n".repeat(301));
    await commit();
    expect(await mergeBlocker(git, base)).toBe("301 changed lines");
  }));
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

test("CI state treats missing CI, pending or failing checks and passes distinctly", () => {
  const run = (status: string, conclusion: string | null = null) => ({
    status,
    conclusion,
  });
  const none = { state: "pending", total_count: 0 };
  const cases: [
    ReturnType<typeof run>[],
    typeof none,
    ReturnType<typeof ciState>,
  ][] = [
    [[], none, "none"],
    [[run("in_progress")], none, "waiting"],
    [[run("completed", "failure")], none, "waiting"],
    [
      [run("completed", "neutral"), run("completed", "skipped")],
      none,
      "passed",
    ],
    [[run("completed", "success")], none, "passed"],
    [
      [run("completed", "success")],
      { state: "failure", total_count: 1 },
      "waiting",
    ],
    [[], { state: "failure", total_count: 1 }, "waiting"],
    [[], { state: "success", total_count: 1 }, "passed"],
  ];
  for (const [runs, status, state] of cases)
    expect(ciState(runs, status)).toBe(state);
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

test("merge action skips change requests and waits for passing CI on an up-to-date branch", () => {
  const cases: [
    Parameters<typeof mergeAction>[0],
    ReturnType<typeof mergeAction>["kind"],
  ][] = [
    [{ outstandingRequests: 1, ci: "passed", behindBy: 0 }, "skip"],
    [{ outstandingRequests: 1, ci: "none", behindBy: 2 }, "skip"],
    [{ outstandingRequests: 0, ci: "none", behindBy: 0 }, "no-ci"],
    [{ outstandingRequests: 0, ci: "none", behindBy: 2 }, "no-ci"],
    [{ outstandingRequests: 0, ci: "waiting", behindBy: 2 }, "waiting"],
    [{ outstandingRequests: 0, ci: "passed", behindBy: 2 }, "update-branch"],
    [{ outstandingRequests: 0, ci: "passed", behindBy: 0 }, "merge"],
  ];
  for (const [facts, kind] of cases) expect(mergeAction(facts).kind).toBe(kind);
});

test("merge facts count every change request and read every page of check runs", async () => {
  const pr: PullRequest = {
    number: 34,
    state: "open",
    body: "",
    html_url: "https://example.test/pr/34",
    head: { ref: "milo/issue-12", sha: "abc", repo: null },
    base: { ref: "main", sha: "base" },
  };
  const passed = { status: "completed", conclusion: "success" };
  let runs = Array(101).fill(passed);
  // Requests on older commits or from deleted accounts still hold the merge.
  let reviews: unknown[] = [
    {
      id: 1,
      state: "CHANGES_REQUESTED",
      commit_id: "old",
      user: null,
      body: "",
    },
  ];
  const gh: GitHubClient = {
    async api<T>(endpoint: string): Promise<T> {
      const responses: Record<string, unknown> = {
        "commits/abc/status": { state: "pending", total_count: 0 },
        "compare/main...abc": { behind_by: 3 },
      };
      return responses[endpoint] as T;
    },
    async pages<T>(endpoint: string, key?: string): Promise<T[]> {
      if (endpoint === "commits/abc/check-runs" && key === "check_runs")
        return runs as T[];
      return (endpoint === "pulls/34/reviews" ? reviews : []) as T[];
    },
    async comment() {},
    async viewer() {
      return "milo";
    },
  };
  expect(await mergeFacts(gh, pr)).toEqual({
    outstandingRequests: 1,
    ci: "passed",
    behindBy: 3,
  });
  // A failing run past the first page of 100 still blocks the merge.
  runs = [...runs, { ...passed, conclusion: "failure" }];
  reviews = [];
  expect(await mergeFacts(gh, pr)).toEqual({
    outstandingRequests: 0,
    ci: "waiting",
    behindBy: 3,
  });
});

test("review outcome fixes on a fix verdict and queues a merge only on an eligible two-way merge verdict with no blocker", async () => {
  const none = async () => undefined;
  const lines = async () => "400 changed lines";
  const review = (
    verdict: ReviewResult["verdict"],
    reversibility: ReviewResult["reversibility"] = "two-way",
  ): ReviewResult => ({
    verdict,
    reversibility,
    blastRadius: "Saved settings\nmore",
    body: "Report",
  });
  const cases: [
    ReviewResult,
    boolean,
    boolean,
    () => Promise<string | undefined>,
    "merge" | "fix" | undefined,
    string,
  ][] = [
    [review("merge"), true, true, none, "merge", "Auto-merge queued"],
    [review("merge"), true, true, lines, undefined, "(400 changed"],
    // A one-way door holds whatever the deterministic checks say.
    [
      review("merge", "one-way"),
      true,
      true,
      none,
      undefined,
      "(one-way door: Saved settings)",
    ],
    [review("hold"), true, true, none, undefined, "(review verdict)"],
    [
      review("hold", "one-way"),
      true,
      true,
      none,
      undefined,
      "(review verdict)",
    ],
    // Ineligible PRs never queue a merge, and say nothing about one.
    [review("merge"), false, true, none, undefined, ""],
    // Fixes apply to every Milo PR whatever the door, until its budget runs out.
    [review("fix"), false, true, none, "fix", "fixes these"],
    [review("fix", "one-way"), true, true, none, "fix", "fixes these"],
    [review("fix"), true, false, none, undefined, "a human must"],
  ];
  for (const [result, eligible, canFix, blocker, mark, note] of cases) {
    const outcome = await reviewOutcome(result, eligible, canFix, blocker);
    expect(outcome.mark).toBe(mark);
    expect(outcome.note).toContain(note);
  }
  // Only an eligible two-way merge verdict runs the deterministic checks.
  const blocker = () => {
    throw new Error("blocker ran");
  };
  await reviewOutcome(review("hold"), true, true, blocker);
  await reviewOutcome(review("fix"), true, true, blocker);
  await reviewOutcome(review("merge"), false, true, blocker);
  await reviewOutcome(review("merge", "one-way"), true, true, blocker);
  // A result missing reversibility fails validation, so no verdict can merge it.
  const { reversibility: _, ...missing } = review("merge");
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
  const found = { title: "Patch hono", body: "Reproduced", ready: false };
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
