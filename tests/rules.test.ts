import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import type { Issue, PullRequest, Review } from "../src/github.ts";
import { command, temporary } from "../src/process.ts";
import {
  ciState,
  failed,
  failedStamp,
  finding,
  issueCategory,
  latestRequests,
  mergeApproved,
  mergeBlocker,
  nextReviewStep,
  reviewed,
  reviewStamp,
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
test("scan reports become a titled finding or nothing", () => {
  expect(finding("Looked everywhere.\nVerdict: clean")).toBeUndefined();
  expect(finding("**Title:** Bump hono\n\nEvidence: package.json:3")).toEqual({
    title: "Bump hono",
    body: "Evidence: package.json:3",
  });
  for (const clean of [
    "Done.\n`Verdict: clean`",
    "**Verdict:** clean.",
    "## Verdict: clean",
  ])
    expect(finding(clean)).toBeUndefined();
  expect(
    finding(
      "I measured the routes.\n\n## Title: Index `created_at`\nBaseline: 2s",
    ),
  ).toEqual({ title: "Index `created_at`", body: "Baseline: 2s" });
  expect(() => finding("Some rambling report")).toThrow("verdict");
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
  expect(reviewed(`${reviewStamp("abc", true)}\n\nreport`, "abc")).toBeTrue();
  expect(reviewed(`quoted ${reviewStamp("abc")}`, "abc")).toBeFalse();
  expect(reviewed(reviewStamp("abc"), "ab")).toBeFalse();
  expect(reviewed(reviewStamp("abc"), "abcd")).toBeFalse();
  expect(mergeApproved(reviewStamp("abc", true), "abc")).toBeTrue();
  expect(mergeApproved(reviewStamp("abc"), "abc")).toBeFalse();
  expect(mergeApproved(reviewStamp("abc", true), "def")).toBeFalse();
  expect(mergeApproved(`x${reviewStamp("abc", true)}`, "abc")).toBeFalse();
  expect(failed(failedStamp("abc", [request]), "abc", [request])).toBeTrue();
  expect(failed(failedStamp("abc", []), "abc", [request])).toBeFalse();
  expect(failed(failedStamp("abc", [request]), "abc", [])).toBeFalse();
  expect(failed(failedStamp("abc", []), "def", [])).toBeFalse();
  expect(failed(` ${failedStamp("abc", [])}`, "abc", [])).toBeFalse();
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
    [[request], [reviewStamp("abc", true)], "revise"],
    // An already-failed revision falls through to the remaining stamps.
    [[request], [failedStamp("abc", [request])], "review"],
    [
      [request],
      [failedStamp("abc", [request]), reviewStamp("abc", true)],
      "merge",
    ],
    [[], [reviewStamp("abc", true)], "merge"],
    [[], [reviewStamp("abc")], "skip"],
    [[], [reviewStamp("old", true)], "review"],
    [[], [failedStamp("abc", [])], "skip"],
    [[], [failedStamp("old", [])], "review"],
    [[], [], "review"],
  ];
  for (const [requests, comments, step] of cases)
    expect(nextReviewStep("abc", requests, comments)).toBe(step);
});
