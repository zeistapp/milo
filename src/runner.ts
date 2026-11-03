import { z } from "zod";
import {
  type Category,
  type Config,
  categoryNames,
  type Period,
  parse,
  type Repo,
} from "./config.ts";
import {
  blocked,
  GitHub,
  type GitHubClient,
  Issue,
  PullRequest,
  type Review,
  trustedAuthor,
} from "./github.ts";
import { plan } from "./plan.ts";
import { botComments, merge, requests, review, revise } from "./review.ts";
import {
  failedStamp,
  issueCategory,
  nextReviewStep,
  ticketNumber,
  validateIssue,
  validatePR,
} from "./rules.ts";
import {
  type Event,
  initial,
  isActive,
  nextJob,
  prBusy,
  prKey,
  schedule,
  ticketKey,
} from "./schedule.ts";
import { existingPr, work } from "./work.ts";
import { type Clone, clone } from "./workspace.ts";

// What every flow needs: the config, a GitHub client per repo and a way to clone it.
export interface Context {
  config: Config;
  github: (repo: Repo) => GitHubClient;
  cloneRepo: Clone;
}

// Public entry points. runTasks and runReviews call the flows through this, so tests can stub them.
export class Runner {
  private context: Context;
  constructor(
    config: Config,
    github = (repo: Repo): GitHubClient => new GitHub(repo.name),
    cloneRepo: Clone = clone,
  ) {
    this.context = { config, github, cloneRepo };
  }
  // Returns the number of tickets filed. `models` is turbo's: see plan.ts.
  plan(
    repo: Repo,
    apply = false,
    period: Period = "week",
    models?: string[],
  ): Promise<number> {
    return plan(this.context, repo, apply, period, models);
  }
  work(repo: Repo, number: number, category?: Category): Promise<void> {
    return work(this.context, repo, number, category);
  }
  review(repo: Repo, number: number): Promise<void> {
    return review(this.context, repo, number);
  }
  // Resolves false when there is nothing to revise or the agent produced no change.
  // fromReview addresses Milo's own fix verdict on the head instead of writers' change requests.
  revise(repo: Repo, number: number, fromReview = false): Promise<boolean> {
    return revise(this.context, repo, number, fromReview);
  }
  // Marks a scheduled attempt that leaves nothing on the head, so runReviews moves past it until the head or requests change.
  private async attempt(
    gh: GitHubClient,
    pr: PullRequest,
    requests: Review[],
    run: () => Promise<boolean>,
    fix = false,
  ): Promise<void> {
    const fail = () =>
      gh.comment(
        pr.number,
        `${failedStamp(pr.head.sha, requests, fix)}\n\nMilo could not ${fix ? "fix its review findings on" : requests.length ? "revise" : "review"} this commit; see the workflow log. ` +
          "It retries after a new commit or change request.",
      );
    let done: boolean;
    try {
      done = await run();
    } catch (error) {
      await fail();
      throw error;
    }
    if (!done) await fail();
  }
  async runTasks(
    repo: Repo,
    category?: Category,
    period: Period = "week",
  ): Promise<void> {
    if (category && repo.categories && !repo.categories.includes(category))
      throw new Error("Category is disabled for this repository");
    const scoped = category ? { ...repo, categories: [category] } : repo;
    for await (const number of this.readyTickets(repo, category)) {
      await this.work(repo, number, category);
      break;
    }
    // Work first, so a failing scan cannot starve approved tickets.
    await this.plan(scoped, true, period);
  }
  // Approved, unblocked tickets without a PR, oldest first; lazy, so a caller that takes one makes no further checks.
  private async *readyTickets(
    repo: Repo,
    category?: Category,
  ): AsyncGenerator<number> {
    const gh = this.context.github(repo);
    for (const issue of parse(
      z.array(Issue),
      await gh.pages("issues?state=open&labels=milo:ready"),
    ).sort((a, b) => a.number - b.number)) {
      try {
        validateIssue(issue);
      } catch {
        continue;
      }
      if (category && issueCategory(issue) !== category) continue;
      if (await blocked(gh, issue)) {
        console.log(`#${issue.number} waits for an open blocking issue`);
        continue;
      }
      if (!(await trustedAuthor(gh, issue))) continue;
      if (await existingPr(gh, repo, issue.number)) continue;
      yield issue.number;
    }
  }
  async runReviews(repo: Repo): Promise<void> {
    for await (const [, job] of this.reviewJobs(repo)) {
      await job();
      break;
    }
  }
  // Merges what is ready on the way, and yields the agent step each remaining Milo PR needs.
  // PRs `busy` names are left alone: something is already working on them.
  private async *reviewJobs(
    repo: Repo,
    busy: (pr: PullRequest) => boolean = () => false,
  ): AsyncGenerator<[number, () => Promise<void>]> {
    const gh = this.context.github(repo);
    for (const pr of parse(
      z.array(PullRequest),
      await gh.pages("pulls?state=open"),
    )) {
      try {
        validatePR(pr, repo);
      } catch {
        continue;
      }
      if (busy(pr)) continue;
      const changeRequests = await requests(gh, pr.number, pr.head.sha);
      const step = nextReviewStep(
        pr.head.sha,
        changeRequests,
        await botComments(gh, pr),
      );
      if (step === "merge") await merge(gh, repo, pr);
      if (step === "merge" || step === "skip") continue;
      yield [
        pr.number,
        step === "revise"
          ? () =>
              this.attempt(gh, pr, changeRequests, () =>
                this.revise(repo, pr.number),
              )
          : step === "fix"
            ? () =>
                this.attempt(
                  gh,
                  pr,
                  [],
                  () => this.revise(repo, pr.number, true),
                  true,
                )
            : () =>
                this.attempt(gh, pr, [], () =>
                  this.review(repo, pr.number).then(() => true),
                ),
      ];
    }
  }
  // Local only (the action refuses it): a tick for one repo, built to fill its pipeline fast: every ready ticket, every PR's next
  // review step, and a scan of each category by each of `scanModels`, on up to `agents`
  // concurrent agents. Each job clones into its own folder. With `loop`, every finished job
  // triggers a fresh look, so a new PR's review starts as soon as a slot frees, and a scan that
  // filed something runs again; it ends when nothing is running and nothing is left to start.
  // Returns "job: reason" for each failure.
  async turbo(
    repo: Repo,
    {
      agents = 4,
      period = "week" as Period,
      loop = false,
      scanModels = ["claude-fable-5-1", "claude-sonnet-5-5"],
    } = {},
  ): Promise<string[]> {
    type Run = () => Promise<boolean>;
    const jobs = new Map<string, Run>();
    let state = initial;
    const dispatch = (event: Event) => {
      state = schedule(state, event);
    };
    const reason = (error: unknown) =>
      error instanceof Error ? error.message : "Unknown failure";
    // Keeps the first run for a key, as the schedule ignores a key it already holds.
    const found = (key: string, kind: "ready" | "scan", run: Run) => {
      if (!isActive(state, key)) jobs.set(key, run);
      dispatch({ type: "found", key, kind });
    };
    const discover = async () => {
      for await (const number of this.readyTickets(repo))
        found(ticketKey(number), "ready", () =>
          this.work(repo, number).then(() => false),
        );
      const busy = (pr: PullRequest) =>
        prBusy(state, pr.number, ticketNumber(pr.head.ref));
      for await (const [number, job] of this.reviewJobs(repo, busy))
        found(prKey(number), "ready", () => job().then(() => false));
    };
    // Shared labels first: concurrent category scans would race to create them.
    await this.plan({ ...repo, categories: [] }, true);
    await discover();
    // A scan that filed something may find more; one that found nothing is done this run.
    for (const category of repo.categories ?? categoryNames)
      found(`${category} scan`, "scan", async () => {
        const filed = await this.plan(
          { ...repo, categories: [category] },
          true,
          period,
          scanModels,
        );
        return loop && filed > 0;
      });
    const running = new Set<Promise<void>>();
    // Set when a job finishes, including during a look, so no job's changes go unseen.
    let changed = false;
    const start = (key: string, run: Run) => {
      dispatch({ type: "started", key });
      console.log(`Started ${key}`);
      const task: Promise<void> = run()
        .then(
          (again) => {
            console.log(`Finished ${key}`);
            dispatch({ type: "finished", key, again });
          },
          (error) => {
            dispatch({ type: "failed", key, reason: reason(error) });
            // Logged now as well as in the summary, so a watcher sees it while the run goes on.
            console.log(`Failed ${state.failures.at(-1)}`);
          },
        )
        .finally(() => {
          running.delete(task);
          changed = loop;
        });
      running.add(task);
    };
    for (;;) {
      for (
        let key = nextJob(state, agents, running.size);
        key;
        key = nextJob(state, agents, running.size)
      ) {
        const run = jobs.get(key);
        if (!run) throw new Error(`No job for ${key}`);
        start(key, run);
      }
      if (!running.size) break;
      await Promise.race(running);
      // Looks run one at a time, so two never merge the same PR.
      while (changed && !state.stopping) {
        changed = false;
        try {
          await discover();
        } catch (error) {
          dispatch({
            type: "lookFailed",
            failure: `look at ${repo.name}: ${reason(error)}`,
          });
        }
      }
    }
    return [...state.failures];
  }
  async tick(repo: Repo): Promise<void> {
    await this.runTasks(repo);
    await this.runReviews(repo);
  }
}
