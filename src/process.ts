import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { Argv } from "./config.ts";

export interface CommandOptions {
  cwd?: string;
  input?: string;
  timeoutSeconds?: number;
  trusted?: boolean;
  keepAgentCredentials?: boolean;
  logFile?: string;
  env?: Record<string, string>;
}
export async function command(
  argv: Argv,
  options: CommandOptions = {},
): Promise<string> {
  const env = { ...process.env, ...options.env };
  if (options.trusted === false) {
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "ACTIONS_RUNTIME_TOKEN",
    ])
      delete env[key];
    if (!options.keepAgentCredentials) {
      for (const key of [
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "AZURE_OPENAI_API_KEY",
      ])
        delete env[key];
    }
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "credential.helper";
    env.GIT_CONFIG_VALUE_0 = "";
  }
  return new Promise((resolve, reject) => {
    const log = options.logFile
      ? openSync(options.logFile, "w", 0o600)
      : undefined;
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env,
      detached: true,
      stdio: "pipe",
    });
    let stdout = "";
    let failure: Error | undefined;
    const writeLog = (chunk: string | Buffer) => {
      if (log === undefined) return;
      try {
        if (typeof chunk === "string") writeSync(log, chunk);
        else writeSync(log, chunk);
      } catch {
        failure = new Error("Cannot write command log");
        kill();
      }
    };
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    };
    const timer = setTimeout(
      () => {
        failure = new Error(`Timed out: ${argv[0]}`);
        kill();
      },
      (options.timeoutSeconds ?? 120) * 1000,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      writeLog(chunk);
      stdout += chunk;
      if (stdout.length > 16_000_000) {
        failure = new Error(`${argv[0]} output exceeds 16 MB`);
        kill();
      }
    });
    // Drain stderr without echoing possible tokens or private source into CI logs.
    if (log === undefined) child.stderr.resume();
    else child.stderr.on("data", writeLog);
    child.stdin.on("error", () => {
      /* Early process exit is handled below. */
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Cannot start ${argv[0]}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (log !== undefined) closeSync(log);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            `${argv[0]} failed (exit ${code}); reproduce this configured command locally`,
          ),
        );
      else resolve(stdout.trim());
    });
    child.stdin.end(options.input ?? "");
  });
}
export async function temporary<T>(
  prefix: string,
  work: (folder: string) => Promise<T>,
): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await work(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
export async function inside(root: string, child = "."): Promise<string> {
  const base = await realpath(root);
  const path = await realpath(join(base, child));
  const rel = relative(base, path);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new Error("Command directory escapes the repository");
  return path;
}
