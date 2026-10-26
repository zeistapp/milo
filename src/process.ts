import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Argv, Step } from "./config.ts";

// Both sandboxes (untrusted steps here, the agent's shell in claude.ts) hide these.
export const agentCredentials = [
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AZURE_OPENAI_API_KEY",
] as const;
// Relative to the home directory.
export const secretDirs = [
  ".ssh",
  ".aws",
  ".config/gh",
  ".codex",
  ".claude",
] as const;
export interface CommandOptions {
  cwd?: string;
  input?: string;
  timeoutSeconds?: number;
  trusted?: boolean;
  keepAgentCredentials?: boolean;
  logFile?: string;
  env?: Record<string, string>;
  // Names the command in errors when argv[0] is a wrapper such as the sandbox.
  label?: string;
}
// Keeps stdout so callers can read a structured failure, such as Claude's JSON result.
export class CommandError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
  ) {
    super(message);
  }
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
      for (const key of agentCredentials) delete env[key];
    }
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "credential.helper";
    env.GIT_CONFIG_VALUE_0 = "";
  }
  const name = options.label ?? argv[0];
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
        failure = new Error(`Timed out: ${name}`);
        kill();
      },
      (options.timeoutSeconds ?? 120) * 1000,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      writeLog(chunk);
      stdout += chunk;
      if (stdout.length > 16_000_000) {
        failure = new Error(`${name} output exceeds 16 MB`);
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
          new CommandError(
            `${name} failed (exit ${code}); reproduce this configured command locally`,
            stdout.trim(),
          ),
        );
      else resolve(stdout.trim());
    });
    child.stdin.end(options.input ?? "");
  });
}
// Runs untrusted repository code with no view of other processes' environments, so it
// cannot read Milo's tokens, and with writes limited to the clone (not .git), a scratch
// home (also its temp folder) and /tmp. On Linux, processes left behind die with the step.
// Paths must be real paths: the macOS sandbox matches resolved paths.
// CEILING: macOS has no process namespace, so leftover processes outlive the step, still confined.
export function confine(
  argv: Argv,
  root: string,
  home: string,
  cwd: string,
): Argv {
  const secrets = secretDirs.map((dir) => join(homedir(), dir));
  if (process.platform === "linux")
    return [
      "bwrap",
      "--die-with-parent",
      "--new-session",
      "--unshare-pid",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--bind",
      root,
      root,
      // A local check may target a folder that is not a clone.
      ...(existsSync(join(root, ".git"))
        ? ["--ro-bind", join(root, ".git"), join(root, ".git")]
        : []),
      "--bind",
      home,
      home,
      ...secrets.filter(existsSync).flatMap((dir) => ["--tmpfs", dir]),
      "--chdir",
      cwd,
      "--",
      ...argv,
    ];
  if (process.platform === "darwin") {
    // Seatbelt also blocks setuid programs such as ps, which can read other processes' environments.
    const paths = (...dirs: string[]) =>
      dirs.map((dir) => `(subpath ${JSON.stringify(dir)})`).join(" ");
    return [
      "sandbox-exec",
      "-p",
      "(version 1)(allow default)(deny file-write*)" +
        `(allow file-write* ${paths(root, home, "/private/tmp", "/dev")})` +
        `(deny file-write* ${paths(join(root, ".git"))})` +
        `(deny file-read* ${paths(...secrets)})`,
      ...argv,
    ];
  }
  throw new Error("Untrusted steps need a Linux or macOS sandbox");
}
// Tools look up config and caches through XDG paths before HOME, and GitHub's runners point
// those at the real home, which the sandbox makes read-only.
export function sandboxEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    TMPDIR: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
  };
}
// The action sets MILO_LOG_DIR on private repos and uploads it when a run fails, since
// CI logs never show step output or agent reports.
let kept = 0;
export function keptLog(name: string): string | undefined {
  const dir = process.env.MILO_LOG_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const slug = name.replace(/[^\w.-]+/g, "-").slice(0, 60);
  return join(dir, `${String(++kept).padStart(3, "0")}-${slug}.log`);
}
// The action sets MILO_APT_ARCHIVES on Linux runners, its cached .deb folder. Local runs install nothing.
// The config schema allows only Debian package names, so none can pass as an apt option.
export async function installPackages(packages: string[] = []): Promise<void> {
  const archives = process.env.MILO_APT_ARCHIVES;
  if (!archives || !packages.length) return;
  const started = performance.now();
  await command(
    [
      "sudo",
      "apt-get",
      "install",
      "--yes",
      "--no-install-recommends",
      "-o",
      `Dir::Cache::Archives=${archives}`,
      ...packages,
    ],
    { timeoutSeconds: 1800, label: "apt-get install" },
  );
  const seconds = (performance.now() - started) / 1000;
  console.log(
    `systemPackages ${JSON.stringify(packages)} took ${seconds.toFixed(1)} s`,
  );
}
// Runs a setup or check step in the sandbox. root and home must be real paths.
export async function sandboxed(
  step: Step,
  root: string,
  home: string,
  logFile?: string,
): Promise<string> {
  const cwd = await inside(root, step.cwd);
  const label = `${step.cwd ?? "."}: ${step.command.join(" ")}`;
  return command(confine(step.command, root, home, cwd), {
    cwd,
    trusted: false,
    timeoutSeconds: 900,
    env: sandboxEnv(home),
    label,
    logFile: logFile ?? keptLog(label),
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
// Setup, checks and the agent share this home beside the clone, so what setup installs into
// caches (package downloads, Playwright's browsers) is there for all of them, and changes()
// never sees it. Returns a real path.
export async function workHome(root: string): Promise<string> {
  const home = join(dirname(await inside(root)), "home");
  await mkdir(home, { recursive: true });
  return home;
}
export async function inside(root: string, child = "."): Promise<string> {
  const base = await realpath(root);
  const path = await realpath(join(base, child));
  const rel = relative(base, path);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new Error("Command directory escapes the repository");
  return path;
}
