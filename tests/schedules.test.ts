import { expect, spyOn, test } from "bun:test";
import { type Config, includeSelfRepo, type Repo } from "../src/config.ts";
import {
  type GitHubClient,
  type Issue,
  Runner,
  ticketSpecs,
} from "../src/runner.ts";

const config: Config = { agent: { command: ["agent", "{output}"] }, repos: [] };
const repo: Repo = { name: "owner/repo" };
const ticket = (number: number, category: string): Issue => ({
  number,
  title: category,
  body: `<!-- milo:${category}:2026-W42 -->`,
  state: "open",
  html_url: "",
  labels: [
    { name: "milo:task" },
    { name: "milo:ready" },
    { name: `milo:${category}` },
  ],
});
test("daily and monthly runners deduplicate at their actual cadence", () => {
  const selected: Repo = { ...repo, categories: ["security"] };
  const date = new Date("2026-10-14");
  const completed = {
    ...ticket(1, "security"),
    state: "closed",
    body: "<!-- milo:security:2026-10-14 -->",
  };
  expect(ticketSpecs(selected, [completed], date, "day")).toHaveLength(0);
  expect(
    ticketSpecs(selected, [completed], new Date("2026-10-15"), "day"),
  ).toHaveLength(1);
  const monthly = { ...completed, body: "<!-- milo:security:2026-10 -->" };
  expect(
    ticketSpecs(selected, [monthly], new Date("2026-10-31"), "month"),
  ).toHaveLength(0);
  expect(
    ticketSpecs(selected, [monthly], new Date("2026-11-01"), "month"),
  ).toHaveLength(1);
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
test("workflows have separate schedules, one shared implementation and the configured target", async () => {
  const root = `${import.meta.dir}/../.github/workflows`;
  const expected = {
    dependencies: "week",
    security: "day",
    cleanup: "week",
    organisation: "month",
    architecture: "month",
    performance: "month",
  };
  for (const [category, period] of Object.entries(expected)) {
    const workflow = Bun.YAML.parse(
      await Bun.file(`${root}/maintenance-${category}.yml`).text(),
    ) as {
      on: { schedule: { cron: string }[] };
      jobs: {
        maintain: {
          uses: string;
          with: { category: string; period: string; action: string };
        };
      };
    };
    expect(workflow.on.schedule[0]?.cron).toBeDefined();
    expect(workflow.jobs.maintain.uses).toBe(
      "./.github/workflows/maintenance.yml",
    );
    expect(workflow.jobs.maintain.with).toEqual({
      action: "task",
      category,
      period,
    });
  }
  const shared = Bun.YAML.parse(
    await Bun.file(`${root}/maintenance.yml`).text(),
  ) as {
    on: {
      workflow_call: {
        inputs: {
          config: { default: string };
          "include-self": { default: boolean };
        };
      };
    };
  };
  expect(shared.on.workflow_call.inputs.config.default).toBe(
    "milo.config.json",
  );
  expect(shared.on.workflow_call.inputs["include-self"].default).toBeTrue();
});

test("every maintenance caller forwards environment secrets to the shared workflow", async () => {
  const root = `${import.meta.dir}/../.github/workflows`;
  let callers = 0;
  for await (const file of new Bun.Glob("maintenance-*.yml").scan(root)) {
    const workflow = Bun.YAML.parse(await Bun.file(`${root}/${file}`).text()) as {
      jobs: Record<string, { uses?: string; secrets?: string }>;
    };
    for (const job of Object.values(workflow.jobs)) {
      if (job.uses === "./.github/workflows/maintenance.yml") {
        expect(job.secrets).toBe("inherit");
        callers++;
      }
    }
  }
  expect(callers).toBe(8);
});
