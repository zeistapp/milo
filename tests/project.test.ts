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
      await expect(
        inspectProject(root, {
          setup: [],
          checks: [{ command: ["true"], cwd: ".." }],
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
describe("project profiling edge cases", () => {
  const inspect = (files: Record<string, unknown>) =>
    temporary("milo-profile-", async (root) => {
      for (const [path, content] of Object.entries(files))
        await Bun.write(
          join(root, path),
          typeof content === "string" ? content : JSON.stringify(content),
        );
      return inspectProject(root);
    });
  const scripts = { test: "test" };
  test("generated and dependency directories are not profiled", async () => {
    const ignored = [
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
    ];
    const project = await inspect({
      "package.json": { scripts },
      "bun.lock": "",
      ...Object.fromEntries(
        ignored.map((name) => [`${name}/pkg/package.json`, { scripts }]),
      ),
    });
    expect(project.packages.map((pkg) => pkg.directory)).toEqual(["."]);
  });
  test("malformed package.json fails instead of being guessed at", async () => {
    for (const manifest of ["null", "[]", '"text"'])
      await expect(
        inspect({ "package.json": manifest, "bun.lock": "" }),
      ).rejects.toThrow("Invalid package.json");
    for (const value of [[], "text", { test: 1 }, null])
      await expect(
        inspect({ "package.json": { scripts: value }, "bun.lock": "" }),
      ).rejects.toThrow("Invalid scripts");
  });
  test("package patterns and TypeScript are detected for agent context", async () => {
    const patterns = async (manifest: object) =>
      (
        await inspect({
          "package.json": { scripts, ...manifest },
          "bun.lock": "",
        })
      ).packages[0]?.patterns;
    expect(await patterns({ exports: "./index.js" })).toEqual([
      "library/package exports",
    ]);
    expect(await patterns({ devDependencies: { turbo: "2" } })).toEqual([
      "task graph",
    ]);
    expect(await patterns({ devDependencies: { nx: "20" } })).toEqual([
      "task graph",
    ]);
    expect(await patterns({ scripts: { test: "node test.js" } })).toEqual([
      "runtime scripts",
    ]);
    expect(await patterns({ scripts: { test: "vite build --ssr" } })).toEqual([
      "SSR build",
    ]);
    expect(await patterns({})).toEqual([]);
    const typed = await inspect({
      "package.json": { scripts },
      "bun.lock": "",
      "tsconfig.json": "{}",
    });
    expect(typed.packages[0]?.typescript).toBeTrue();
    expect(typed.warnings[0]).toContain("no dedicated typecheck");
  });
  test("install commands follow the lockfile, including legacy formats", async () => {
    const install = async (files: Record<string, unknown>) =>
      (await inspect({ "package.json": { scripts }, ...files })).setup[0]
        ?.command;
    expect(await install({ "bun.lockb": "" })).toEqual([
      "bun",
      "install",
      "--frozen-lockfile",
    ]);
    expect(await install({ "npm-shrinkwrap.json": "{}" })).toEqual([
      "npm",
      "ci",
    ]);
    expect(await install({ "yarn.lock": "__metadata:\n" })).toEqual([
      "yarn",
      "install",
      "--immutable",
    ]);
    expect(
      await install({
        "yarn.lock": "# THIS IS AN AUTOGENERATED FILE.\n# yarn lockfile v1\n",
      }),
    ).toEqual(["yarn", "install", "--frozen-lockfile"]);
  });
  test("unsupported or unlocked package managers fail before running anything", async () => {
    await expect(
      inspect({
        "package.json": { packageManager: "deno@2.0.0", scripts },
        "bun.lock": "",
      }),
    ).rejects.toThrow("Unsupported package manager deno");
    await expect(
      inspect({
        "package.json": { packageManager: "pnpm@10.0.0", scripts },
        "bun.lock": "",
      }),
    ).rejects.toThrow("Missing or ambiguous");
  });
  test("Jest runs in CI mode and missing tests are reported", async () => {
    const project = await inspect({
      "package.json": { scripts: { test: "jest", build: "jest --ci" } },
      "pnpm-lock.yaml": "",
    });
    expect(project.checks.map((step) => step.command)).toEqual([
      ["pnpm", "run", "test", "--ci"],
      ["pnpm", "run", "build"],
    ]);
    expect(project.warnings).toEqual([]);
    const untested = await inspect({
      "package.json": { scripts: { lint: "biome check" } },
      "bun.lock": "",
    });
    expect(untested.warnings).toEqual([".: no test/test:ci script detected"]);
  });
});
