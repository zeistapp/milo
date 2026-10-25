import { expect, spyOn, test } from "bun:test";
import { main } from "../src/cli.ts";
import { type Config, includeSelfRepo, type Repo } from "../src/config.ts";
import type { GitHubClient, Issue } from "../src/github.ts";
import { temporary } from "../src/process.ts";
import { periodKey } from "../src/rules.ts";
import { Runner } from "../src/runner.ts";

const config: Config = { agent: { command: ["agent", "{output}"] }, repos: [] };
const repo: Repo = { name: "owner/repo" };
const ticket = (number: number, category: string): Issue => ({
  number,
  title: category,
  body: `<!-- milo:${category}:2026-W42 -->`,
  state: "open",
  html_url: "",
  created_at: "2026-10-15T09:00:00Z",
  user: { login: "bot" },
  labels: [
    { name: "milo:task" },
    { name: "milo:ready" },
    { name: `milo:${category}` },
  ],
});
test("daily, weekly and monthly scans deduplicate at their actual cadence", () => {
  expect(periodKey("day", new Date("2026-10-14"))).toBe("2026-10-14");
  expect(periodKey("week", new Date("2026-10-14"))).toBe("2026-W42");
  expect(periodKey("week", new Date("2021-01-01"))).toBe("2020-W53");
  expect(periodKey("month", new Date("2026-10-31"))).toBe("2026-10");
});
test("a dedicated task runner cannot consume another category or run reviews", async () => {
  const issues = [ticket(1, "security"), ticket(2, "dependencies")];
  const gh: GitHubClient = {
    async api<T>(): Promise<T> {
      throw new Error("Unexpected API write");
    },
    async pages<T>(endpoint: string): Promise<T[]> {
      return (endpoint.startsWith("issues?") ? issues : []) as T[];
    },
    async comment() {
      throw new Error("Unexpected comment");
    },
    async viewer() {
      return "bot";
    },
  };
  const runner = new Runner(config, () => gh);
  const plan = spyOn(runner, "plan").mockResolvedValue(undefined);
  const work = spyOn(runner, "work").mockResolvedValue(undefined);
  const reviews = spyOn(runner, "runReviews").mockResolvedValue(undefined);
  await runner.runTasks(repo, "dependencies", "week");
  expect(plan).toHaveBeenCalledWith(
    { ...repo, categories: ["dependencies"] },
    true,
    "week",
  );
  expect(work).toHaveBeenCalledTimes(1);
  expect(work).toHaveBeenCalledWith(repo, 2, "dependencies");
  expect(reviews).not.toHaveBeenCalled();
});
test("an unscoped task runner works the oldest approved ticket of any category, then scans every category", async () => {
  const uncategorised = {
    ...ticket(1, "x"),
    body: "",
    labels: [{ name: "milo:task" }, { name: "milo:ready" }],
  };
  const issues = [ticket(3, "cleanup"), uncategorised];
  const gh: GitHubClient = {
    async api<T>(): Promise<T> {
      throw new Error("Unexpected API write");
    },
    async pages<T>(endpoint: string): Promise<T[]> {
      return (endpoint.startsWith("issues?") ? issues : []) as T[];
    },
    async comment() {
      throw new Error("Unexpected comment");
    },
    async viewer() {
      return "bot";
    },
  };
  const runner = new Runner(config, () => gh);
  const plan = spyOn(runner, "plan").mockResolvedValue(undefined);
  const work = spyOn(runner, "work").mockResolvedValue(undefined);
  await runner.runTasks(repo, undefined, "day");
  expect(work).toHaveBeenCalledTimes(1);
  expect(work).toHaveBeenCalledWith(repo, 1, undefined);
  expect(plan).toHaveBeenCalledWith(repo, true, "day");
});
test("self maintenance includes the published runner repo without duplicating explicit configuration", () => {
  const explicit: Config = {
    ...config,
    repos: [
      { name: "owner/milo", categories: ["dependencies"], autoReady: [] },
    ],
  };
  expect(includeSelfRepo(explicit, "OWNER/milo")).toBe(explicit);
  expect(includeSelfRepo(config, "owner/milo").repos).toEqual([
    {
      name: "owner/milo",
      categories: undefined,
      autoReady: [],
      setup: undefined,
      checks: undefined,
    },
  ]);
  expect(() => includeSelfRepo(config, "invalid")).toThrow("owner/repository");
});
test("one consumer workflow works approved tickets and runs daily scans on every run", async () => {
  const root = `${import.meta.dir}/../.github/workflows`;
  const consumer = Bun.YAML.parse(
    await Bun.file(`${root}/consumer.yml`).text(),
  ) as {
    jobs: {
      tasks: { uses: string; secrets: unknown; with: Record<string, string> };
      reviews: { uses: string; secrets: unknown; with: Record<string, string> };
    };
  };
  const forwarded = Object.fromEntries(
    ["MILO_GITHUB_TOKEN", "MILO_APP_PRIVATE_KEY", "ANTHROPIC_API_KEY"].map(
      (name) => [name, `\${{ secrets.${name} }}`],
    ),
  );
  // No category, so any approved ticket qualifies; scans dedupe per UTC day.
  expect(consumer.jobs.tasks.with).toEqual({
    action: "task",
    period: "day",
    config: `\${{ inputs.config }}`,
  });
  for (const job of [consumer.jobs.tasks, consumer.jobs.reviews]) {
    expect(job.uses).toBe(
      "zeistapp/milo/.github/workflows/maintenance.yml@main",
    );
    expect(job.secrets).toEqual(forwarded);
  }
  expect(consumer.jobs.reviews.with.action).toBe("reviews");
  const caller = Bun.YAML.parse(await Bun.file(`${root}/milo.yml`).text()) as {
    jobs: { milo: { uses: string; secrets: unknown } };
  };
  // Cross-owner callers receive no inherited secrets, so each level names them.
  expect(caller.jobs.milo).toEqual({
    uses: "zeistapp/milo/.github/workflows/consumer.yml@main",
    secrets: forwarded,
  });
  const shared = Bun.YAML.parse(
    await Bun.file(`${root}/maintenance.yml`).text(),
  ) as {
    on: {
      workflow_call: {
        inputs: {
          config: { default: string };
          "include-self": { default: boolean };
        };
        secrets: Record<string, unknown>;
      };
    };
  };
  expect(shared.on.workflow_call.inputs.config.default).toBe(
    "milo.config.json",
  );
  expect(shared.on.workflow_call.inputs["include-self"].default).toBeTrue();
  expect(Object.keys(shared.on.workflow_call.secrets)).toEqual(
    Object.keys(forwarded),
  );
});
test("a shared schedule skips categories a repo has disabled", () =>
  temporary("milo-skip-", async (folder) => {
    const file = `${folder}/milo.config.json`;
    await Bun.write(
      file,
      JSON.stringify({
        agent: { provider: "claude" },
        repos: [{ name: "owner/repo", categories: ["security"] }],
      }),
    );
    await main(["--config", file, "--category", "cleanup", "task"]);
    await expect(
      main(["--config", file, "--category", "cleanup", "plan"]),
    ).rejects.toThrow("No configured repositories matched");
    await expect(
      main([
        "--config",
        file,
        "--repo",
        "owner/repo",
        "--category",
        "cleanup",
        "task",
      ]),
    ).rejects.toThrow("No configured repositories matched");
  }));
