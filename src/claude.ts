import { join } from "node:path";
import type { Argv } from "./config.ts";
import { command } from "./process.ts";

// Required CLI floor for restricted mode and fail-closed shell sandbox settings.
export const minimumClaudeVersion = "2.1.296";

export function claudeCommand(
  root: string,
  readOnly: boolean,
  model?: string,
): Argv {
  const tools = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];
  if (!readOnly) tools.push("Edit", "Write", "Bash");
  const settings = {
    env: { DISABLE_UPDATES: "1" },
    sandbox: {
      enabled: !readOnly,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      credentials: {
        envVars: [
          "ANTHROPIC_API_KEY",
          "CODEX_API_KEY",
          "OPENAI_API_KEY",
          "AZURE_OPENAI_API_KEY",
          "CLAUDE_CODE_OAUTH_TOKEN",
        ].map((name) => ({ name, mode: "deny" })),
      },
      filesystem: {
        denyWrite: [
          join(root, ".git"),
          join(root, ".github"),
          join(root, ".milo"),
        ],
        denyRead: ["~/.ssh", "~/.aws", "~/.config/gh", "~/.codex", "~/.claude"],
      },
      network: { allowedDomains: ["registry.npmjs.org"] },
    },
  };
  return [
    "claude",
    "--bare",
    "--restricted",
    "--print",
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
  const match = /^(\d+)\.(\d+)\.(\d+)\b/.exec(version);
  if (
    !match ||
    Number(match[1]) < 2 ||
    (Number(match[1]) === 2 &&
      (Number(match[2]) < 1 ||
        (Number(match[2]) === 1 && Number(match[3]) < 296)))
  )
    throw new Error(`Claude Code ${minimumClaudeVersion}+ is required`);
  const stdout = await command(claudeCommand(root, readOnly, model), {
    ...options,
    input,
  });
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("Claude returned invalid JSON");
  }
  if (!result || typeof result !== "object")
    throw new Error("Claude returned an invalid result");
  const response = result as Record<string, unknown>;
  if (
    response.type !== "result" ||
    response.subtype !== "success" ||
    response.is_error !== false ||
    typeof response.result !== "string"
  )
    throw new Error("Claude did not complete successfully");
  if (
    Array.isArray(response.permission_denials) &&
    response.permission_denials.length
  ) {
    // Report only fixed labels, never agent-supplied arguments, paths or secrets.
    const details = new Set(
      response.permission_denials.map((denial: unknown) => {
        if (!denial || typeof denial !== "object") return "unknown tool";
        const item = denial as Record<string, unknown>;
        const tool = [
          "Bash",
          "Read",
          "Edit",
          "Write",
          "Glob",
          "Grep",
          "WebFetch",
          "WebSearch",
        ].find((name) => item.tool_name === name);
        if (!tool) return "unknown tool";
        const input = item.tool_input;
        if (tool !== "Bash" || !input || typeof input !== "object") return tool;
        const value = (input as Record<string, unknown>).command;
        if (typeof value !== "string") return tool;
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
  return response.result;
}
