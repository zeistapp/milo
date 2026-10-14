import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Argv, Repo, Step } from "./config.ts";
import { inside } from "./process.ts";

interface Manifest {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: unknown;
}
export interface PackageProfile {
  directory: string;
  name: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  tools: string[];
  patterns: string[];
  typescript: boolean;
}
export interface Project {
  packageManager: "bun" | "npm" | "pnpm" | "yarn" | "configured";
  packages: PackageProfile[];
  setup: Step[];
  checks: Step[];
  warnings: string[];
}
const toolPackages: Record<string, string> = {
  next: "Next.js",
  astro: "Astro",
  react: "React",
  "react-dom": "React",
  vite: "Vite",
  hono: "Hono",
  vue: "Vue",
  nuxt: "Nuxt",
  svelte: "Svelte",
  "@sveltejs/kit": "SvelteKit",
  "@angular/core": "Angular",
  "solid-js": "Solid",
  "@solidjs/start": "SolidStart",
  "@remix-run/react": "Remix",
  "@tanstack/react-start": "TanStack Start",
  "react-router": "React Router",
  express: "Express",
  fastify: "Fastify",
  elysia: "Elysia",
  "@nestjs/core": "NestJS",
  "@trpc/server": "tRPC",
  "@elysiajs/eden": "Elysia",
  vitest: "Vitest",
  jest: "Jest",
  "@playwright/test": "Playwright",
  cypress: "Cypress",
  tsup: "tsup",
  tsdown: "tsdown",
  rollup: "Rollup",
  webpack: "Webpack",
  esbuild: "esbuild",
  rspack: "Rspack",
  "@rspack/core": "Rspack",
  parcel: "Parcel",
  turbo: "Turborepo",
  nx: "Nx",
  "@biomejs/biome": "Biome",
  eslint: "ESLint",
};
const ignored = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".astro",
  ".output",
  ".turbo",
  ".cache",
  "vendor",
]);

async function manifests(root: string, directory = "."): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name === "package.json"))
    files.push(directory);
  for (const entry of entries) {
    // Do not traverse symlinks or generated/dependency directories.
    if (entry.isDirectory() && !ignored.has(entry.name))
      files.push(...(await manifests(root, join(directory, entry.name))));
  }
  return files;
}
function stringMap(value: unknown, context: string): Record<string, string> {
  if (value === undefined) return {};
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((value) => typeof value !== "string")
  )
    throw new Error(`Invalid ${context} in package.json`);
  return value as Record<string, string>;
}
async function packageProfile(
  root: string,
  directory: string,
): Promise<PackageProfile> {
  const manifest: Manifest = await Bun.file(
    join(root, directory, "package.json"),
  ).json();
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("Invalid package.json");
  const scripts = stringMap(manifest.scripts, "scripts");
  const dependencies = {
    ...stringMap(manifest.peerDependencies, "peerDependencies"),
    ...stringMap(manifest.devDependencies, "devDependencies"),
    ...stringMap(manifest.dependencies, "dependencies"),
  };
  const tools = [
    ...new Set(
      Object.keys(dependencies).flatMap((name) =>
        toolPackages[name] ? [toolPackages[name]] : [],
      ),
    ),
  ];
  const patterns: string[] = [];
  if (manifest.exports) patterns.push("library/package exports");
  if (tools.includes("Turborepo") || tools.includes("Nx"))
    patterns.push("task graph");
  if (Object.values(scripts).some((script) => /\b(?:bun|node)\b/.test(script)))
    patterns.push("runtime scripts");
  if (Object.values(scripts).some((script) => script.includes("--ssr")))
    patterns.push("SSR build");
  const typescript =
    Object.hasOwn(dependencies, "typescript") ||
    (await Bun.file(join(root, directory, "tsconfig.json")).exists());
  return {
    directory,
    name: typeof manifest.name === "string" ? manifest.name : directory,
    scripts,
    dependencies,
    tools,
    patterns,
    typescript,
  };
}

async function manager(
  root: string,
): Promise<{ name: Project["packageManager"]; install: Argv }> {
  const manifest: Manifest = await Bun.file(join(root, "package.json")).json();
  const locks = [
    {
      name: "bun" as const,
      files: ["bun.lock", "bun.lockb"],
      install: ["bun", "install", "--frozen-lockfile"] as Argv,
    },
    {
      name: "npm" as const,
      files: ["package-lock.json", "npm-shrinkwrap.json"],
      install: ["npm", "ci"] as Argv,
    },
    {
      name: "pnpm" as const,
      files: ["pnpm-lock.yaml"],
      install: ["pnpm", "install", "--frozen-lockfile"] as Argv,
    },
    {
      name: "yarn" as const,
      files: ["yarn.lock"],
      install: ["yarn", "install", "--immutable"] as Argv,
    },
  ];
  const present = [];
  for (const lock of locks)
    if (
      (
        await Promise.all(
          lock.files.map((file) => Bun.file(join(root, file)).exists()),
        )
      ).some(Boolean)
    )
      present.push(lock);
  const declaration = manifest.packageManager?.split("@")[0];
  if (declaration && !locks.some((lock) => lock.name === declaration))
    throw new Error(
      `Unsupported package manager ${declaration}; configure explicit setup and checks`,
    );
  const selected = declaration
    ? present.find((lock) => lock.name === declaration)
    : present.length === 1
      ? present[0]
      : undefined;
  if (!selected)
    throw new Error(
      "Missing or ambiguous package-manager lockfile; declare packageManager or configure explicit setup and checks",
    );
  if (
    selected.name === "yarn" &&
    (await Bun.file(join(root, "yarn.lock")).text()).includes(
      "# yarn lockfile v1",
    )
  ) {
    selected.install = ["yarn", "install", "--frozen-lockfile"];
  }
  return { name: selected.name, install: selected.install };
}
function scriptStep(
  pkg: PackageProfile,
  manager: Project["packageManager"],
  script: string,
): Step {
  const value = pkg.scripts[script];
  if (value === undefined) throw new Error(`Missing script ${script}`);
  if (/(?:^|\s)(?:--watch(?:All)?|--ui|--interactive)(?:\s|=|$)/.test(value))
    throw new Error(
      `${pkg.directory}: ${script} is interactive; configure a CI check`,
    );
  const command: Argv = [manager, "run", script];
  const extra: string[] = [];
  if (/\bvitest\b/.test(value) && !/\b(?:run|--run)\b/.test(value))
    extra.push("--run");
  if (/\bjest\b/.test(value) && !value.includes("--ci")) extra.push("--ci");
  if (extra.length)
    command.push(...(manager === "npm" ? ["--", ...extra] : extra));
  return { command, cwd: pkg.directory };
}
export async function inspectProject(
  root: string,
  repo: Pick<Repo, "setup" | "checks"> = {},
): Promise<Project> {
  const directories = await manifests(root);
  const packages = await Promise.all(
    directories.map((directory) => packageProfile(root, directory)),
  );
  if (!packages.length && (!repo.setup || !repo.checks))
    throw new Error(
      "No package.json found; configure explicit setup and checks for this layout",
    );
  // Fully explicit commands allow static vanilla JS repos and custom build systems.
  let packageManager: Project["packageManager"] = "configured";
  let install: Argv | undefined;
  if (!repo.setup || !repo.checks)
    ({ name: packageManager, install } = await manager(root));
  const warnings: string[] = [];
  const detected: Step[] = [];
  for (const pkg of packages) {
    const groups = [
      ["typecheck", "type-check", "check:types"],
      ["check", "check:ci"],
      ["lint:ci", "lint"],
      ["test:ci", "test"],
      ["build:ci", "build"],
    ];
    for (const names of groups) {
      const script = names.find((name) => Object.hasOwn(pkg.scripts, name));
      if (script && !repo.checks)
        detected.push(scriptStep(pkg, packageManager, script));
    }
    if (
      pkg.typescript &&
      !groups
        .slice(0, 2)
        .flat()
        .some((name) => Object.hasOwn(pkg.scripts, name))
    ) {
      warnings.push(
        `${pkg.directory}: no dedicated typecheck/check script; a successful bundler build may not check types`,
      );
    }
    if (
      !Object.keys(pkg.scripts).some(
        (name) => name === "test" || name === "test:ci",
      )
    )
      warnings.push(`${pkg.directory}: no test/test:ci script detected`);
  }
  const checks = repo.checks ?? detected;
  if (!checks.length)
    throw new Error(
      "No runnable checks detected; configure checks rather than treating an unchecked task as passing",
    );
  let setup = repo.setup;
  if (!setup) {
    if (!install) throw new Error("No install command detected");
    setup = [{ command: install }];
  }
  for (const step of [...setup, ...checks]) await inside(root, step.cwd);
  return { packageManager, packages, setup, checks, warnings };
}

export function projectContext(project: Project): string {
  return (
    "Repository profile (inspect installed versions and consult current official documentation before using unfamiliar APIs):\n" +
    JSON.stringify({
      packages: project.packages,
      warnings: project.warnings,
      checks: project.checks,
    }) +
    "\nPreserve the existing runtime, framework, module format, workspace layout and deployment adapters. " +
    "For frontend/SSR code check hydration and server/client boundaries. For Hono and other servers check routes, middleware order, auth, validation and runtime bindings. " +
    "For libraries preserve exports, peer dependencies and supported consumers. For build changes preserve task graphs and outputs. Do not invent framework APIs or migrate stacks."
  );
}
