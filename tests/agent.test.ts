import { expect, test } from "bun:test";
import { chmod, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { claudeCommand, minimumClaudeVersion } from "../src/claude.ts";
import { includeSelfRepo, parseConfig } from "../src/config.ts";
import { sandboxEnv, temporary, workHome } from "../src/process.ts";
import { ScanResult } from "../src/rules.ts";
import { runAgent } from "../src/runner.ts";

test("provider configuration validates model selection and preserves custom agents", () => {
  const repos = [{ name: "owner/repo" }];
  const config = parseConfig({
    agent: { provider: "claude", model: "exact-model-20261014" },
    repos,
  });
  expect(includeSelfRepo(config, "owner/milo").agent).toEqual(config.agent);
  expect(
    parseConfig({ agent: { provider: "claude" }, repos }).agent.model,
  ).toBeUndefined();
  for (const agent of [
    { provider: "unknown" },
    { provider: "claude", command: ["cli", "{output}"] },
    ...["", "--help", "model with spaces", 12, null].map((model) => ({
      provider: "claude",
      model,
    })),
    { command: ["cli", "{output}"], model: "model" },
    { command: ["cli", "{output}"], scanModel: "model" },
    { provider: "claude", scanModel: "--help" },
    { command: ["cli", "{output}"], reviewModel: "model" },
    { provider: "claude", reviewModel: "--help" },
    { provider: "claude", effort: "extreme" },
    ...[0, -1, "5"].map((maxBudgetUsd) => ({
      provider: "claude",
      maxBudgetUsd,
    })),
    { command: ["cli", "{output}"], effort: "low" },
    { command: ["cli", "{output}"], maxBudgetUsd: 1 },
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
  const editing = claudeCommand("/repo", "/scratch", false, {
    model: "exact-model",
    effort: "medium",
    maxBudgetUsd: 2.5,
  });
  expect(editing.slice(-6)).toEqual([
    "--effort",
    "medium",
    "--max-budget-usd",
    "2.5",
    "--model",
    "exact-model",
  ]);
  expect(readonly).not.toContain("--effort");
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
  temporary("milo-agents-", async (folder) => {
    const root = join(folder, "repo");
    await mkdir(root);
    const script = `#!${process.execPath}
const args = Bun.argv.slice(2);
if (args.includes('--version')) { console.log(process.env.MILO_TEST_VERSION ?? '${minimumClaudeVersion} (Claude Code)'); process.exit(0); }
const input = await Bun.stdin.text();
await Bun.write('invocation.json', JSON.stringify({args,input,github:process.env.GH_TOKEN,anthropic:process.env.ANTHROPIC_API_KEY,claudeMd:process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD,home:process.env.HOME,paths:['TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME'].map((key)=>process.env[key]),settings:args[args.indexOf('--settings')+1]}));
if (args[0] === 'exec') await Bun.write(args[args.indexOf('--output-last-message')+1], 'Custom report');
else if (process.env.MILO_TEST_RESULT === 'exit') process.exit(1);
else console.log(process.env.MILO_TEST_RESULT ?? JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Claude report'}));
process.exit(Number(process.env.MILO_TEST_EXIT ?? 0));
`;
    for (const name of ["claude", "agent"]) {
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
      "MILO_TEST_EXIT",
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
          agent: {
            provider,
            model: "exact-model",
            scanModel: "scan-model",
            reviewModel: "review-model",
          },
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
      // The agent sees the steps' home, so it finds what setup installed there.
      const home = join(await realpath(folder), "home");
      expect(await workHome(root)).toBe(home);
      const { HOME, ...paths } = sandboxEnv(home);
      expect(invocation.paths).toEqual(Object.values(paths));
      expect(invocation.home).toBe(process.env.HOME);
      expect(
        JSON.parse(invocation.settings).sandbox.filesystem.allowWrite,
      ).toEqual([home]);
      // Unconfigured effort and budget default to medium and $5 per call.
      expect(invocation.args.slice(-6)).toEqual([
        "--effort",
        "medium",
        "--max-budget-usd",
        "5",
        "--model",
        "exact-model",
      ]);
      // Scans use scanModel at the CLI's default effort, still under the budget.
      await runAgent(config("claude"), root, "Scan this", true, "scan");
      expect(
        (await Bun.file(join(root, "invocation.json")).json()).args.slice(-4),
      ).toEqual(["--max-budget-usd", "5", "--model", "scan-model"]);
      // PR reviews use reviewModel at the configured effort; without it, they use model.
      const lastModel = async () =>
        (await Bun.file(join(root, "invocation.json")).json()).args.at(-1);
      await runAgent(config("claude"), root, "Review", true, "review");
      expect(await lastModel()).toBe("review-model");
      const { reviewModel: _, ...agent } = config("claude").agent;
      await runAgent(
        { ...config("claude"), agent },
        root,
        "Review",
        true,
        "review",
      );
      expect(await lastModel()).toBe("exact-model");
      expect(await runAgent(config("claude"), root, "Edit this")).toBe(
        "Claude report",
      );
      const custom = parseConfig({
        agent: {
          command: [
            join(root, "agent"),
            "exec",
            "--sandbox",
            "{sandbox}",
            "--output-last-message",
            "{output}",
          ],
        },
        repos: [{ name: "owner/repo" }],
      });
      expect(await runAgent(custom, root, "Edit this")).toBe("Custom report");
      expect(
        (await Bun.file(join(root, "invocation.json")).json()).args,
      ).toContain("workspace-write");
      // With a schema, Claude gets --json-schema and Milo validates its structured output.
      const success = { type: "result", subtype: "success", is_error: false };
      const clean = { clean: true, title: "", body: "" };
      process.env.MILO_TEST_RESULT = JSON.stringify({
        ...success,
        result: "ignored",
        structured_output: clean,
      });
      expect(
        await runAgent(
          config("claude"),
          root,
          "Scan",
          true,
          "scan",
          ScanResult,
        ),
      ).toEqual(clean);
      const { args } = await Bun.file(join(root, "invocation.json")).json();
      expect(JSON.parse(args[args.indexOf("--json-schema") + 1])).toMatchObject(
        {
          $schema: "http://json-schema.org/draft-07/schema#",
          required: ["clean", "title", "body"],
        },
      );
      // Claude repairs invalid output in-session; once it gives up, the run fails with its label.
      process.env.MILO_TEST_RESULT = JSON.stringify({
        type: "result",
        subtype: "error_max_structured_output_retries",
        is_error: true,
      });
      await expect(
        runAgent(config("claude"), root, "Scan", true, "scan", ScanResult),
      ).rejects.toThrow("error_max_structured_output_retries");
      process.env.MILO_TEST_RESULT = JSON.stringify({
        ...success,
        result: "",
        structured_output: { ...clean, clean: "yes" },
      });
      await expect(
        runAgent(config("claude"), root, "Scan", true, "scan", ScanResult),
      ).rejects.toThrow("clean");
      delete process.env.MILO_TEST_RESULT;
      // A custom agent gets the schema's path and must write matching JSON.
      const schemaArgs = parseConfig({
        agent: {
          command: [
            join(root, "agent"),
            "exec",
            "{schema}",
            "--output-last-message",
            "{output}",
          ],
        },
        repos: [{ name: "owner/repo" }],
      });
      await expect(
        runAgent(schemaArgs, root, "Scan", true, "scan", ScanResult),
      ).rejects.toThrow("not JSON");
      expect(
        (await Bun.file(join(root, "invocation.json")).json()).args[1],
      ).toEndWith("schema.json");
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
      // An API error exits 1 with a JSON result; report a fixed label, not Claude's text.
      process.env.MILO_TEST_EXIT = "1";
      process.env.MILO_TEST_RESULT = JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Credit balance is too low PRIVATE_DONT_LOG",
        total_cost_usd: 0,
      });
      const failure = runAgent(config("claude"), root, "test");
      await expect(failure).rejects.toThrow("API credit balance is too low");
      await expect(failure).rejects.not.toThrow("PRIVATE_DONT_LOG");
      process.env.MILO_TEST_RESULT = JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
      });
      await expect(runAgent(config("claude"), root, "test")).rejects.toThrow(
        "did not complete successfully: error_max_turns",
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }));
