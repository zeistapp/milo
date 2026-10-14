import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Repo, Step } from "./config.ts";
import { command, inside } from "./process.ts";
import { inspectProject } from "./project.ts";

interface Result {
  phase: "setup" | "check";
  step: Step;
  status: "passed" | "failed" | "skipped";
  seconds: number;
  log?: string;
  error?: string;
}
export async function localCheck(
  root: string,
  folder: string,
  repo?: Pick<Repo, "setup" | "checks">,
) {
  root = resolve(root);
  folder = resolve(folder);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const project = await inspectProject(root, repo);
  const results: Result[] = [];
  let setupFailed = false;
  const steps = [
    ...project.setup.map((step) => ({ phase: "setup" as const, step })),
    ...project.checks.map((step) => ({ phase: "check" as const, step })),
  ];
  for (const [index, { phase, step }] of steps.entries()) {
    if (setupFailed) {
      results.push({ phase, step, status: "skipped", seconds: 0 });
      continue;
    }
    const log = join(
      folder,
      `${String(index + 1).padStart(2, "0")}-${phase}.log`,
    );
    const started = performance.now();
    console.log(
      `Running ${phase}: ${step.cwd ?? "."}: ${JSON.stringify(step.command)}`,
    );
    try {
      await command(step.command, {
        cwd: await inside(root, step.cwd),
        trusted: false,
        timeoutSeconds: 900,
        logFile: log,
      });
      results.push({
        phase,
        step,
        status: "passed",
        seconds: (performance.now() - started) / 1000,
        log,
      });
    } catch (error) {
      results.push({
        phase,
        step,
        status: "failed",
        seconds: (performance.now() - started) / 1000,
        log,
        error: error instanceof Error ? error.message : "Unknown failure",
      });
      if (phase === "setup") setupFailed = true;
    }
    console.log(`${results.at(-1)?.status}: ${log}`);
  }
  const report = {
    root,
    timestamp: new Date().toISOString(),
    project,
    results,
    passed: results.every((result) => result.status === "passed"),
  };
  const reportFile = join(folder, "report.json");
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(`Report: ${reportFile}`);
  return report;
}
