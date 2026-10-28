import { join } from "node:path";
import { z } from "zod";
import type { Agent, Argv } from "./config.ts";
import {
  agentCredentials,
  CommandError,
  command,
  keptLog,
  sandboxEnv,
  secretDirs,
} from "./process.ts";

// Required CLI floor for restricted mode and fail-closed shell sandbox settings.
export const minimumClaudeVersion = "2.1.296";
// Denials only label the failure, so a malformed one becomes "unknown tool" instead of hiding it.
const Denial = z
  .object({
    tool_name: z.string().catch(""),
    tool_input: z.object({ command: z.string() }).optional().catch(undefined),
  })
  .catch({ tool_name: "" });
const Result = z.object({
  type: z.literal("result"),
  subtype: z.literal("success"),
  is_error: z.literal(false),
  result: z.string(),
  permission_denials: z.array(Denial).catch([]),
});
// Any result, successful or not, for its cost and the reason it stopped.
const Outcome = z
  .object({
    subtype: z.string().catch(""),
    result: z.string().catch(""),
    total_cost_usd: z.number().optional().catch(undefined),
    num_turns: z.number().optional().catch(undefined),
  })
  .catch({ subtype: "", result: "" });
// Fixed labels only: Claude's error text can quote the prompt or repository.
const reasons: [RegExp, string][] = [
  [/credit balance/i, "API credit balance is too low"],
  [/api key|authentication|\b401\b/i, "API key was rejected"],
  [/usage limit|rate limit|\b429\b/i, "API rate or usage limit reached"],
  [/overloaded|\b529\b/i, "API is overloaded"],
  [/prompt is too long/i, "prompt is too long"],
];
function stopReason({ subtype, result }: z.infer<typeof Outcome>): string {
  const label =
    reasons.find(([pattern]) => pattern.test(result))?.[1] ??
    (/^error_[a-z_]+$/.test(subtype) ? subtype : undefined);
  return label ? `: ${label}` : "";
}

type Flags = Pick<Agent, "model" | "effort" | "maxBudgetUsd">;
export function claudeCommand(
  root: string,
  home: string,
  readOnly: boolean,
  { model, effort, maxBudgetUsd }: Flags = {},
): Argv {
  // Read-only runs keep a sandboxed shell for searching, git history and registry lookups.
  const tools = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Bash"];
  if (!readOnly) tools.push("Edit", "Write");
  const settings = {
    env: { DISABLE_UPDATES: "1" },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      credentials: {
        envVars: agentCredentials.map((name) => ({ name, mode: "deny" })),
      },
      filesystem: {
        allowWrite: [home],
        denyWrite: readOnly
          ? [root]
          : [join(root, ".git"), join(root, ".github"), join(root, ".milo")],
        denyRead: secretDirs.map((dir) => `~/${dir}`),
      },
      network: { allowedDomains: ["registry.npmjs.org"] },
    },
  };
  return [
    "claude",
    "--bare",
    "--restricted",
    "--print",
    // Bare mode skips CLAUDE.md discovery; --add-dir restores it for the repository.
    "--add-dir",
    root,
    "--no-session-persistence",
    "--disable-slash-commands",
    "--no-chrome",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--permission-prompts",
    "none",
    "--permission-mode",
    readOnly ? "dontAsk" : "acceptEdits",
    "--tools",
    tools.join(","),
    "--allowedTools",
    tools.join(","),
    "--settings",
    JSON.stringify(settings),
    "--output-format",
    "json",
    ...(effort ? ["--effort", effort] : []),
    ...(maxBudgetUsd ? ["--max-budget-usd", String(maxBudgetUsd)] : []),
    ...(model ? ["--model", model] : []),
  ];
}

export async function runClaude(
  root: string,
  home: string,
  input: string,
  readOnly: boolean,
  flags: Flags = {},
  timeoutSeconds = 1800,
): Promise<string> {
  const options = {
    cwd: root,
    trusted: false,
    keepAgentCredentials: true,
    timeoutSeconds,
  };
  const version = await command(["claude", "--version"], options);
  const match = /^\d+\.\d+\.\d+\b/.exec(version);
  if (!match || Bun.semver.order(match[0], minimumClaudeVersion) < 0)
    throw new Error(`Claude Code ${minimumClaudeVersion}+ is required`);
  // Tools such as Wrangler write through XDG paths, which GitHub's runners point at the
  // read-only real home. HOME stays: Claude reads its config through it, and denyRead's ~
  // paths must keep meaning the real home. The XDG paths match the steps', so the agent
  // finds what setup installed, such as Playwright's browsers.
  const { HOME: _, ...paths } = sandboxEnv(home);
  // Claude exits 1 on API errors but still prints its JSON result, which says why.
  let failure: CommandError | undefined;
  const stdout = await command(claudeCommand(root, home, readOnly, flags), {
    ...options,
    input,
    // Claude may ignore CLAUDE.md in --add-dir directories without this flag.
    env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1", ...paths },
    logFile: keptLog("claude"),
  }).catch((error) => {
    if (!(error instanceof CommandError)) throw error;
    failure = error;
    return error.stdout;
  });
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw failure ?? new Error("Claude returned invalid JSON");
  }
  const outcome = Outcome.parse(json);
  if (outcome.total_cost_usd !== undefined)
    console.log(
      `Claude cost $${outcome.total_cost_usd.toFixed(2)} over ${outcome.num_turns ?? "?"} turns`,
    );
  const response = Result.safeParse(json);
  if (failure || !response.success)
    throw new Error(
      `Claude did not complete successfully${stopReason(outcome)}`,
    );
  const { result, permission_denials: denials } = response.data;
  if (denials.length) {
    // Report only fixed labels, never agent-supplied arguments, paths or secrets.
    const details = new Set(
      denials.map(({ tool_name, tool_input }) => {
        const tool = [
          "Bash",
          "Read",
          "Edit",
          "Write",
          "Glob",
          "Grep",
          "WebFetch",
          "WebSearch",
        ].find((name) => tool_name === name);
        if (!tool) return "unknown tool";
        const value = tool_input?.command;
        if (tool !== "Bash" || value === undefined) return tool;
        const operation = [
          "bun outdated",
          "bun install",
          "bun test",
          "bun run",
          "npm",
          "git status",
          "git diff",
          "git add",
          "git commit",
          "curl",
        ].find((name) => value.includes(name));
        return operation ? `${tool} (${operation})` : tool;
      }),
    );
    throw new Error(
      `Claude encountered denied permissions: ${[...details].join(", ")}; task needs human attention`,
    );
  }
  return result;
}
