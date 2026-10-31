import { join } from "node:path";
import { z } from "zod";
import { runAgent } from "./agent.ts";
import { setup } from "./checks.ts";
import {
  type Category,
  categoryNames,
  type Period,
  parse,
  type Repo,
  scanEveryDays,
} from "./config.ts";
import { type GitHubClient, Issue, Link, trustedComments } from "./github.ts";
import { temporary } from "./process.ts";
import { inspectProject, projectContext } from "./project.ts";
import {
  type Finding,
  finding,
  labels,
  periodKey,
  ScanResult,
  scannedNote,
  shouldScan,
  ticketDraft,
  VerifiedResult,
} from "./rules.ts";
import type { Context } from "./runner.ts";
import { type Rejection, scanPrompt, verifyPrompt } from "./scan.ts";
import { openWorkspace } from "./workspace.ts";

export async function plan(
  { config, github, cloneRepo }: Context,
  repo: Repo,
  apply = false,
  period: Period = "week",
): Promise<void> {
  const gh = github(repo);
  const selected = repo.categories ?? categoryNames;
  const existing = new Map(
    parse(
      z.array(
        z.object({ name: z.string(), description: z.string().nullable() }),
      ),
      await gh.pages("labels"),
    ).map((label) => [label.name, label.description]),
  );
  if (apply) {
    const taskLabels = Object.fromEntries(
      selected.map((category) => [`milo:${category}`, "64748b"]),
    );
    for (const [name, color] of Object.entries({ ...labels, ...taskLabels }))
      if (!existing.has(name)) await gh.api("labels", "POST", { name, color });
  }
  // Open PRs come back as issues too; the verifier checks a finding against both.
  const work = parse(z.array(Issue), await gh.pages("issues?state=open"));
  const open = work.filter((issue) => !Object.hasOwn(issue, "pull_request"));
  for (const category of selected) {
    const label = `milo:${category}`;
    const key = periodKey(period, new Date(), scanEveryDays[category]);
    if (!shouldScan(existing.get(label), key, open, category)) continue;
    const found = await scan(
      { config, cloneRepo },
      repo,
      category,
      work.map(({ number, title }) => ({ number, title })),
      await rejected(gh, label),
    );
    if (!apply) {
      console.log(
        JSON.stringify({ repository: repo.name, category, found }, null, 2),
      );
      continue;
    }
    if (found) {
      const filed = parse(
        Link.extend({ number: z.number() }),
        await gh.api("issues", "POST", ticketDraft(found, repo, category, key)),
      );
      console.log(filed.html_url);
      // A native dependency, not prose, is what makes runTasks wait; PRs can't block an issue.
      for (const blocker of open.filter((issue) =>
        found.blockedBy.includes(issue.number),
      )) {
        const { id } = parse(
          z.object({ id: z.number() }),
          await gh.api(`issues/${blocker.number}`),
        );
        await gh.api(`issues/${filed.number}/dependencies/blocked_by`, "POST", {
          issue_id: id,
        });
      }
    } else console.log(`${repo.name}: ${category} scan found nothing verified`);
    await gh.api(`labels/${encodeURIComponent(label)}`, "PATCH", {
      description: scannedNote(key),
    });
  }
}
// Tickets a maintainer closed as not planned, with the last maintainer comment as the reason.
// CEILING: reads only the 100 most recently updated closed tickets in the category; page further if rejections get buried.
async function rejected(gh: GitHubClient, label: string): Promise<Rejection[]> {
  const viewer = await gh.viewer();
  const closed = parse(
    z.array(Issue),
    await gh.api(
      `issues?state=closed&labels=${encodeURIComponent(label)}&sort=updated&per_page=100`,
    ),
  )
    .filter(
      (issue) =>
        issue.state_reason === "not_planned" &&
        !Object.hasOwn(issue, "pull_request"),
    )
    .slice(0, 10);
  const found = [];
  for (const { number, title, body } of closed)
    found.push({
      number,
      title,
      body,
      reason:
        (await trustedComments(gh, number)).findLast(
          (comment) => comment.author !== viewer,
        )?.body ?? null,
    });
  return found;
}
async function scan(
  { config, cloneRepo }: Pick<Context, "config" | "cloneRepo">,
  repo: Repo,
  category: Category,
  work: { number: number; title: string }[],
  rejected: Rejection[],
): Promise<Finding | undefined> {
  return temporary("milo-scan-", async (folder) => {
    const root = join(folder, "repo");
    const workspace = await openWorkspace(repo, root, cloneRepo);
    const report = await runAgent(
      config,
      root,
      scanPrompt(
        category,
        rejected,
        projectContext(await inspectProject(root, repo)),
      ),
      true,
      "scan",
      ScanResult,
    );
    await workspace.assertUnchanged();
    const found = finding(report);
    if (!found) return;
    const verified = await runAgent(
      config,
      root,
      verifyPrompt(
        found,
        work,
        rejected,
        projectContext(await setup(repo, root)),
      ),
      false,
      undefined,
      VerifiedResult,
    );
    return finding(verified);
  });
}
