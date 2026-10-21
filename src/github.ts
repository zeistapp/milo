import { z } from "zod";
import { type Argv, parse } from "./config.ts";
import { command } from "./process.ts";

// GitHub responses carry user-written text; parse the fields Milo reads rather than casting.
const User = z.object({ login: z.string() });
export const Link = z.object({ html_url: z.string() });
export const Issue = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  pull_request: z.unknown().optional(),
  html_url: z.string(),
  created_at: z.string(),
});
export type Issue = z.infer<typeof Issue>;
const Ref = z.object({ ref: z.string(), sha: z.string() });
export const PullRequest = z.object({
  number: z.number(),
  state: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  head: Ref.extend({
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: Ref,
});
export type PullRequest = z.infer<typeof PullRequest>;
export const Review = z.object({
  id: z.number(),
  state: z.string(),
  // Null when the commit was garbage collected, e.g. after a force-push.
  commit_id: z.string().nullable(),
  user: User.nullable(),
  body: z.string(),
});
export type Review = z.infer<typeof Review>;
export const Comment = z.object({
  body: z.string(),
  user: User.nullable(),
  pull_request_review_id: z.number().nullish(),
});
export interface GitHubClient {
  api(endpoint: string, method?: string, payload?: unknown): Promise<unknown>;
  pages(endpoint: string): Promise<unknown[]>;
  comment(number: number, body: string): Promise<void>;
  viewer(): Promise<string>;
}
export class GitHub implements GitHubClient {
  constructor(private repo: string) {}
  async api(
    endpoint: string,
    method = "GET",
    payload?: unknown,
  ): Promise<unknown> {
    const args: Argv = [
      "gh",
      "api",
      `repos/${this.repo}/${endpoint}`,
      "--method",
      method,
    ];
    if (payload !== undefined) args.push("--input", "-");
    const output = await command(args, {
      input: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (!output) throw new Error("GitHub returned an empty response");
    return JSON.parse(output);
  }
  async pages(endpoint: string): Promise<unknown[]> {
    const separator = endpoint.includes("?") ? "&" : "?";
    const output = await command([
      "gh",
      "api",
      `repos/${this.repo}/${endpoint}${separator}per_page=100`,
      "--paginate",
      "--slurp",
    ]);
    return parse(z.array(z.array(z.unknown())), JSON.parse(output)).flat();
  }
  async comment(number: number, body: string): Promise<void> {
    await this.api(`issues/${number}/comments`, "POST", { body });
  }
  async viewer(): Promise<string> {
    return (
      appLogin() ??
      parse(User, JSON.parse(await command(["gh", "api", "user"]))).login
    );
  }
}
// An App installation token can't read GET /user, so the workflow passes the App's slug.
const appLogin = () =>
  process.env.MILO_APP_SLUG ? `${process.env.MILO_APP_SLUG}[bot]` : undefined;
// Commits show as the App's bot when Milo runs as an App, as github-actions[bot] otherwise.
export async function author(): Promise<[name: string, email: string]> {
  const login = appLogin();
  if (!login)
    return [
      "github-actions[bot]",
      "41898282+github-actions[bot]@users.noreply.github.com",
    ];
  const { id } = parse(
    z.object({ id: z.number() }),
    JSON.parse(
      await command(["gh", "api", `users/${encodeURIComponent(login)}`]),
    ),
  );
  return [login, `${id}+${login}@users.noreply.github.com`];
}
