import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { GitHubClient, Issue } from "../src/github.ts";
import { confine } from "../src/process.ts";

// macOS refuses some sandbox profiles inside a sandbox, Milo's among them, so tests that start
// Milo's sandbox cannot run under Milo's own checks there. Linux CI still runs them.
const probe = realpathSync(mkdtempSync(`${tmpdir()}/milo-probe-`));
export const nestedSandboxDenied =
  process.platform === "darwin" &&
  Bun.spawnSync(confine(["true"], probe, probe, probe)).exitCode !== 0;
rmSync(probe, { recursive: true });

// A GitHub client whose unstubbed calls fail, so a test states every request it expects.
export function github(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    async api(endpoint) {
      throw new Error(`Unexpected api call: ${endpoint}`);
    },
    async pages(endpoint) {
      throw new Error(`Unexpected pages call: ${endpoint}`);
    },
    async comment(number) {
      throw new Error(`Unexpected comment on #${number}`);
    },
    async viewer() {
      return "milo";
    },
    ...overrides,
  };
}

export function issue(body = "", state = "open"): Issue {
  return {
    number: 12,
    title: "Maintenance",
    body,
    state,
    html_url: "https://example.test/issue/12",
    created_at: "2026-10-15T09:00:00Z",
    labels: [{ name: "milo:task" }, { name: "milo:ready" }],
    user: { login: "milo" },
  };
}

// Sets `vars` for the duration of `fn`; `undefined` deletes a key. Every key is restored after,
// so list keys `fn` changes too.
export async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
  const previous = Object.fromEntries(
    Object.keys(vars).map((key) => [key, process.env[key]]),
  );
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(previous);
  }
}
