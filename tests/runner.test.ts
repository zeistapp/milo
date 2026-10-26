import { expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Argv, Config, Repo } from "../src/config.ts";
import type {
  GitHubClient,
  Issue,
  PullRequest,
  Review,
} from "../src/github.ts";
import {
  type CommandOptions,
  command,
  confine,
  sandboxEnv,
  sandboxed,
  temporary,
} from "../src/process.ts";
import { periodKey, reviewStamp } from "../src/rules.ts";
import { Runner } from "../src/runner.ts";

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
test("scans open one finding per category and period, and skip clean or outstanding ones", () =>
  temporary("milo-scan-", async (folder) => {
    const fakeAgent = join(folder, "agent.ts");
    const calls = join(folder, "calls.txt");
    await Bun.write(
      fakeAgent,
      `const prompt = await Bun.stdin.text();
const log = Bun.file(${JSON.stringify(calls)});
await Bun.write(log, (await log.exists() ? await log.text() : "") + "x");
await Bun.write(Bun.argv[2]!, prompt.includes("for security work") ? "Title: Patch hono\\nEvidence" : "Verdict: clean");`,
    );
    const labels = new Map<string, string | null>();
    const open: Issue[] = [];
    const writes: [string, string, unknown][] = [];
    const gh: GitHubClient = {
      async api<T>(endpoint: string, method = "GET", payload?: unknown) {
        writes.push([method, endpoint, payload]);
        const body = payload as { name?: string; description?: string };
        if (endpoint === "labels" && body.name) labels.set(body.name, null);
        if (method === "PATCH")
          labels.set(
            decodeURIComponent(endpoint.slice(7)),
            body.description ?? null,
          );
        return { html_url: "https://example.test/issue/1" } as T;
      },
      async pages<T>(endpoint: string): Promise<T[]> {
        if (endpoint === "labels")
          return [...labels].map(([name, description]) => ({
            name,
            description,
          })) as T[];
        return open as T[];
      },
      async comment() {},
      async viewer() {
        return "bot";
      },
    };
    const runner = new Runner(
      {
        agent: { command: [process.execPath, fakeAgent, "{output}"] },
        repos: [],
      },
      () => gh,
      async (_repo, root) => {
        await mkdir(root);
        const git = (...args: string[]) =>
          command(["git", ...args], { cwd: root });
        await git("init", "-q");
        await git("config", "user.name", "Test");
        await git("config", "user.email", "test@example.test");
        await Bun.write(join(root, "package.json"), "{}");
        await git("add", ".");
        await git("commit", "-qm", "Initial");
      },
    );
    const repo: Repo = {
      name: "owner/repo",
      categories: ["security", "simplify"],
      autoReady: ["security"],
      setup: [],
      checks: [{ command: ["true"] }],
    };
    await runner.plan(repo, false, "day");
    expect(writes).toEqual([]);
    await runner.plan(repo, true, "day");
    const issues = writes.filter(([, endpoint]) => endpoint === "issues");
    expect(issues).toHaveLength(1);
    const ticket = issues[0]?.[2] as {
      title: string;
      body: string;
      labels: string[];
    };
    expect(ticket.title).toBe("Patch hono");
    expect(ticket.labels).toEqual(["milo:task", "milo:security", "milo:ready"]);
    expect(ticket.body).toContain(`<!-- milo:security:${periodKey("day")} -->`);
    expect(labels.get("milo:simplify")).toBe(
      `Milo scanned ${periodKey("day")}`,
    );
    // Repeat runs in the same period, and categories with an open ticket, call no agent.
    let count = (await Bun.file(calls).text()).length;
    await runner.plan(repo, true, "day");
    expect((await Bun.file(calls).text()).length).toBe(count);
    // Anyone can file an issue with a body marker, so it does not skip a scan.
    labels.set("milo:security", null);
    open.push(issue("<!-- milo:security:x -->"));
    await runner.plan(repo, true, "day");
    expect((await Bun.file(calls).text()).length).toBeGreaterThan(count);
    count = (await Bun.file(calls).text()).length;
    labels.set("milo:security", null);
    open.push({ ...issue(), labels: [{ name: "milo:security" }] });
    await runner.plan(repo, true, "day");
    expect((await Bun.file(calls).text()).length).toBe(count);
  }));
test("malformed GitHub responses fail before Milo acts on them", async () => {
  const gh: GitHubClient = {
    async api() {
      return { ...issue(), labels: "milo:ready" };
    },
    async pages() {
      return [];
    },
    async comment() {
      throw new Error("Unexpected comment");
    },
    async viewer() {
      return "bot";
    },
  };
  const runner = new Runner(
    { agent: { command: ["agent", "{output}"] }, repos: [] },
    () => gh,
    async () => {
      throw new Error("Unexpected clone");
    },
  );
  await expect(runner.work({ name: "owner/repo" }, 12)).rejects.toThrow(
    "at labels",
  );
});
test("only tickets written by Milo or a repository writer run", async () => {
  const permissions: Record<string, string> = {
    owner: "write",
    stranger: "read",
  };
  const tickets = [
    { ...issue(), number: 1, user: { login: "stranger" } },
    { ...issue(), number: 2, user: null },
    { ...issue(), number: 3, user: { login: "owner" } },
    { ...issue(), number: 4 },
  ];
  const gh: GitHubClient = {
    async api<T>(endpoint: string): Promise<T> {
      const login = /^collaborators\/(.+)\/permission$/.exec(endpoint)?.[1];
      if (login) return { permission: permissions[login] } as T;
      const ticket = tickets.find(
        (item) => endpoint === `issues/${item.number}`,
      );
      if (ticket) return ticket as T;
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
    async pages<T>(endpoint: string): Promise<T[]> {
      return (endpoint.startsWith("issues?") ? tickets : []) as T[];
    },
    async comment() {
      throw new Error("Unexpected comment");
    },
    async viewer() {
      return "milo";
    },
  };
  const runner = new Runner(
    { agent: { command: ["agent", "{output}"] }, repos: [] },
    () => gh,
    async () => {
      throw new Error("Unexpected clone");
    },
  );
  const repo = { name: "owner/repo" };
  for (const number of [1, 2])
    await expect(runner.work(repo, number)).rejects.toThrow(
      "Ticket must be written by Milo or a repository writer",
    );
  const plan = spyOn(runner, "plan").mockResolvedValue(undefined);
  const work = spyOn(runner, "work").mockResolvedValue(undefined);
  try {
    await runner.runTasks(repo);
    expect(work).toHaveBeenCalledWith(repo, 3, undefined);
    tickets.splice(2, 1);
    await runner.runTasks(repo);
    expect(work).toHaveBeenLastCalledWith(repo, 4, undefined);
    expect(work).toHaveBeenCalledTimes(2);
  } finally {
    plan.mockRestore();
    work.mockRestore();
  }
});
test("child processes lose GitHub credentials and time out", async () => {
  const github = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
  ];
  const agent = [
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AZURE_OPENAI_API_KEY",
  ];
  const git = [
    "GIT_TERMINAL_PROMPT",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
  ];
  const visible = async (options: CommandOptions) =>
    JSON.parse(
      await command(
        [
          process.execPath,
          "-e",
          `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify([...github, ...agent, ...git])}.filter((key) => key in process.env).map((key) => [key, process.env[key]]))))`,
        ],
        options,
      ),
    );
  const previous = Object.fromEntries(
    [...github, ...agent].map((key) => [key, process.env[key]]),
  );
  const gitPrompt = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
  };
  try {
    for (const key of [...github, ...agent]) process.env[key] = `${key}-secret`;
    expect(await visible({ trusted: false })).toEqual(gitPrompt);
    expect(
      await visible({ trusted: false, keepAgentCredentials: true }),
    ).toEqual({
      ...Object.fromEntries(agent.map((key) => [key, `${key}-secret`])),
      ...gitPrompt,
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

test("sandboxed steps keep their output in MILO_LOG_DIR for the failure artifact", () =>
  temporary("milo-logs-", async (temp) => {
    const folder = await realpath(temp);
    const logs = join(folder, "logs");
    process.env.MILO_LOG_DIR = logs;
    try {
      await expect(
        sandboxed(
          {
            command: [
              process.execPath,
              "-e",
              "console.error('why it broke');process.exit(1)",
            ],
          },
          folder,
          folder,
        ),
      ).rejects.toThrow("failed (exit 1)");
    } finally {
      delete process.env.MILO_LOG_DIR;
    }
    const [log] = [...new Bun.Glob("*.log").scanSync(logs)];
    assert(log);
    expect(await Bun.file(join(logs, log)).text()).toContain("why it broke");
  }));
test("untrusted steps cannot read Milo's token or write outside the clone", () =>
  temporary("milo-confine-", async (temp) => {
    const folder = await realpath(temp);
    const root = join(folder, "repo");
    const home = join(folder, "home");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(home);
    const probe = join(home, "probe.ts");
    const outside = join(folder, "outside");
    // Milo's own home holds credentials the step must not read.
    const realHome = join(folder, "real-home");
    const secrets = [".ssh", ".aws", ".config/gh", ".codex", ".claude"].map(
      (dir) => join(realHome, dir, "secret"),
    );
    for (const secret of secrets) await Bun.write(secret, "x");
    await Bun.write(
      probe,
      `import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
let leaked = false;
if (process.platform === "linux")
  for (const pid of readdirSync("/proc"))
    try { leaked ||= readFileSync(\`/proc/\${pid}/environ\`, "utf8").includes("test-secret"); } catch {}
else
  try { leaked = Bun.spawnSync(["ps", "eww", "-A"]).stdout.toString().includes("test-secret"); } catch {}
for (const path of ["file", ".git/config", ${JSON.stringify(outside)}])
  try { writeFileSync(path, "x"); } catch {}
let xdg = false;
try { mkdirSync(\`\${process.env.XDG_CONFIG_HOME}/astro\`, { recursive: true }); xdg = true; } catch {}
const readable = ${JSON.stringify(secrets)}.filter((path) => { try { return readFileSync(path, "utf8") === "x"; } catch { return false; } });
console.log(JSON.stringify({ leaked, home: process.env.HOME, xdg, readable }));`,
    );
    // A stand-in for Milo: the token sits in its initial environment, as in the workflow.
    const milo = `import { command, confine, sandboxEnv } from ${JSON.stringify(join(import.meta.dir, "../src/process.ts"))};
console.log(await command(confine([process.execPath, ${JSON.stringify(probe)}], ${JSON.stringify(root)}, ${JSON.stringify(home)}, ${JSON.stringify(root)}),
  { cwd: ${JSON.stringify(root)}, trusted: false, env: sandboxEnv(${JSON.stringify(home)}) }));`;
    // Like a GitHub runner, Milo's XDG config path is outside anything the sandbox may write.
    const config = join(folder, "real-config");
    const output = await command([process.execPath, "-e", milo], {
      env: { GH_TOKEN: "test-secret", XDG_CONFIG_HOME: config, HOME: realHome },
    });
    expect(JSON.parse(output)).toEqual({
      leaked: false,
      home,
      xdg: true,
      readable: [],
    });
    expect(existsSync(config)).toBeFalse();
    // Judge writes from outside the sandbox: on Linux a write to /tmp lands in the sandbox's own copy.
    expect(await Bun.file(join(root, "file")).exists()).toBeTrue();
    expect(await Bun.file(join(root, ".git/config")).exists()).toBeFalse();
    expect(await Bun.file(outside).exists()).toBeFalse();
  }));

// zeist's tests build sites under their own bubblewrap, which must start inside Milo's.
test.if(process.platform === "linux")(
  "untrusted steps can start a nested bubblewrap sandbox",
  () =>
    temporary("milo-nested-", async (temp) => {
      const root = join(await realpath(temp), "repo");
      const home = join(await realpath(temp), "home");
      await mkdir(join(root, ".git"), { recursive: true });
      await mkdir(home);
      // The same namespaces and mounts as zeist's lab/sandbox.ts.
      const inner: Argv = [
        "bwrap",
        "--unshare-all",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "true",
      ];
      await command(confine(inner, root, home, root), {
        cwd: root,
        trusted: false,
        env: sandboxEnv(home),
      });
    }),
);

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
      const reviewPrompt = join(folder, "review-prompt.txt");
      const workPrompt = join(folder, "work-prompt.txt");
      await Bun.write(
        fakeAgent,
        `const prompt = await Bun.stdin.text();
const counter = Bun.file(${JSON.stringify(invocations)});
await Bun.write(counter, String((await counter.exists() ? Number(await counter.text()) : 0) + 1));
if (prompt.includes("Implement this ticket:")) {
  await Bun.write(${JSON.stringify(workPrompt)}, prompt);
  if (!prompt.includes("stale")) await Bun.write("file.txt", "new\\n");
}
if (prompt.includes("Address these review requests")) await Bun.write("file.txt", "reviewed\\n");
if (prompt.includes("Review the diff")) await Bun.write(${JSON.stringify(reviewPrompt)}, prompt);
await Bun.write(Bun.argv[2]!, "Report with evidence\\nverdict: merge");`,
      );
      const config: Config = {
        agent: { command: [process.execPath, fakeAgent, "{output}"] },
        repos: [],
      };
      const repo: Repo = {
        name: "owner/repo",
        autoMerge: ["dependencies"],
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
      const closed: unknown[] = [];
      const reviews: Review[] = [];
      const prs: PullRequest[] = [];
      let ticketReads = 0;
      const gh: GitHubClient = {
        async api<T>(
          endpoint: string,
          method = "GET",
          payload?: unknown,
        ): Promise<T> {
          let result: unknown;
          if (endpoint === "issues/15" && method === "PATCH")
            closed.push(payload);
          else if (endpoint === "issues/12")
            result = {
              ...issue("<!-- milo:dependencies:key -->"),
              labels: [...issue().labels, { name: "milo:dependencies" }],
            };
          else if (endpoint === "issues/13")
            result = { ...issue(), number: 13 };
          else if (endpoint === "issues/14")
            result = { ...issue(`edit ${++ticketReads}`), number: 14 };
          else if (endpoint === "issues/15")
            result = { ...issue("stale"), number: 15 };
          else if (endpoint.match(/^issues\/1[34]\/labels$/)) result = {};
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
          comments.push({ body, user: { login: "milo" } });
        },
        async viewer() {
          return "milo";
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
      // The agent checks the ticket against what changed since it was written.
      const prompt = await Bun.file(workPrompt).text();
      expect(prompt).toContain("git log --since=2026-10-15T09:00:00Z");
      expect(prompt).toContain("If the evidence or plan no longer holds");
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
        comments.some(
          (comment) =>
            comment.body.startsWith(
              `<!-- milo:review:${originalHead} --><!-- milo:merge -->`,
            ) && comment.body.includes("Automated review"),
        ),
      ).toBeTrue();
      // The reviewer judges scope against the approved ticket, not the PR description.
      expect(await Bun.file(reviewPrompt).text()).toContain(
        "<!-- milo:dependencies:key -->",
      );
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
      await runner.revise(repo, 34);
      expect(await git(remote, "show", "milo/issue-12:file.txt")).toBe(
        "reviewed",
      );
      const revisedHead = await head();
      await runner.revise(repo, 34);
      expect(await head()).toBe(revisedHead);
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
      ).rejects.toThrow(`.: ${process.execPath} -e process.exit(1) failed`);
      expect(await Bun.file(invocations).text()).toBe(calls);
      // An edit during the run stops it before anything is pushed.
      await expect(runner.work(repo, 14)).rejects.toThrow("Ticket changed");
      expect(await git(remote, "branch", "--list", "milo/issue-14")).toBe("");
      // A stale ticket closes with the agent's explanation instead of becoming a PR.
      await runner.work(repo, 15);
      expect(prs).toEqual([]);
      expect(closed).toEqual([{ state: "closed", state_reason: "completed" }]);
      expect(comments.at(-1)?.body).toContain("Report with evidence");
    }),
  15_000,
);

test("review and revise publish nothing when the PR head moves", () =>
  temporary("milo-stale-", async (folder) => {
    const git = (root: string, ...args: string[]) =>
      command(["git", ...args], { cwd: root });
    const source = join(folder, "source");
    const remote = join(folder, "remote.git");
    await mkdir(source);
    await git(source, "init", "-q", "-b", "main");
    await git(source, "config", "user.name", "Test");
    await git(source, "config", "user.email", "test@example.test");
    await Bun.write(join(source, "file.txt"), "old\n");
    await git(source, "add", ".");
    await git(source, "commit", "-qm", "Initial");
    const base = await git(source, "rev-parse", "HEAD");
    await Bun.write(join(source, "file.txt"), "new\n");
    await git(source, "commit", "-qam", "Change");
    const sha = await git(source, "rev-parse", "HEAD");
    await git(source, "clone", "-q", "--bare", source, remote);
    await git(remote, "update-ref", "refs/heads/milo/issue-34", sha);
    await git(remote, "update-ref", "refs/pull/34/head", sha);
    const fakeAgent = join(folder, "agent.ts");
    const runs = join(folder, "runs.txt");
    await Bun.write(
      fakeAgent,
      `import { appendFileSync } from "node:fs";
const prompt = await Bun.stdin.text();
appendFileSync(${JSON.stringify(runs)}, "x");
if (prompt.includes("Address these review requests")) await Bun.write("file.txt", "revised\\n");
await Bun.write(Bun.argv[2]!, "Report");`,
    );
    // Each read of the PR takes the next head; the last one repeats.
    let heads: string[] = [];
    const comments: string[] = [];
    const gh: GitHubClient = {
      async api<T>(endpoint: string): Promise<T> {
        if (endpoint === "pulls/34")
          return {
            number: 34,
            state: "open",
            body: "",
            html_url: "https://example.test/pr/34",
            head: {
              ref: "milo/issue-34",
              sha: heads.length > 1 ? heads.shift() : heads[0],
              repo: { full_name: "owner/repo" },
            },
            base: { ref: "main", sha: base },
          } as T;
        if (endpoint === "issues/34") return issue() as T;
        if (endpoint === "collaborators/owner/permission")
          return { permission: "admin" } as T;
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      },
      async pages<T>(endpoint: string): Promise<T[]> {
        if (endpoint === "pulls/34/reviews")
          return [
            {
              id: 1,
              state: "CHANGES_REQUESTED",
              commit_id: sha,
              user: { login: "owner" },
              body: "Fix",
            },
          ] as T[];
        return [];
      },
      async comment(_number, body) {
        comments.push(body);
      },
      async viewer() {
        return "milo";
      },
    };
    const runner = new Runner(
      {
        agent: { command: [process.execPath, fakeAgent, "{output}"] },
        repos: [],
      },
      () => gh,
      async (_repo, root) => {
        await git(folder, "clone", "-q", remote, root);
        await git(root, "config", "user.name", "Test");
        await git(root, "config", "user.email", "test@example.test");
      },
    );
    const repo: Repo = {
      name: "owner/repo",
      setup: [],
      checks: [{ command: ["true"] }],
    };
    const moved = "0".repeat(40);
    // A head that moved before checkout stops the run before the agent starts.
    heads = [moved];
    await expect(runner.review(repo, 34)).rejects.toThrow(
      "PR changed during checkout",
    );
    expect(existsSync(runs)).toBeFalse();
    // A head that moved while the agent ran stops the run before it publishes.
    heads = [sha, moved];
    await expect(runner.review(repo, 34)).rejects.toThrow(
      "PR changed during review",
    );
    heads = [sha, moved];
    await expect(runner.revise(repo, 34)).rejects.toThrow(
      "PR changed during revision",
    );
    expect(await Bun.file(runs).text()).toBe("xx");
    expect(comments).toEqual([]);
    expect(await git(remote, "rev-parse", "refs/heads/milo/issue-34")).toBe(
      sha,
    );
  }));

// Policy lives in mergeAction and mergeFacts (tests/rules.test.ts); this checks Runner's wiring.
test("auto-merge gates on the ticket, then merges, updates or logs without stopping later PRs", async () => {
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
  let refused = false;
  let open = [pr];
  let ticket = { ...issue(), labels: [{ name: "milo:dependencies" }] };
  const writes: string[] = [];
  const gh: GitHubClient = {
    async api<T>(endpoint: string, method = "GET"): Promise<T> {
      if (method !== "GET") {
        writes.push(endpoint);
        if (refused) throw new Error("gh api: 405 not allowed");
      }
      const responses: Record<string, unknown> = {
        "issues/12": ticket,
        "commits/abc/status": { state: "pending", total_count: 0 },
        "compare/main...abc": { behind_by: behind },
        "collaborators/stranger/permission": { permission: "triage" },
      };
      return (responses[endpoint] ?? {}) as T;
    },
    async pages<T>(endpoint: string, key?: string): Promise<T[]> {
      if (endpoint === "commits/abc/check-runs" && key === "check_runs")
        return runs as T[];
      const comment = "<!-- milo:review:abc --><!-- milo:merge -->";
      const responses: Record<string, unknown[]> = {
        "pulls?state=open": open,
        "issues/34/comments": [{ body: comment, user: { login: "milo" } }],
        "issues/35/comments": [{ body: comment, user: { login: "milo" } }],
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
  const logged = async (target = repo) => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runner.runReviews(target);
      return log.mock.calls.map(([line]) => line);
    } finally {
      log.mockRestore();
    }
  };
  expect(await logged()).toEqual([
    "https://example.test/pr/34: waiting for passing CI",
  ]);
  runs = [];
  expect(await logged()).toEqual([
    "https://example.test/pr/34: no CI checks; auto-merge needs PR CI",
  ]);
  runs = [{ status: "completed", conclusion: "success" }];
  // Only a labelled category the repo allows, on a trusted author's ticket, merges.
  expect(await logged({ ...repo, autoMerge: [] })).toEqual([]);
  const labelled = ticket;
  ticket = issue("<!-- milo:dependencies:key -->");
  expect(await logged()).toEqual([]);
  ticket = { ...labelled, user: { login: "stranger" } };
  expect(await logged()).toEqual([]);
  ticket = labelled;
  expect(writes).toEqual([]);
  behind = 2;
  expect(await logged()).toEqual([
    "https://example.test/pr/34: updated from main",
  ]);
  behind = 0;
  expect(await logged()).toEqual(["Merged https://example.test/pr/34"]);
  expect(writes).toEqual(["pulls/34/update-branch", "pulls/34/merge"]);
  // A refused write is logged and skipped, so later PRs still run.
  writes.length = 0;
  refused = true;
  open = [pr, { ...pr, number: 35, html_url: "https://example.test/pr/35" }];
  behind = 2;
  expect(await logged()).toContain(
    "https://example.test/pr/34: branch update refused; resolve conflicts with main",
  );
  expect(writes).toEqual(["pulls/34/update-branch", "pulls/35/update-branch"]);
  writes.length = 0;
  behind = 0;
  expect(await logged()).toContain(
    "https://example.test/pr/34: merge refused; check branch rules and allowed merge methods",
  );
  expect(writes).toEqual(["pulls/34/merge", "pulls/35/merge"]);
});

test("a failed or empty review attempt does not block later PRs", async () => {
  const repo: Repo = { name: "owner/repo" };
  const pr = (number: number, sha: string): PullRequest => ({
    number,
    state: "open",
    body: "",
    html_url: `https://example.test/pr/${number}`,
    head: {
      ref: `milo/issue-${number}`,
      sha,
      repo: { full_name: "owner/repo" },
    },
    base: { ref: "main", sha: "base" },
  });
  let open = [pr(34, "a"), pr(35, "b")];
  const request = (id: number, sha: string): Review => ({
    id,
    state: "CHANGES_REQUESTED",
    commit_id: sha,
    user: { login: "owner" },
    body: "",
  });
  let reviews = [request(1, "a")];
  const comments: Record<number, { body: string; user: { login: string } }[]> =
    { 34: [], 35: [] };
  const gh: GitHubClient = {
    async api<T>(endpoint: string): Promise<T> {
      if (endpoint === "collaborators/owner/permission")
        return { permission: "write" } as T;
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
    async pages<T>(endpoint: string): Promise<T[]> {
      const responses: Record<string, unknown[]> = {
        "pulls?state=open": open,
        "pulls/34/reviews": reviews,
        "pulls/35/reviews": [],
        "issues/34/comments": comments[34] ?? [],
        "issues/35/comments": comments[35] ?? [],
      };
      return (responses[endpoint] ?? []) as T[];
    },
    async comment(number, body) {
      comments[number]?.push({ body, user: { login: "milo" } });
    },
    async viewer() {
      return "milo";
    },
  };
  const runner = new Runner(
    { agent: { command: ["agent", "{output}"] }, repos: [] },
    () => gh,
  );
  const calls: [number, boolean][] = [];
  let outcome: () => Promise<boolean> = async () => false;
  const review = spyOn(runner, "review").mockImplementation(
    async (_repo, number) => {
      calls.push([number, false]);
      await outcome();
      // A completed review stamps the head, as the real one does.
      const sha = open.find((item) => item.number === number)?.head.sha ?? "";
      await gh.comment(number, reviewStamp(sha));
    },
  );
  const revise = spyOn(runner, "revise").mockImplementation(
    async (_repo, number) => {
      calls.push([number, true]);
      return outcome();
    },
  );
  try {
    // An empty revision is attempted once, then #34 falls through to a plain review.
    await runner.runReviews(repo);
    await runner.runReviews(repo);
    expect(calls).toEqual([
      [34, true],
      [34, false],
    ]);
    // A forged marker from another account does not suppress an attempt.
    comments[35]?.push({
      body: "<!-- milo:failed:b: -->",
      user: { login: "stranger" },
    });
    await runner.runReviews(repo);
    expect(calls.at(-1)).toEqual([35, false]);
    await runner.runReviews(repo);
    expect(calls).toHaveLength(3);
    // A new change request triggers another revision.
    reviews = [request(1, "a"), request(2, "a")];
    calls.length = 0;
    await runner.runReviews(repo);
    expect(calls).toEqual([[34, true]]);
    // A throwing plain review is recorded too; a new commit retries it.
    reviews = [];
    open = [pr(34, "c"), pr(35, "b")];
    comments[35] = [];
    outcome = async () => {
      throw new Error("PR changed during review; retry");
    };
    calls.length = 0;
    await expect(runner.runReviews(repo)).rejects.toThrow("PR changed");
    await expect(runner.runReviews(repo)).rejects.toThrow("PR changed");
    await runner.runReviews(repo);
    open = [pr(34, "d"), pr(35, "b")];
    outcome = async () => true;
    await runner.runReviews(repo);
    expect(calls).toEqual([
      [34, false],
      [35, false],
      [34, false],
    ]);
    expect(comments[34]?.at(-2)?.body).toStartWith("<!-- milo:failed:c: -->");
  } finally {
    review.mockRestore();
    revise.mockRestore();
  }
});

test("null users and commits on GitHub entries do not stop reviews", async () => {
  const pr: PullRequest = {
    number: 34,
    state: "open",
    body: "",
    html_url: "https://example.test/pr/34",
    head: { ref: "milo/issue-34", sha: "a", repo: { full_name: "owner/repo" } },
    base: { ref: "main", sha: "base" },
  };
  const request = { id: 1, state: "CHANGES_REQUESTED", body: "" };
  const gh: GitHubClient = {
    async api<T>(endpoint: string): Promise<T> {
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    },
    async pages<T>(endpoint: string): Promise<T[]> {
      const responses: Record<string, unknown[]> = {
        "pulls?state=open": [pr],
        "pulls/34/reviews": [
          { ...request, user: null, commit_id: "a" },
          { ...request, id: 2, user: { login: "owner" }, commit_id: null },
        ],
        "issues/34/comments": [{ body: "hi", user: null }],
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
  const calls: [number, boolean][] = [];
  const review = spyOn(runner, "review").mockImplementation(
    async (_repo, number) => {
      calls.push([number, false]);
    },
  );
  const revise = spyOn(runner, "revise").mockImplementation(
    async (_repo, number) => {
      calls.push([number, true]);
      return true;
    },
  );
  try {
    await runner.runReviews({ name: "owner/repo" });
    expect(calls).toEqual([[34, false]]);
  } finally {
    review.mockRestore();
    revise.mockRestore();
  }
});

test("Milo pushes nothing after untrusted code changes git config", () =>
  temporary("milo-gitconfig-", async (folder) => {
    const git = (root: string, ...args: string[]) =>
      command(["git", ...args], { cwd: root });
    const source = join(folder, "source");
    const remote = join(folder, "remote.git");
    await mkdir(source);
    await git(source, "init", "-q", "-b", "main");
    await git(source, "config", "user.name", "Test");
    await git(source, "config", "user.email", "test@example.test");
    await Bun.write(join(source, "file.txt"), "old\n");
    await git(source, "add", ".");
    await git(source, "commit", "-qm", "Initial");
    await git(source, "clone", "-q", "--bare", source, remote);
    // The agent is the untrusted code here: setup and check steps cannot write .git at all.
    const fakeAgent = join(folder, "agent.ts");
    await Bun.write(
      fakeAgent,
      `import { appendFileSync } from "node:fs";
await Bun.stdin.text();
await Bun.write("file.txt", "new");
appendFileSync(".git/config", "[milo]\\n\\ttampered = true\\n");
await Bun.write(Bun.argv[2]!, "Report");`,
    );
    const gh: GitHubClient = {
      async api<T>(endpoint: string): Promise<T> {
        if (endpoint === "issues/12") return issue() as T;
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      },
      async pages<T>(): Promise<T[]> {
        return [];
      },
      async comment() {},
      async viewer() {
        return "milo";
      },
    };
    const runner = new Runner(
      {
        agent: { command: [process.execPath, fakeAgent, "{output}"] },
        repos: [],
      },
      () => gh,
      async (_repo, root) => {
        await git(folder, "clone", "-q", remote, root);
        await git(root, "config", "user.name", "Test");
        await git(root, "config", "user.email", "test@example.test");
      },
    );
    await expect(
      runner.work(
        { name: "owner/repo", setup: [], checks: [{ command: ["true"] }] },
        12,
      ),
    ).rejects.toThrow(/git config: .*tampered/);
    expect(await git(remote, "branch", "--list", "milo/issue-12")).toBe("");
  }));
