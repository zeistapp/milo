import { expect, test } from "bun:test";
import { join } from "node:path";
import { minimumClaudeVersion } from "../src/claude.ts";
import { command, temporary } from "../src/process.ts";

interface Script {
  id?: string;
  name?: string;
  run?: string;
}
interface Metadata {
  runs: { steps: Script[] };
}
const root = join(import.meta.dir, "..");
const action = Bun.YAML.parse(
  await Bun.file(join(root, "action.yml")).text(),
) as Metadata;
test("workflow and composite shell scripts have valid syntax", async () => {
  const scripts = [...action.runs.steps];
  for await (const file of new Bun.Glob("*.yml").scan(
    join(root, ".github/workflows"),
  )) {
    const workflow = Bun.YAML.parse(
      await Bun.file(join(root, ".github/workflows", file)).text(),
    ) as { jobs: Record<string, { steps?: Script[] }> };
    scripts.push(
      ...Object.values(workflow.jobs).flatMap((job) => job.steps ?? []),
    );
  }
  for (const step of scripts)
    if (step.run) await command(["bash", "-n"], { input: step.run });
});
test("distributed action reads the caller's config from an external working directory", () =>
  temporary("milo-consumer-", async (consumer) => {
    const config = join(consumer, "my config.json");
    await Bun.write(
      config,
      await Bun.file(join(root, "milo.config.json")).text(),
    );
    const script = action.runs.steps.find(
      (step) => step.name === "Run Milo",
    )?.run;
    if (!script) throw new Error("Missing action entry point");
    const env = {
      MILO_ACTION_PATH: root,
      INPUT_CONFIG: config,
      INPUT_ACTION: "validate",
      INPUT_REPO: "",
      INPUT_NUMBER: "",
      INPUT_APPLY: "false",
      INPUT_CATEGORY: "",
      INPUT_PERIOD: "week",
      INPUT_SELF_REPO: "",
      RUNNER_OS: "macOS",
      RUNNER_TEMP: consumer,
      GITHUB_REPOSITORY: "owner/repo",
      MILO_LOG_DIR: "",
    };
    const original = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    try {
      Object.assign(process.env, env);
      expect(
        await command(["bash", "-c", script], { cwd: consumer }),
      ).toContain("Configuration valid");
      // Without sudo or apt on macOS, the package step installs nothing and says so.
      const install = action.runs.steps.find(
        (step) => step.name === "Prepare system packages",
      )?.run;
      if (!install) throw new Error("Missing system package step");
      expect(await command(["bash", "-c", install], { cwd: consumer })).toBe(
        "",
      );
      const parsed = JSON.parse(await Bun.file(config).text());
      parsed.repos[0].systemPackages = ["ffmpeg"];
      await Bun.write(config, JSON.stringify(parsed));
      expect(
        await command(["bash", "-c", install], { cwd: consumer }),
      ).toContain("::warning::systemPackages are installed only on Linux");
      // Shared schedules run task without a category; the CLI picks the work.
      const stub = join(consumer, "stub");
      await Bun.write(
        join(stub, "src/cli.ts"),
        'console.log(Bun.argv.slice(2).join(" "))',
      );
      process.env.MILO_ACTION_PATH = stub;
      process.env.INPUT_ACTION = "task";
      expect(
        await command(["bash", "-c", script], { cwd: consumer }),
      ).toContain("--period week task");
      // CI checks the calling repository's configured checks unless told another.
      process.env.INPUT_ACTION = "check";
      expect(
        await command(["bash", "-c", script], { cwd: consumer }),
      ).toContain(
        `--repo owner/repo check --report-dir ${consumer}/milo-check`,
      );
      process.env.MILO_ACTION_PATH = root;
      process.env.INPUT_ACTION = "work";
      process.env.INPUT_NUMBER = "12; touch injected";
      await expect(
        command(["bash", "-c", script], { cwd: consumer }),
      ).rejects.toThrow("failed");
      expect(await Bun.file(join(consumer, "injected")).exists()).toBeFalse();
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }));

test("maintenance preflight installs only the configured provider's agent", () =>
  temporary("milo-preflight-", async (folder) => {
    const workflow = Bun.YAML.parse(
      await Bun.file(join(root, ".github/workflows/maintenance.yml")).text(),
    ) as {
      jobs: { run: { steps: (Script & { env?: Record<string, string> })[] } };
    };
    const step = workflow.jobs.run.steps.find(
      (step) => step.id === "preflight",
    );
    if (!step?.run) throw new Error("Missing maintenance preflight");
    const script = step.run;
    const fallback = step.env?.DEFAULT_CLAUDE_VERSION ?? "";
    // The shipped default must satisfy the adapter's minimum.
    expect(
      Bun.semver.order(fallback, minimumClaudeVersion),
    ).toBeGreaterThanOrEqual(0);
    const config = join(folder, "milo.config.json");
    const output = join(folder, "output");
    const run = async (provider: string, env: Record<string, string>) => {
      await Bun.write(config, JSON.stringify({ agent: { provider } }));
      await Bun.write(output, "");
      const all = {
        CONFIG: config,
        GITHUB_OUTPUT: output,
        DEFAULT_CLAUDE_VERSION: fallback,
        CLAUDE_VERSION: "",
        MILO_GITHUB_TOKEN: "fake-github-token",
        ANTHROPIC_API_KEY: "",
        ...env,
      };
      const previous = Object.fromEntries(
        Object.keys(all).map((key) => [key, process.env[key]]),
      );
      try {
        Object.assign(process.env, all);
        await command(["bash", "-c", script]);
        return (await Bun.file(output).text()).trim();
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    };
    const anthropic = { ANTHROPIC_API_KEY: "fake-anthropic-key" };
    expect(await run("claude", anthropic)).toBe(`claude-version=${fallback}`);
    expect(await run("claude", { ...anthropic, CLAUDE_VERSION: "2.2.0" })).toBe(
      "claude-version=2.2.0",
    );
    await expect(run("claude", {})).rejects.toThrow("failed");
    await expect(
      run("claude", { ...anthropic, MILO_GITHUB_TOKEN: "" }),
    ).rejects.toThrow("failed");
    // A custom agent.command installs nothing, even with a Claude pin set.
    expect(
      await run("custom", { ...anthropic, CLAUDE_VERSION: "2.1.296" }),
    ).toBe("");
  }));
