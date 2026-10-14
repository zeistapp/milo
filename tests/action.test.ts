import { expect, test } from "bun:test";
import { join } from "node:path";
import { command, temporary } from "../src/process.ts";

interface Script {
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
    };
    const original = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]]),
    );
    try {
      Object.assign(process.env, env);
      expect(
        await command(["bash", "-c", script], { cwd: consumer }),
      ).toContain("Configuration valid");
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
