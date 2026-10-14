import { describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { temporary } from "../src/process.ts";
import { inspectProject } from "../src/project.ts";

async function manifest(
  root: string,
  dependencies: Record<string, string>,
  scripts: Record<string, string>,
  directory = ".",
) {
  await mkdir(join(root, directory), { recursive: true });
  await Bun.write(
    join(root, directory, "package.json"),
    JSON.stringify({ name: directory, dependencies, scripts }),
  );
}
describe("framework-independent validation", () => {
  for (const [dependency, tool] of [
    ["vite", "Vite"],
    ["astro", "Astro"],
    ["react", "React"],
    ["next", "Next.js"],
    ["hono", "Hono"],
    ["@sveltejs/kit", "SvelteKit"],
    ["@tanstack/react-start", "TanStack Start"],
    ["nuxt", "Nuxt"],
    ["@angular/core", "Angular"],
  ] as const) {
    test(`${tool}: uses repository scripts`, () =>
      temporary("milo-profile-", async (root) => {
        await manifest(
          root,
          { [dependency]: "latest" },
          {
            typecheck: "custom-types",
            test: "custom-tests",
            build: "custom-build",
          },
        );
        await Bun.write(join(root, "bun.lock"), "fixture");
        const project = await inspectProject(root);
        expect(project.packages[0]?.tools).toContain(tool);
        expect(project.setup[0]?.command).toEqual([
          "bun",
          "install",
          "--frozen-lockfile",
        ]);
        expect(project.checks.map((step) => step.command)).toEqual([
          ["bun", "run", "typecheck"],
          ["bun", "run", "test"],
          ["bun", "run", "build"],
        ]);
      }));
  }
  test("unknown future tools and vanilla JS are accepted through scripts", () =>
    temporary("milo-profile-", async (root) => {
      await manifest(
        root,
        { "future-framework": "99" },
        { build: "future build", test: "future test" },
      );
      await Bun.write(join(root, "package-lock.json"), "{}");
      const project = await inspectProject(root);
      expect(project.packageManager).toBe("npm");
      expect(project.checks.map((step) => step.command)).toEqual([
        ["npm", "run", "test"],
        ["npm", "run", "build"],
      ]);
    }));
  test("mixed monorepo discovers frontend, server, library and nested packages", () =>
    temporary("milo-profile-", async (root) => {
      await manifest(root, { turbo: "latest" }, { build: "turbo build" });
      await Bun.write(join(root, "bun.lock"), "fixture");
      await manifest(
        root,
        { astro: "latest", react: "latest" },
        { check: "astro check", build: "astro build" },
        "apps/site",
      );
      await manifest(
        root,
        { hono: "latest" },
        { test: "bun test" },
        "apps/api",
      );
      await manifest(
        root,
        { tsdown: "latest" },
        { build: "tsdown" },
        "packages/lib",
      );
      await manifest(
        root,
        { next: "latest" },
        { build: "next build" },
        "node_modules/ignore",
      );
      const project = await inspectProject(root);
      expect(project.packages.map((pkg) => pkg.directory).sort()).toEqual([
        ".",
        "apps/api",
        "apps/site",
        "packages/lib",
      ]);
      expect(project.checks.some((step) => step.cwd === "apps/api")).toBeTrue();
      expect(
        project.checks.some((step) => step.cwd === "apps/site"),
      ).toBeTrue();
    }));
  test("packageManager resolves multiple lockfiles without migration", () =>
    temporary("milo-profile-", async (root) => {
      await Bun.write(
        join(root, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@10.0.0",
          scripts: { build: "build" },
        }),
      );
      await Bun.write(join(root, "bun.lock"), "fixture");
      await Bun.write(join(root, "pnpm-lock.yaml"), "fixture");
      expect((await inspectProject(root)).setup[0]?.command).toEqual([
        "pnpm",
        "install",
        "--frozen-lockfile",
      ]);
    }));
  test("ambiguous locks fail before executing anything", () =>
    temporary("milo-profile-", async (root) => {
      await manifest(root, {}, { build: "build" });
      await Bun.write(join(root, "bun.lock"), "fixture");
      await Bun.write(join(root, "yarn.lock"), "fixture");
      expect(inspectProject(root)).rejects.toThrow("ambiguous");
    }));
  test("missing checks and watch scripts do not silently pass", () =>
    temporary("milo-profile-", async (root) => {
      await manifest(root, {}, { dev: "vite" });
      await Bun.write(join(root, "bun.lock"), "fixture");
      await expect(inspectProject(root)).rejects.toThrow("No runnable checks");
      await manifest(root, {}, { test: "vitest --watch" });
      await expect(inspectProject(root)).rejects.toThrow("interactive");
    }));
  test("Vitest tests run once with correct npm argument forwarding", () =>
    temporary("milo-profile-", async (root) => {
      await manifest(root, { vitest: "latest" }, { test: "vitest" });
      await Bun.write(join(root, "package-lock.json"), "{}");
      expect((await inspectProject(root)).checks[0]?.command).toEqual([
        "npm",
        "run",
        "test",
        "--",
        "--run",
      ]);
    }));
  test("static vanilla JS supports explicit commands without package.json", () =>
    temporary("milo-profile-", async (root) => {
      const project = await inspectProject(root, {
        setup: [],
        checks: [{ command: ["bun", "check.js"] }],
      });
      expect(project.packages).toEqual([]);
      expect(project.checks[0]?.command).toEqual(["bun", "check.js"]);
    }));
  test("symlinked command cwd cannot escape the repository", () =>
    temporary("milo-profile-", async (root) => {
      await symlink("/tmp", join(root, "outside"));
      await expect(
        inspectProject(root, {
          setup: [],
          checks: [{ command: ["true"], cwd: "outside" }],
        }),
      ).rejects.toThrow("escapes");
    }));
  test("TypeScript gaps are reported without inventing commands", () =>
    temporary("milo-profile-", async (root) => {
      await manifest(
        root,
        { typescript: "latest", vite: "latest" },
        { build: "vite build" },
      );
      await Bun.write(join(root, "bun.lock"), "fixture");
      const project = await inspectProject(root);
      expect(
        project.warnings.some((warning) => warning.includes("typecheck")),
      ).toBeTrue();
      expect(project.checks).toHaveLength(1);
    }));
});
test("configuration validates categories, checks and command boundaries", () => {
  const value = {
    agent: { command: ["agent", "{output}"] },
    repos: [{ name: "owner/repo" }],
  };
  expect(parseConfig(value).repos[0]?.checks).toBeUndefined();
  expect(() =>
    parseConfig({ ...value, repos: [{ name: "owner/repo", checks: [] }] }),
  ).toThrow("empty");
  expect(() =>
    parseConfig({
      ...value,
      repos: [
        {
          name: "owner/repo",
          checks: [{ command: ["true"], cwd: "../other" }],
        },
      ],
    }),
  ).toThrow("inside");
  expect(() =>
    parseConfig({
      ...value,
      repos: [{ name: "owner/repo", categories: ["made-up"] }],
    }),
  ).toThrow("unknown");
});
