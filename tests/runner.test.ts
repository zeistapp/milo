import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config, Repo } from "../src/config.ts";
import { command, temporary } from "../src/process.ts";
import {
  changes,
  type GitHubClient,
  type Issue,
  latestRequests,
  mergeBlocker,
  type PullRequest,
  type Review,
  Runner,
  ticketSpecs,
  validateIssue,
  validatePR,
} from "../src/runner.ts";

function issue(body = "", state = "open"): Issue {
  return {
    number: 12,
    title: "Maintenance",
    body,
    state,
    html_url: "https://example.test/issue/12",
    labels: [{ name: "milo:task" }, { name: "milo:ready" }],
  };
}
test("weekly tickets deduplicate completed and outstanding work", () => {
  const repo: Repo = { name: "owner/repo", categories: ["cleanup"] };
  const date = new Date("2026-10-14T00:00:00Z");
  expect(ticketSpecs(repo, [], date)[0]?.labels).toEqual([
    "milo:task",
    "milo:cleanup",
  ]);
  expect(
    ticketSpecs(repo, [issue("<!-- milo:cleanup:2025-W01 -->")], date),
  ).toEqual([]);
  expect(
    ticketSpecs(
      repo,
      [issue("<!-- milo:cleanup:2026-W42 -->", "closed")],
      date,
    ),
  ).toEqual([]);
  expect(
    ticketSpecs(
      repo,
      [issue("<!-- milo:cleanup:2026-W41 -->", "closed")],
      date,
    ),
  ).toHaveLength(1);
  expect(ticketSpecs(repo, [], new Date("2021-01-01"))[0]?.body).toContain(
    "2020-W53",
  );
  expect(
    ticketSpecs({ ...repo, autoReady: ["cleanup"] }, [], date)[0]?.labels,
  ).toContain("milo:ready");
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
test("child processes lose GitHub credentials and time out", async () => {
  const previous = process.env.GH_TOKEN;
  const previousAgent = process.env.CODEX_API_KEY;
  process.env.GH_TOKEN = "test-secret";
  process.env.CODEX_API_KEY = "test-agent-secret";
  try {
    const output = await command(
      [
        process.execPath,
        "-e",
        "console.log(JSON.stringify({token:process.env.GH_TOKEN,helper:process.env.GIT_CONFIG_VALUE_0}))",
      ],
      { trusted: false },
    );
    expect(JSON.parse(output)).toEqual({ helper: "" });
    expect(
      await command(
        [
          process.execPath,
          "-e",
          "console.log(process.env.CODEX_API_KEY ?? 'absent')",
        ],
        { trusted: false },
      ),
    ).toBe("absent");
    expect(
      await command(
        [
          process.execPath,
          "-e",
          "console.log(process.env.CODEX_API_KEY ?? 'absent')",
        ],
        { trusted: false, keepAgentCredentials: true },
      ),
    ).toBe("test-agent-secret");
  } finally {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
    if (previousAgent === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previousAgent;
  }
  await expect(
    command([process.execPath, "-e", "await Bun.sleep(10000)"], {
      timeoutSeconds: 0.05,
    }),
  ).rejects.toThrow("Timed out");
  await expect(
    command([
      process.execPath,
      "-e",
      "console.log('private-value');process.exit(1)",
    ]),
  ).rejects.not.toThrow("private-value");
});

test(
  "real git and subprocess flow: ticket, PR, review, revision and retry deduplication",
  () =>
    temporary("milo-flow-", async (folder) => {
      const source = join(folder, "source");
      await mkdir(source);
      const git = (root: string, ...args: string[]) =>
        command(["git", ...args], { cwd: root });
      await git(source, "init", "-q", "-b", "main");
      await git(source, "config", "user.name", "Test");
      await git(source, "config", "user.email", "test@example.test");
      await Bun.write(join(source, "file.txt"), "old\n");
      await Bun.write(
        join(source, "package.json"),
        JSON.stringify({
          dependencies: { hono: "latest" },
          scripts: { test: "bun test" },
        }),
      );
      await git(source, "add", ".");
      await git(source, "commit", "-qm", "Initial");
      const base = await git(source, "rev-parse", "HEAD");
      const remote = join(folder, "remote.git");
      await git(source, "clone", "--bare", source, remote);
      const head = () => git(remote, "rev-parse", "refs/heads/milo/issue-12");
      const fakeAgent = join(folder, "agent.ts");
      const invocations = join(folder, "invocations.txt");
      await Bun.write(
        fakeAgent,
        `const prompt = await Bun.stdin.text();
const counter = Bun.file(${JSON.stringify(invocations)});
await Bun.write(counter, String((await counter.exists() ? Number(await counter.text()) : 0) + 1));
if (prompt.includes("Implement this ticket:")) await Bun.write("file.txt", "new\\n");
if (prompt.includes("Address these review requests")) await Bun.write("file.txt", "reviewed\\n");
await Bun.write(Bun.argv[2]!, "Report with evidence");`,
      );
      const config: Config = {
        agent: { command: [process.execPath, fakeAgent, "{output}"] },
        repos: [],
      };
      const repo: Repo = {
        name: "owner/repo",
        setup: [],
        checks: [
          {
            command: [
              process.execPath,
              "-e",
              "if(!await Bun.file('file.txt').exists())process.exit(1)",
            ],
          },
        ],
      };
      const comments: { body: string; user: { login: string } }[] = [];
      const reviews: Review[] = [];
      const prs: PullRequest[] = [];
      const gh: GitHubClient = {
        async api<T>(
          endpoint: string,
          method = "GET",
          payload?: unknown,
        ): Promise<T> {
          let result: unknown;
          if (endpoint === "issues/12") result = issue();
          else if (endpoint === "issues/13")
            result = { ...issue(), number: 13 };
          else if (endpoint === "issues/13/labels") result = {};
          else if (endpoint === "pulls" && method === "POST") {
            const body = payload as { body: string };
            const sha = await head();
            const pr: PullRequest = {
              number: 34,
              state: "open",
              body: body.body,
              html_url: "https://example.test/pr/34",
              head: {
                ref: "milo/issue-12",
                sha,
                repo: { full_name: "owner/repo" },
              },
              base: { ref: "main", sha: base },
            };
            prs.push(pr);
            await git(remote, "update-ref", "refs/pull/34/head", sha);
            result = pr;
          } else if (endpoint === "pulls/34") {
            const current = prs[0];
            assert(current);
            result = {
              ...current,
              head: { ...current.head, sha: await head() },
            };
          } else if (endpoint === "collaborators/owner/permission")
            result = { permission: "admin" };
          else throw new Error(`Unexpected endpoint: ${endpoint}`);
          return result as T;
        },
        async pages<T>(endpoint: string): Promise<T[]> {
          let result: unknown[];
          if (endpoint.startsWith("pulls?")) result = prs;
          else if (endpoint === "issues/34/comments") result = comments;
          else if (endpoint === "pulls/34/reviews") result = reviews;
          else if (endpoint === "pulls/34/comments") result = [];
          else throw new Error(`Unexpected collection: ${endpoint}`);
          return result as T[];
        },
        async comment(_number, body) {
          comments.push({ body, user: { login: "milo-bot" } });
        },
        async viewer() {
          return "milo-bot";
        },
      };
      const runner = new Runner(
        config,
        () => gh,
        async (_repo, root) => {
          await git(source, "clone", remote, root);
          await git(root, "config", "user.name", "Test");
          await git(root, "config", "user.email", "test@example.test");
        },
      );
      await runner.work(repo, 12);
      expect(await git(remote, "show", "milo/issue-12:file.txt")).toBe("new");
      expect(prs[0]?.body).toContain("Closes #12");
      const originalHead = await head();
      await runner.work(repo, 12);
      expect(await head()).toBe(originalHead);
      // An untrusted commenter cannot spoof a completed bot review.
      comments.push({
        body: `<!-- milo:review:${originalHead} -->`,
        user: { login: "stranger" },
      });
      await runner.review(repo, 34);
      expect(
        comments.some((comment) => comment.body.includes("Automated review")),
      ).toBeTrue();
      const count = comments.length;
      await runner.review(repo, 34);
      expect(comments).toHaveLength(count);
      reviews.push({
        id: 1,
        state: "CHANGES_REQUESTED",
        commit_id: await head(),
        user: { login: "owner" },
        body: "Improve fix",
      });
      await runner.review(repo, 34, true);
      expect(await git(remote, "show", "milo/issue-12:file.txt")).toBe(
        "reviewed",
      );
      const revisedHead = await head();
      await runner.review(repo, 34, true);
      expect(await head()).toBe(revisedHead);
      await Bun.write(join(source, "AGENTS.md"), "changed policy");
      await expect(changes(source)).rejects.toThrow("protected");
      const calls = await Bun.file(invocations).text();
      prs.length = 0;
      await expect(
        runner.work(
          {
            ...repo,
            checks: [{ command: [process.execPath, "-e", "process.exit(1)"] }],
          },
          13,
        ),
      ).rejects.toThrow("failed");
      expect(await Bun.file(invocations).text()).toBe(calls);
    }),
  15_000,
);

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
    expect(await mergeBlocker(root, base)).toBeUndefined();
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
      expect(await mergeBlocker(root, base)).toContain(reason);
    }
    await git("checkout", "-q", "--detach", base);
    await Bun.write(join(root, "big.ts"), "x\n".repeat(301));
    await commit();
    expect(await mergeBlocker(root, base)).toBe("301 changed lines");
  }));
test("auto-merge waits for CI, refreshes stale branches and respects change requests", async () => {
  const repo: Repo = {
    name: "owner/repo",
    categories: ["dependencies"],
    autoMerge: ["dependencies"],
  };
  const pr: PullRequest = {
    number: 34,
    state: "open",
    body: "",
    html_url: "https://example.test/pr/34",
    head: {
      ref: "milo/issue-12",
      sha: "abc",
      repo: { full_name: "owner/repo" },
    },
    base: { ref: "main", sha: "base" },
  };
  let runs = [{ status: "in_progress", conclusion: null as string | null }];
  let behind = 0;
  let reviews: Review[] = [];
  let comment = "<!-- milo:review:abc --><!-- milo:merge -->\n\nreport";
  const writes: string[] = [];
  const gh: GitHubClient = {
    async api<T>(endpoint: string, method = "GET"): Promise<T> {
      if (method !== "GET") writes.push(endpoint);
      const responses: Record<string, unknown> = {
        "issues/12": { ...issue(), labels: [{ name: "milo:dependencies" }] },
        "commits/abc/check-runs?per_page=100": { check_runs: runs },
        "commits/abc/status": { state: "pending", total_count: 0 },
        "compare/main...abc": { behind_by: behind },
      };
      return (responses[endpoint] ?? {}) as T;
    },
    async pages<T>(endpoint: string): Promise<T[]> {
      const responses: Record<string, unknown[]> = {
        "pulls?state=open": [pr],
        "pulls/34/reviews": reviews,
        "issues/34/comments": [{ body: comment, user: { login: "milo" } }],
      };
      return (responses[endpoint] ?? []) as T[];
    },
    async comment() {},
    async viewer() {
      return "milo";
    },
  };
  const runner = new Runner(
    { agent: { command: ["agent", "{output}"] }, repos: [] },
    () => gh,
  );
  await runner.runReviews(repo);
  expect(writes).toEqual([]);
  runs = [{ status: "completed", conclusion: "success" }];
  behind = 2;
  await runner.runReviews(repo);
  expect(writes).toEqual(["pulls/34/update-branch"]);
  behind = 0;
  reviews = [
    {
      id: 1,
      state: "CHANGES_REQUESTED",
      commit_id: "old",
      user: { login: "owner" },
      body: "",
    },
  ];
  await runner.runReviews(repo);
  expect(writes).toHaveLength(1);
  reviews = [];
  await runner.runReviews({ ...repo, autoMerge: [] });
  expect(writes).toHaveLength(1);
  comment = "<!-- milo:review:abc -->\n\n<!-- milo:merge -->";
  await runner.runReviews(repo);
  expect(writes).toHaveLength(1);
  comment = "<!-- milo:review:abc --><!-- milo:merge -->";
  await runner.runReviews(repo);
  expect(writes).toEqual(["pulls/34/update-branch", "pulls/34/merge"]);
});
