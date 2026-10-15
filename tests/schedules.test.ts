import { expect, spyOn, test } from "bun:test";
import { main } from "../src/cli.ts";
import {
  type Config,
  categories,
  includeSelfRepo,
  type Repo,
} from "../src/config.ts";
import { command, temporary } from "../src/process.ts";
import {
  type GitHubClient,
  type Issue,
  periodKey,
  Runner,
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
test("one consumer workflow picks daily security and one weekly task per day", async () => {
  const root = `${import.meta.dir}/../.github/workflows`;
  const consumer = Bun.YAML.parse(
    await Bun.file(`${root}/consumer.yml`).text(),
  ) as {
    jobs: {
      schedule: { steps: { run: string }[] };
      tasks: { uses: string; secrets: unknown; with: Record<string, string> };
      reviews: { uses: string; secrets: unknown; with: Record<string, string> };
    };
  };
  const forwarded = Object.fromEntries(
    ["MILO_GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"].map((name) => [
      name,
      `\${{ secrets.${name} }}`,
    ]),
  );
  const script = consumer.jobs.schedule.steps[0]?.run;
  if (!script) throw new Error("Missing schedule script");
  const pick = (event: string, day: string, hour: string) =>
    temporary("milo-schedule-", async (folder) => {
      const output = `${folder}/output`;
      const env = {
        EVENT: event,
        MILO_DAY: day,
        MILO_HOUR: hour,
        GITHUB_OUTPUT: output,
      };
      const previous = Object.fromEntries(
        Object.keys(env).map((key) => [key, process.env[key]]),
      );
      try {
        Object.assign(process.env, env);
        await Bun.write(output, "");
        await command(["bash", "-c", script]);
        return JSON.parse(
          (await Bun.file(output).text()).replace("categories=", ""),
        ) as string[];
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  const weekly = new Set<string>();
  for (const day of ["1", "2", "3", "4", "5", "6", "7"]) {
    const today = await pick("schedule", day, "04");
    expect(today[0]).toBe("security");
    for (const category of today.slice(1)) weekly.add(category);
  }
  expect([...weekly, "security"].sort()).toEqual(
    Object.keys(categories).sort(),
  );
  expect(await pick("schedule", "1", "08")).toEqual([]);
  expect(await pick("schedule", "1", "02")).toEqual([
    "security",
    "dependencies",
  ]);
  expect((await pick("workflow_dispatch", "1", "08")).sort()).toEqual(
    Object.keys(categories).sort(),
  );
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
