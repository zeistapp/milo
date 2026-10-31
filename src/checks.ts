import type { Repo, Step } from "./config.ts";
import { inside, installPackages, sandboxed, workHome } from "./process.ts";
import {
  type Installed,
  inspectProject,
  installedVersions,
  lockstepDrift,
  type Project,
} from "./project.ts";
import type { Git } from "./workspace.ts";

async function steps(commands: Step[], root: string): Promise<void> {
  const repo = await inside(root);
  const home = await workHome(root);
  for (const step of commands) {
    const started = performance.now();
    await sandboxed(step, repo, home);
    const seconds = (performance.now() - started) / 1000;
    console.log(
      `${step.cwd ?? "."}: ${JSON.stringify(step.command)} took ${seconds.toFixed(1)} s`,
    );
  }
}
// Installs what the project needs to run, without the baseline checks.
export async function setup(repo: Repo, root: string): Promise<Project> {
  const project = await inspectProject(root, repo);
  await installPackages(repo.systemPackages);
  await steps(project.setup, root);
  return project;
}
// Installs the project and runs its baseline checks before the agent edits anything.
export async function prepare(
  repo: Repo,
  root: string,
): Promise<Project & { installed: Installed }> {
  const project = await setup(repo, root);
  for (const warning of project.warnings)
    console.log(`Validation gap: ${warning}`);
  const installed = await installedVersions(root, project.packages);
  await steps(project.checks, root);
  return { ...project, installed };
}
// Reinstalls and reruns the baseline's checks plus any the agent added; throws on any failure.
export async function checkedChanges(
  repo: Repo,
  root: string,
  git: Git,
  original: string,
  baseline: Project & { installed: Installed },
): Promise<Project> {
  if ((await git("rev-parse", "HEAD")) !== original)
    throw new Error("Agent changed commit history");
  const after = await inspectProject(root, repo);
  // Install from the resulting lockfile, rather than trusting agent-modified node_modules.
  await steps(after.setup, root);
  const drift = await lockstepDrift(
    baseline.installed,
    await installedVersions(root, after.packages),
  );
  if (drift) throw new Error(drift);
  const checks = [
    ...new Map(
      [...baseline.checks, ...after.checks].map((step) => [
        JSON.stringify(step),
        step,
      ]),
    ).values(),
  ];
  await steps(checks, root);
  return { ...after, checks };
}
export function checkReport(project: Project): string {
  return (
    "\n\nHarness checks passed:\n" +
    project.checks
      .map(
        (step) => `- \`${step.cwd ?? "."}: ${JSON.stringify(step.command)}\``,
      )
      .join("\n") +
    (project.warnings.length
      ? "\n\nValidation gaps:\n" +
        project.warnings.map((item) => `- ${item}`).join("\n")
      : "")
  );
}
