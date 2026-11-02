import { parseArgs } from "node:util";
import { z } from "zod";
import {
  Category,
  includeSelfRepo,
  loadConfig,
  Model,
  Period,
  parse,
} from "./config.ts";
import { localCheck } from "./local.ts";
import { inspectProject } from "./project.ts";
import { Runner } from "./runner.ts";

// Annotate failures in Actions so the cause shows in the run summary, not only in the step log.
function fail(message: string): void {
  console.error(
    process.env.GITHUB_ACTIONS === "true"
      ? `::error::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`
      : message,
  );
}

export async function main(args = Bun.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: "string", default: "milo.config.json" },
      repo: { type: "string" },
      apply: { type: "boolean", default: false },
      "report-dir": { type: "string" },
      category: { type: "string" },
      period: { type: "string" },
      "self-repo": { type: "string" },
      agents: { type: "string", default: "20" },
      loop: { type: "boolean", default: false },
      "scan-models": {
        type: "string",
        default: "claude-fable-5-1,claude-sonnet-5-5",
      },
      help: { type: "boolean", short: "h" },
    },
  });
  const configFile = values.config ?? "milo.config.json";
  if (values.help) {
    console.log(
      "Milo: bun run milo [--config path] [--repo owner/repo] <validate|packages|inspect|check|plan|task|reviews|work|review|revise|tick|turbo> [number/path] [--apply] [--agents 1-20] [--loop] [--scan-models a,b] [--category name] [--period day|week|month] [--self-repo owner/repo] [--report-dir path]",
    );
    return;
  }
  const [action, target] = positionals;
  if (action === "check") {
    const config = values.repo ? await loadConfig(configFile) : undefined;
    const repo = config?.repos.find((repo) => repo.name === values.repo);
    if (values.repo && !repo)
      throw new Error("No configured repository matched");
    const report = await localCheck(
      target ?? ".",
      values["report-dir"] ??
        `.milo/runs/${new Date().toISOString().replaceAll(":", "-")}`,
      repo,
    );
    if (!report.passed)
      throw new Error(
        "Local checks failed; inspect the report and private command logs",
      );
    return;
  }
  if (action === "inspect") {
    console.log(JSON.stringify(await inspectProject(target ?? "."), null, 2));
    return;
  }
  if (
    !action ||
    ![
      "validate",
      "packages",
      "plan",
      "task",
      "reviews",
      "work",
      "review",
      "revise",
      "tick",
      "turbo",
    ].includes(action)
  )
    throw new Error("Specify a command; use --help");
  const category = values.category
    ? parse(Category, values.category)
    : undefined;
  if (values.loop && action !== "turbo")
    throw new Error("Use --loop with turbo");
  if (category && !["task", "plan", "work"].includes(action))
    throw new Error("Use --category with task, plan, or work");
  // Turbo scans like the scheduled tick, once a day per category.
  const period = parse(
    Period,
    values.period ?? (action === "turbo" ? "day" : "week"),
  );
  let config = await loadConfig(configFile);
  if (values["self-repo"])
    config = includeSelfRepo(config, values["self-repo"]);
  if (action === "validate") {
    console.log("Configuration valid");
    return;
  }
  if (action === "packages") {
    console.log(
      [
        ...new Set(config.repos.flatMap((repo) => repo.systemPackages ?? [])),
      ].join(" "),
    );
    return;
  }
  const repos = config.repos.filter(
    (repo) =>
      (!values.repo || repo.name === values.repo) &&
      (!category || !repo.categories || repo.categories.includes(category)),
  );
  // A targeted category run is a no-op for repos that disabled that category.
  if (category && !repos.length && action === "task" && !values.repo) {
    console.log(`No configured repository enables ${category}`);
    return;
  }
  if (!repos.length) throw new Error("No configured repositories matched");
  const numbered = ["work", "review", "revise"].includes(action);
  if (
    numbered &&
    (repos.length !== 1 ||
      !target ||
      !/^[1-9][0-9]*$/.test(target) ||
      !Number.isSafeInteger(Number(target)))
  ) {
    throw new Error("Select one repository and a positive ticket/PR number");
  }
  if (!numbered && target) throw new Error("Unexpected positional argument");
  const runner = new Runner(config);
  if (action === "turbo") {
    const agents = Number(values.agents);
    if (!Number.isInteger(agents) || agents < 1 || agents > 20)
      throw new Error("--agents must be a whole number from 1 to 20");
    const scanModels = parse(
      z.array(Model("--scan-models").unwrap()).min(1),
      (values["scan-models"] ?? "").split(",").filter(Boolean),
    );
    const failed = await runner.turbo(repos, {
      agents,
      period,
      loop: values.loop,
      scanModels,
    });
    for (const failure of failed) fail(failure);
    if (failed.length) throw new Error(`${failed.length} turbo job(s) failed`);
    return;
  }
  const failures: string[] = [];
  for (const repo of repos) {
    try {
      if (action === "plan")
        await runner.plan(
          category ? { ...repo, categories: [category] } : repo,
          values.apply,
          period,
        );
      else if (action === "task") await runner.runTasks(repo, category, period);
      else if (action === "reviews") await runner.runReviews(repo);
      else if (action === "work")
        await runner.work(repo, Number(target), category);
      else if (action === "review") await runner.review(repo, Number(target));
      else if (action === "revise") await runner.revise(repo, Number(target));
      else await runner.tick(repo);
    } catch (error) {
      failures.push(repo.name);
      fail(
        `${repo.name}: ${error instanceof Error ? error.message : "Unknown failure"}`,
      );
    }
  }
  if (failures.length)
    throw new Error(`${failures.length} repository run(s) failed`);
}
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? error.message : "Unknown failure");
    process.exitCode = 1;
  }
}
