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
export const Category = z.enum(
  [
    "dependencies",
    "security",
    "architecture",
    "cleanup",
    "organisation",
    "performance",
    "modernisation",
  ],
  { error: "Unknown maintenance category" },
);
export type Category = z.infer<typeof Category>;
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
  modernisation:
    "Replace dated JS, TS and CSS with modern native features where the result is shorter and clearer, within the project's supported runtimes and browser targets. " +
    "Make Zod schemas the source of truth for data crossing trust boundaries: derive types with z.infer and parse instead of casting. " +
    "Prefer inference, satisfies and as const over annotations and assertions. Add Zod only where it replaces hand-written validation or unchecked casts. Preserve behaviour.",
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
const Repo = z
  .object({
    name: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, "repo.name must be owner/repository"),
    categories: z
      .array(Category)
      .min(1, "Select at least one category")
      .optional(),
    autoReady: z.array(Category).optional(),
    autoMerge: z.array(Category).optional(),
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
const Agent = z
  .object({
    provider: z
      .enum(["codex", "claude"], {
        error: "agent.provider must be codex or claude",
      })
      .optional(),
    model: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/,
        "agent.model must be a model ID or alias",
      )
      .optional(),
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
    ({ provider, model }) => provider || model === undefined,
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
