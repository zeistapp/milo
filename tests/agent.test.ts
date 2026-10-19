import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claudeCommand, minimumClaudeVersion } from "../src/claude.ts";
import { includeSelfRepo, parseConfig } from "../src/config.ts";
import { sandboxEnv, temporary } from "../src/process.ts";
import { runAgent } from "../src/runner.ts";

test("provider configuration validates model selection and preserves custom agents", () => {
  const repos = [{ name: "owner/repo" }];
  for (const provider of ["claude", "codex"]) {
    const config = parseConfig({
      agent: { provider, model: "exact-model-20261014" },
      repos,
    });
    expect(includeSelfRepo(config, "owner/milo").agent).toEqual(config.agent);
    expect(
      parseConfig({ agent: { provider }, repos }).agent.model,
    ).toBeUndefined();
  }
  for (const agent of [
    { provider: "unknown" },
    { provider: "claude", command: ["cli", "{output}"] },
    ...["", "--help", "model with spaces", 12, null].map((model) => ({
      provider: "codex",
      model,
    })),
    { command: ["cli", "{output}"], model: "model" },
  ])
    expect(() => parseConfig({ agent, repos })).toThrow();
  expect(
    parseConfig({ agent: { command: ["cli", "{output}"] }, repos }).agent
      .command,
  ).toEqual(["cli", "{output}"]);
});

test("Claude reviews get a sandboxed shell but no writes; edits require a shell sandbox", () => {
  const readonly = claudeCommand("/repo", "/scratch", true);
  expect(readonly[readonly.indexOf("--tools") + 1]).toBe(
    "Read,Glob,Grep,WebFetch,WebSearch,Bash",
  );
  const readonlySettings = JSON.parse(
    readonly[readonly.indexOf("--settings") + 1] ?? "{}",
  );
  expect(readonlySettings.sandbox.enabled).toBe(true);
  expect(readonlySettings.sandbox.filesystem.denyWrite).toEqual(["/repo"]);
  expect(readonlySettings.sandbox.filesystem.allowWrite).toEqual(["/scratch"]);
  const editing = claudeCommand("/repo", "/scratch", false, "exact-model");
  expect(editing.slice(-2)).toEqual(["--model", "exact-model"]);
  expect(editing[editing.indexOf("--allowedTools") + 1]).toContain("Bash");
  expect(readonly[readonly.indexOf("--allowedTools") + 1]).not.toContain(
    "Edit",
  );
  expect(editing).not.toContain("--dangerously-skip-permissions");
  expect(editing).toContain("--restricted");
  for (const argv of [readonly, editing])
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe("/repo");
  const settings = JSON.parse(
    editing[editing.indexOf("--settings") + 1] ?? "{}",
  );
  expect(settings.sandbox).toMatchObject({
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    excludedCommands: [],
  });
  expect(settings.sandbox.filesystem.denyWrite).toContain("/repo/.git");
  expect(settings.sandbox.credentials.envVars).toContainEqual({
    name: "ANTHROPIC_API_KEY",
    mode: "deny",
  });
});

test("provider subprocesses forward prompts and models, save reports and reject incomplete runs", () =>
  temporary("milo-agents-", async (root) => {
    const script = `#!${process.execPath}
const args = Bun.argv.slice(2);
if (args.includes('--version')) { console.log(process.env.MILO_TEST_VERSION ?? '${minimumClaudeVersion} (Claude Code)'); process.exit(0); }
const input = await Bun.stdin.text();
await Bun.write('invocation.json', JSON.stringify({args,input,github:process.env.GH_TOKEN,anthropic:process.env.ANTHROPIC_API_KEY,claudeMd:process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD,home:process.env.HOME,paths:['TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME'].map((key)=>process.env[key]),settings:args[args.indexOf('--settings')+1]}));
if (args[0] === 'exec') await Bun.write(args[args.indexOf('--output-last-message')+1], 'Codex report');
else if (process.env.MILO_TEST_RESULT === 'exit') process.exit(1);
else console.log(process.env.MILO_TEST_RESULT ?? JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Claude report'}));
`;
    for (const name of ["claude", "codex"]) {
      const path = join(root, name);
      await Bun.write(path, script);
      await chmod(path, 0o700);
    }
    const keys = [
      "PATH",
      "GH_TOKEN",
      "ANTHROPIC_API_KEY",
      "MILO_TEST_VERSION",
      "MILO_TEST_RESULT",
    ];
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );
    try {
      process.env.PATH = `${root}:${process.env.PATH}`;
      process.env.GH_TOKEN = "fake-github-secret";
      process.env.ANTHROPIC_API_KEY = "fake-anthropic-secret";
      const config = (provider: string) =>
        parseConfig({
          agent: { provider, model: "exact-model" },
          repos: [{ name: "owner/repo" }],
        });
      expect(await runAgent(config("claude"), root, "Review this", true)).toBe(
        "Claude report",
      );
      const invocation = await Bun.file(join(root, "invocation.json")).json();
      expect(invocation.input).toContain("Review this");
      expect(invocation.input).toContain("Do not commit");
      expect(invocation.input).toContain(
        "read the repository root AGENTS.md and CLAUDE.md",
      );
      expect(invocation.input).toContain(
        "senior full-stack engineer who reviews this repository every day",
      );
      expect(invocation.github).toBeUndefined();
      expect(invocation.anthropic).toBe("fake-anthropic-secret");
      expect(invocation.claudeMd).toBe("1");
      // Compare paths, not prefixes: Milo's own step sandbox puts TMPDIR inside HOME.
      const home = dirname(invocation.paths[1]);
      const { HOME, ...paths } = sandboxEnv(home);
      expect(invocation.paths).toEqual(Object.values(paths));
      expect(invocation.home).toBe(process.env.HOME);
      expect([process.env.HOME, root]).not.toContain(home);
      expect(
        JSON.parse(invocation.settings).sandbox.filesystem.allowWrite,
      ).toEqual([home]);
      expect(existsSync(home)).toBeFalse();
      expect(invocation.args.slice(-2)).toEqual(["--model", "exact-model"]);
      expect(await runAgent(config("claude"), root, "Edit this")).toBe(
        "Claude report",
      );
      expect(await runAgent(config("codex"), root, "Edit this")).toBe(
        "Codex report",
      );
      const codex = await Bun.file(join(root, "invocation.json")).json();
      expect(codex.args).toContain("workspace-write");
      expect(codex.args).toContain("exact-model");
      // The default fake version above is exactly the floor and was accepted.
      const [major = 0, minor = 0, patch = 0] = minimumClaudeVersion
        .split(".")
        .map(Number);
      const below = patch
        ? `${major}.${minor}.${patch - 1}`
        : minor
          ? `${major}.${minor - 1}.999`
          : `${major - 1}.999.999`;
      expect(Bun.semver.order(below, minimumClaudeVersion)).toBe(-1);
      process.env.MILO_TEST_VERSION = `${below} (Claude Code)`;
      await expect(runAgent(config("claude"), root, "test")).rejects.toThrow(
        `${minimumClaudeVersion}+`,
      );
      delete process.env.MILO_TEST_VERSION;
      for (const [result, error] of [
        ["not JSON", "invalid JSON"],
        [
          JSON.stringify({
            type: "result",
            subtype: "error_max_turns",
            is_error: true,
          }),
          "did not complete",
        ],
        [
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "partial",
            permission_denials: [{}],
          }),
          "denied permissions",
        ],
        [
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: " ",
          }),
          "empty",
        ],
        [
          JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "a".repeat(50_001),
          }),
          "too large",
        ],
        ["exit", "failed"],
      ]) {
        process.env.MILO_TEST_RESULT = result;
        await expect(runAgent(config("claude"), root, "test")).rejects.toThrow(
          error,
        );
      }
      process.env.MILO_TEST_RESULT = JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "partial",
        permission_denials: [
          {
            tool_name: "Bash",
            tool_input: { command: "bun outdated PRIVATE_DONT_LOG" },
          },
        ],
      });
      await expect(runAgent(config("claude"), root, "test")).rejects.toThrow(
        "Bash (bun outdated)",
      );
      await expect(
        runAgent(config("claude"), root, "test"),
      ).rejects.not.toThrow("PRIVATE_DONT_LOG");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }));
