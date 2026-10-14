export const categories = {
  dependencies:
    "Upgrade compatible dependencies and lockfiles. Consult current official release notes. Keep major upgrades separate.",
  security:
    "Review dependency vulnerabilities and security-sensitive code. Fix evidenced issues. Never publish credentials or sensitive exploit details.",
  architecture:
    "Trace important flows. Make one small architectural improvement backed by evidence, preserving the established framework and build patterns.",
  cleanup:
    "Remove proven dead code and duplication. Preserve public APIs and behaviour; inspect every caller of shared code.",
  organisation:
    "Improve navigation, naming and documentation where it helps maintenance. Update affected imports, exports and links.",
  performance:
    "Measure a bottleneck, establish a baseline and optimise it. Do not claim improvements without measurements.",
};
export type Category = keyof typeof categories;
export type Period = "day" | "week" | "month";
export type Argv = [string, ...string[]];
export interface Step {
  command: Argv;
  cwd?: string;
}
export interface Repo {
  name: string;
  categories?: Category[];
  autoReady?: Category[];
  setup?: Step[];
  checks?: Step[];
}
export type Agent = (
  | { provider: "codex" | "claude"; model?: string; command?: never }
  | { command: Argv; provider?: never; model?: never }
) & { timeoutSeconds?: number };
export interface Config {
  agent: Agent;
  repos: Repo[];
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${context} must be an object`);
  return value as Record<string, unknown>;
}
function argv(value: unknown): value is Argv {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => typeof part === "string" && part.length > 0)
  );
}
function steps(value: unknown, context: string): Step[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value.map((raw) => {
    const step = record(raw, context);
    if (!argv(step.command))
      throw new Error(`${context}.command must be a nonempty argv array`);
    if (
      step.cwd !== undefined &&
      (typeof step.cwd !== "string" ||
        !step.cwd ||
        step.cwd.startsWith("/") ||
        step.cwd.split(/[\\/]/).includes(".."))
    ) {
      throw new Error(`${context}.cwd must stay inside the repository`);
    }
    return {
      command: step.command,
      ...(step.cwd ? { cwd: String(step.cwd) } : {}),
    };
  });
}
function categoryList(value: unknown, context: string): Category[] | undefined {
  if (value === undefined) return;
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) => typeof item === "string" && Object.hasOwn(categories, item),
    )
  ) {
    throw new Error(`${context} contains an unknown category`);
  }
  return value as Category[];
}
export function parseConfig(value: unknown): Config {
  const raw = record(value, "config");
  const agent = record(raw.agent, "agent");
  let selected: Agent;
  if (agent.provider !== undefined) {
    if (agent.provider !== "codex" && agent.provider !== "claude")
      throw new Error("agent.provider must be codex or claude");
    if (agent.command !== undefined)
      throw new Error("Choose agent.provider or agent.command, not both");
    if (
      agent.model !== undefined &&
      (typeof agent.model !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(agent.model))
    )
      throw new Error("agent.model must be a model ID or alias");
    selected = {
      provider: agent.provider,
      ...(agent.model ? { model: String(agent.model) } : {}),
    };
  } else {
    if (
      !argv(agent.command) ||
      !agent.command.some((part) => part.includes("{output}"))
    )
      throw new Error(
        "agent.command must be an argv array containing {output}",
      );
    if (agent.model !== undefined)
      throw new Error(
        "Set model flags in a custom agent.command, or use agent.provider",
      );
    selected = { command: agent.command };
  }
  const timeout = agent.timeoutSeconds ?? 1800;
  if (
    typeof timeout !== "number" ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 3600
  ) {
    throw new Error(
      "agent.timeoutSeconds must be an integer between 1 and 3600",
    );
  }
  if (!Array.isArray(raw.repos) || !raw.repos.length)
    throw new Error("Configure at least one repository");
  const names = new Set<string>();
  const repos = raw.repos.map((value) => {
    const repo = record(value, "repo");
    if (typeof repo.name !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo.name))
      throw new Error("repo.name must be owner/repository");
    if (names.has(repo.name.toLowerCase()))
      throw new Error("Duplicate repository");
    names.add(repo.name.toLowerCase());
    const selected = categoryList(repo.categories, "repo.categories");
    if (selected?.length === 0) throw new Error("Select at least one category");
    const autoReady = categoryList(repo.autoReady, "repo.autoReady");
    if (
      autoReady?.some(
        (item) =>
          !Object.hasOwn(categories, item) ||
          (selected && !selected.includes(item)),
      )
    ) {
      throw new Error("autoReady must be a subset of categories");
    }
    const checks = steps(repo.checks, "repo.checks");
    if (checks?.length === 0)
      throw new Error(
        "Explicit checks cannot be empty; omit to detect scripts",
      );
    return {
      name: repo.name,
      categories: selected,
      autoReady,
      setup: steps(repo.setup, "repo.setup"),
      checks,
    };
  });
  return { agent: { ...selected, timeoutSeconds: timeout }, repos };
}
export async function loadConfig(file: string): Promise<Config> {
  return parseConfig(await Bun.file(file).json());
}
export function includeSelfRepo(config: Config, name: string): Config {
  if (
    config.repos.some((repo) => repo.name.toLowerCase() === name.toLowerCase())
  )
    return config;
  return parseConfig({
    ...config,
    repos: [...config.repos, { name, autoReady: [] }],
  });
}
