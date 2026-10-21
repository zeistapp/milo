import { z } from "zod";

// Parse at trust boundaries with readable messages; ZodError's own message is raw JSON.
export function parse<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(z.prettifyError(result.error));
  return result.data;
}
const Current = z.enum(
  [
    "dependencies",
    "security",
    "bugs",
    "architecture",
    "simplify",
    "performance",
  ],
  { error: "Unknown maintenance category" },
);
// Retired names still parse, so older configs, CLI calls and ticket labels keep working.
export const retiredCategories = {
  cleanup: "simplify",
  modernisation: "simplify",
  organisation: "architecture",
} as const satisfies Record<string, z.infer<typeof Current>>;
export const Category = z.preprocess(
  (value) =>
    typeof value === "string" && Object.hasOwn(retiredCategories, value)
      ? retiredCategories[value as keyof typeof retiredCategories]
      : value,
  Current,
);
export type Category = z.infer<typeof Category>;
export const categoryNames = Current.options;
// Each scan stays in its area, with its own evidence bar, so a finding has one obvious home.
export const categories = {
  dependencies:
    "Upgrade compatible dependencies and lockfiles, including any with known vulnerabilities. Consult current official release notes. Move packages released together, such as react and react-dom, to the same version. Keep major upgrades separate.",
  security:
    "Review security-sensitive code: authentication, authorisation, injection, secret handling and data crossing trust boundaries. Show the exploit path. " +
    "Make Zod schemas the source of truth for data crossing trust boundaries: derive types with z.infer and parse instead of casting. Add Zod only where it replaces hand-written validation or unchecked casts. " +
    "Never publish credentials or sensitive exploit details.",
  bugs:
    "Find behaviour that is wrong today: unhandled edge cases and errors, races, state that can get stuck, and code that contradicts its tests, types or docs. " +
    "Show the failing input or trace the fault, and add a test that fails before the fix.",
  architecture:
    "Find friction where future changes will land: start from hot spots in recent git history, then trace those flows. Look for shallow modules, one concept spread across many files, coupling that leaks across seams, and names that hide what a module does or contradict the glossary; apply the deletion test. " +
    "Propose one deepening that improves locality and testability: the modules involved, the smaller interface and how tests move to it. Preserve the established framework, build patterns and ADRs.",
  simplify:
    "Make code shorter and clearer without changing behaviour: remove proven dead code and duplication, and replace dated JS, TS and CSS with modern native features within the project's supported runtimes and browser targets. " +
    "Prefer inference, satisfies and as const over annotations and assertions. Preserve public APIs; inspect every caller of shared code.",
  performance:
    "Measure a bottleneck, establish a baseline and optimise it. Do not claim improvements without measurements.",
} satisfies Record<Category, string>;
export const Period = z.enum(["day", "week", "month"], {
  error: "period must be day, week, or month",
});
export type Period = z.infer<typeof Period>;
const part = z.string().min(1);
export const Argv = z.tuple([part], part, {
  error: "must be a nonempty argv array",
});
export type Argv = z.infer<typeof Argv>;
const Step = z.object({
  command: Argv,
  cwd: z
    .string()
    .refine(
      (cwd) =>
        cwd && !cwd.startsWith("/") && !cwd.split(/[\\/]/).includes(".."),
      "cwd must stay inside the repository",
    )
    .optional(),
});
export type Step = z.infer<typeof Step>;
// Two retired names can map to one category; scan it once.
const unique = <T>(list: T[]) => [...new Set(list)];
const Repo = z
  .object({
    name: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, "repo.name must be owner/repository"),
    categories: z
      .array(Category)
      .min(1, "Select at least one category")
      .transform(unique)
      .optional(),
    autoReady: z.array(Category).transform(unique).optional(),
    autoMerge: z.array(Category).transform(unique).optional(),
    // Installed by the action on Linux, outside the sandbox, because setup steps cannot use sudo.
    systemPackages: z
      .array(
        z
          .string()
          .regex(
            /^[a-z0-9][a-z0-9+.-]*$/,
            "systemPackages entries must be Debian package names",
          ),
      )
      .optional(),
    setup: z.array(Step).optional(),
    checks: z
      .array(Step)
      .min(1, "Explicit checks cannot be empty; omit to detect scripts")
      .optional(),
  })
  .refine(
    ({ categories, autoReady = [], autoMerge = [] }) =>
      !categories ||
      [...autoReady, ...autoMerge].every((item) => categories.includes(item)),
    "autoReady and autoMerge must be subsets of categories",
  );
export type Repo = z.infer<typeof Repo>;
const timeout = "agent.timeoutSeconds must be an integer between 1 and 3600";
const Model = (field: string) =>
  z
    .string()
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/,
      `${field} must be a model ID or alias`,
    )
    .optional();
const Agent = z
  .object({
    provider: z
      .enum(["claude"], { error: "agent.provider must be claude" })
      .optional(),
    model: Model("agent.model"),
    // Scans are read-only and run once per category, so a cheaper model often suffices.
    scanModel: Model("agent.scanModel"),
    command: Argv.optional(),
    timeoutSeconds: z
      .int({ error: timeout })
      .min(1, timeout)
      .max(3600, timeout)
      .optional(),
  })
  .refine(
    ({ provider, command }) => !(provider && command),
    "Choose agent.provider or agent.command, not both",
  )
  .refine(
    ({ provider, command }) =>
      provider || command?.some((part) => part.includes("{output}")),
    "agent.command must be an argv array containing {output}",
  )
  .refine(
    ({ provider, model, scanModel }) =>
      provider || (model === undefined && scanModel === undefined),
    "Set model flags in a custom agent.command, or use agent.provider",
  );
const Config = z.object({
  agent: Agent,
  repos: z
    .array(Repo)
    .min(1, "Configure at least one repository")
    .refine((repos) => {
      const names = repos.map((repo) => repo.name.toLowerCase());
      return new Set(names).size === names.length;
    }, "Duplicate repository"),
});
export type Config = z.infer<typeof Config>;
export function parseConfig(value: unknown): Config {
  return parse(Config, value);
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
