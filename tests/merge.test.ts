import { expect, test } from "bun:test";
import { join } from "node:path";
import type { GitHubClient, PullRequest } from "../src/github.ts";
import { mergeDecision, reviewMark } from "../src/merge.ts";
import { command, temporary } from "../src/process.ts";
import type { ReviewResult } from "../src/rules.ts";
import type { Git } from "../src/workspace.ts";
import { github as stub } from "./helpers.ts";

const pr: PullRequest = {
  number: 34,
  state: "open",
  body: "",
  html_url: "https://example.test/pr/34",
  head: { ref: "milo/issue-12", sha: "abc", repo: null },
  base: { ref: "main", sha: "base" },
};
type Run = { status: string; conclusion: string | null };
const run = (status: string, conclusion: string | null = null): Run => ({
  status,
  conclusion,
});
const passed = run("completed", "success");
const noStatus = { state: "pending", total_count: 0 };
const request = {
  id: 1,
  state: "CHANGES_REQUESTED",
  commit_id: "abc",
  user: { login: "owner" },
  body: "",
};
function github({
  reviews = [] as unknown[],
  runs = [] as Run[],
  status = noStatus,
  behindBy = 0,
}): GitHubClient {
  return stub({
    async api<T>(endpoint: string): Promise<T> {
      const responses: Record<string, unknown> = {
        "commits/abc/status": status,
        "compare/main...abc": { behind_by: behindBy },
      };
      return responses[endpoint] as T;
    },
    async pages<T>(endpoint: string, key?: string): Promise<T[]> {
      if (endpoint === "commits/abc/check-runs" && key === "check_runs")
        return runs as T[];
      return (endpoint === "pulls/34/reviews" ? reviews : []) as T[];
    },
    async comment() {},
  });
}
type Kind = Awaited<ReturnType<typeof mergeDecision>>["kind"];
const decide = async (facts: Parameters<typeof github>[0]) =>
  (await mergeDecision(github(facts), pr)).kind;

test("merge decision skips change requests and waits for passing CI on an up-to-date branch", async () => {
  const cases: [Parameters<typeof github>[0], Kind][] = [
    [{ reviews: [request], runs: [passed] }, "skip"],
    [{ reviews: [request], behindBy: 2 }, "skip"],
    // A later approval by the same reviewer clears the request.
    [
      {
        reviews: [request, { ...request, id: 2, state: "APPROVED" }],
        runs: [passed],
      },
      "merge",
    ],
    [{}, "no-ci"],
    [{ behindBy: 2 }, "no-ci"],
    [{ runs: [run("in_progress")], behindBy: 2 }, "waiting"],
    [{ runs: [passed], behindBy: 2 }, "update-branch"],
    [{ runs: [passed] }, "merge"],
  ];
  for (const [facts, kind] of cases) expect(await decide(facts)).toBe(kind);
});

test("merge decision treats missing CI, pending or failing checks and passes distinctly", async () => {
  const cases: [Run[], typeof noStatus, Kind][] = [
    [[], noStatus, "no-ci"],
    [[run("in_progress")], noStatus, "waiting"],
    // Failed CI waits too: a rerun or new commit can still pass.
    [[run("completed", "failure")], noStatus, "waiting"],
    [
      [run("completed", "neutral"), run("completed", "skipped")],
      noStatus,
      "merge",
    ],
    [[passed], { state: "failure", total_count: 1 }, "waiting"],
    [[], { state: "failure", total_count: 1 }, "waiting"],
    [[], { state: "success", total_count: 1 }, "merge"],
  ];
  for (const [runs, status, kind] of cases)
    expect(await decide({ runs, status })).toBe(kind);
});

test("merge decision counts every change request and reads every page of check runs", async () => {
  const runs = Array(101).fill(passed);
  // Requests on older commits or from deleted accounts still hold the merge.
  const stale = { ...request, commit_id: "old", user: null };
  expect(await decide({ reviews: [stale], runs })).toBe("skip");
  expect(await decide({ runs, behindBy: 3 })).toBe("update-branch");
  // A failing run past the first page of 100 still blocks the merge.
  expect(
    await decide({ runs: [...runs, run("completed", "failure")], behindBy: 3 }),
  ).toBe("waiting");
});

const review = (
  verdict: ReviewResult["verdict"],
  reversibility: ReviewResult["reversibility"] = "two-way",
): ReviewResult => ({
  verdict,
  reversibility,
  blastRadius: "Saved settings\nmore",
  body: "Report",
});
// Answers mergeBlocker's merge-base and numstat calls with one changed file.
const diffOf =
  (numstat: string): Git =>
  async (subcommand) =>
    subcommand === "merge-base" ? "base" : numstat;

test("review mark fixes on a fix verdict and queues a merge only on an eligible two-way merge verdict with no blocker", async () => {
  const none = diffOf("1\t0\tsrc/a.ts");
  const lines = diffOf("400\t0\tsrc/a.ts");
  const cases: [
    ReviewResult,
    boolean,
    boolean,
    Git,
    "merge" | "fix" | undefined,
    string,
  ][] = [
    [review("merge"), true, true, none, "merge", "Auto-merge queued"],
    [review("merge"), true, true, lines, undefined, "(400 changed lines)"],
    // A one-way door holds whatever the deterministic checks say.
    [
      review("merge", "one-way"),
      true,
      true,
      none,
      undefined,
      "(one-way door; if this is wrong: Saved settings)",
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
  for (const [result, eligible, canFix, git, mark, note] of cases) {
    const outcome = await reviewMark(result, {
      eligible,
      canFix,
      git,
      base: "base",
    });
    expect(outcome.mark).toBe(mark);
    expect(outcome.note).toContain(note);
  }
});

test("review mark runs the deterministic checks only for an eligible two-way merge verdict", async () => {
  const git: Git = async () => {
    throw new Error("blocker ran");
  };
  const mark = (result: ReviewResult, eligible = true) =>
    reviewMark(result, { eligible, canFix: true, git, base: "base" });
  await mark(review("hold"));
  await mark(review("fix"));
  await mark(review("merge"), false);
  await mark(review("merge", "one-way"));
  await expect(mark(review("merge"))).rejects.toThrow("blocker ran");
});

test("auto-merge blocks majors, dependency changes and large diffs", () =>
  temporary("milo-merge-", async (root) => {
    const git = (...args: string[]) => command(["git", ...args], { cwd: root });
    const held = async (base: string) =>
      (
        await reviewMark(review("merge"), {
          eligible: true,
          canFix: true,
          git,
          base,
        })
      ).note;
    const queued = "Auto-merge queued";
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
    expect(await held(base)).toContain(queued);
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
      expect(await held(base)).toContain(reason);
    }
    for (const text of ["{", '{"dependencies":[]}']) {
      await git("checkout", "-q", "--detach", base);
      await Bun.write(join(root, "package.json"), text);
      const broken = await commit();
      expect(await held(base)).toContain("(package.json unreadable)");
      await manifest({ hono: "^4.1.0", tiny: "0.3.1", exact: "1.0.1" });
      await commit();
      expect(await held(broken)).toContain("(package.json unreadable)");
    }
    await git("checkout", "-q", "--detach", base);
    await Bun.write(join(root, "big.ts"), "x\n".repeat(300));
    await commit();
    expect(await held(base)).toContain(queued);
    await git("checkout", "-q", "--detach", base);
    await Bun.write(join(root, "big.ts"), "x\n".repeat(301));
    await commit();
    expect(await held(base)).toContain("(301 changed lines)");
  }));
