import { z } from "zod";
import {
  type Category,
  type Config,
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
  validateIssue,
  validatePR,
} from "./rules.ts";
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
  plan(repo: Repo, apply = false, period: Period = "week"): Promise<void> {
    return plan(this.context, repo, apply, period);
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
      await this.work(repo, issue.number, category);
      break;
    }
    // Work first, so a failing scan cannot starve approved tickets.
    await this.plan(scoped, true, period);
  }
  async runReviews(repo: Repo): Promise<void> {
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
      const changeRequests = await requests(gh, pr.number, pr.head.sha);
      const step = nextReviewStep(
        pr.head.sha,
        changeRequests,
        await botComments(gh, pr),
      );
      if (step === "merge") await merge(gh, repo, pr);
      if (step === "merge" || step === "skip") continue;
      if (step === "revise")
        await this.attempt(gh, pr, changeRequests, () =>
          this.revise(repo, pr.number),
        );
      else if (step === "fix")
        await this.attempt(
          gh,
          pr,
          [],
          () => this.revise(repo, pr.number, true),
          true,
        );
      else
        await this.attempt(gh, pr, [], () =>
          this.review(repo, pr.number).then(() => true),
        );
      break;
    }
  }
  async tick(repo: Repo): Promise<void> {
    await this.runTasks(repo);
    await this.runReviews(repo);
  }
}
