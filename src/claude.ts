import { join } from "node:path";
import { z } from "zod";
import type { Argv } from "./config.ts";
import {
  agentCredentials,
  command,
  sandboxEnv,
  secretDirs,
  temporary,
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

export function claudeCommand(
  root: string,
  home: string,
  readOnly: boolean,
  model?: string,
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
    ...(model ? ["--model", model] : []),
  ];
}

export async function runClaude(
  root: string,
  input: string,
  readOnly: boolean,
  model?: string,
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
  // paths must keep meaning the real home.
  const stdout = await temporary("milo-claude-", (home) => {
    const { HOME: _, ...paths } = sandboxEnv(home);
    return command(claudeCommand(root, home, readOnly, model), {
      ...options,
      input,
      // Claude may ignore CLAUDE.md in --add-dir directories without this flag.
      env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1", ...paths },
    });
  });
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error("Claude returned invalid JSON");
  }
  const response = Result.safeParse(json);
  if (!response.success)
    throw new Error("Claude did not complete successfully");
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
