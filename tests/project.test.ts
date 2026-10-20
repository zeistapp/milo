import { describe, expect, test } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { includeSelfRepo, parseConfig } from "../src/config.ts";
import { temporary } from "../src/process.ts";
import {
  inspectProject,
  installedVersions,
  lockstepDrift,
  projectContext,
} from "../src/project.ts";

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
      for (const test of ["vitest --watch", "vitest --watch src"]) {
        await manifest(root, {}, { test });
        await expect(inspectProject(root)).rejects.toThrow("interactive");
      }
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
      expect(project.packageManager).toBe("configured");
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
  ).toThrow("Unknown maintenance category");
  const step = (cwd: string) =>
    parseConfig({
      ...value,
      repos: [{ name: "owner/repo", setup: [{ command: ["true"], cwd }] }],
    });
  expect(step("packages/app").repos[0]?.setup?.[0]?.cwd).toBe("packages/app");
  for (const cwd of ["", "/etc", "packages/../../x", "a\\..\\.."])
    expect(() => step(cwd)).toThrow("inside");
  for (const name of ["owner", "x?y/a/b", "owner/repo/extra", "own er/repo"])
    expect(() => parseConfig({ ...value, repos: [{ name }] })).toThrow(
      "owner/repository",
    );
  expect(() =>
    parseConfig({
      ...value,
      repos: [{ name: "owner/repo" }, { name: "Owner/Repo" }],
    }),
  ).toThrow("Duplicate repository");
  // Without categories every category is enabled, so any auto list is allowed.
  expect(
    parseConfig({
      ...value,
      repos: [{ name: "owner/repo", autoMerge: ["dependencies"] }],
    }).repos[0]?.autoMerge,
  ).toEqual(["dependencies"]);
  expect(() =>
    parseConfig({
      ...value,
      repos: [
        {
          name: "owner/repo",
          categories: ["security"],
          autoReady: ["dependencies"],
        },
      ],
    }),
  ).toThrow("subsets");
  for (const agent of [{}, { command: ["agent"] }])
    expect(() => parseConfig({ ...value, agent })).toThrow("{output}");
});
test("the calling repository is added once, whatever its case", () => {
  const config = parseConfig({
    agent: { provider: "claude" },
    repos: [{ name: "owner/repo" }],
  });
  expect(includeSelfRepo(config, "OWNER/REPO")).toBe(config);
  expect(
    includeSelfRepo(config, "owner/milo").repos.map(({ name }) => name),
  ).toEqual(["owner/repo", "owner/milo"]);
});
describe("project profiling edge cases", () => {
  const inspect = (
    files: Record<string, unknown>,
    repo?: Parameters<typeof inspectProject>[1],
  ) =>
    temporary("milo-profile-", async (root) => {
      for (const [path, content] of Object.entries(files))
        await Bun.write(
          join(root, path),
          typeof content === "string" ? content : JSON.stringify(content),
        );
      return inspectProject(root, repo);
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
    for (const field of ["dependencies", "devDependencies", "peerDependencies"])
      await expect(
        inspect({
          "package.json": { scripts, [field]: { x: 1 } },
          "bun.lock": "",
        }),
      ).rejects.toThrow(`Invalid ${field}`);
  });
  test("unnamed packages use their directory and unknown dependencies add no tools", async () => {
    const [pkg] = (
      await inspect({
        "package.json": { scripts, dependencies: { "left-pad": "1" } },
        "bun.lock": "",
      })
    ).packages;
    expect(pkg?.name).toBe(".");
    expect(pkg?.tools).toEqual([]);
  });
  test("CI script variants are preferred and satisfy check warnings", async () => {
    const checks = async (scripts: Record<string, string>) => {
      const project = await inspect({
        "package.json": { scripts },
        "bun.lock": "",
        "tsconfig.json": "{}",
      });
      expect(project.warnings).toEqual([]);
      return project.checks.map((step) => step.command[2]);
    };
    expect(
      await checks({ "type-check": "t", check: "c", "test:ci": "t" }),
    ).toEqual(["type-check", "check", "test:ci"]);
    expect(
      await checks({
        "check:types": "t",
        "check:ci": "c",
        lint: "l",
        "lint:ci": "l",
        test: "t",
        "test:ci": "t",
        build: "b",
        "build:ci": "b",
      }),
    ).toEqual(["check:types", "check:ci", "lint:ci", "test:ci", "build:ci"]);
  });
  test("partial explicit commands still need a package and lockfile", async () => {
    await expect(inspect({}, { setup: [] })).rejects.toThrow(
      "No package.json found",
    );
    const project = await inspect(
      { "package.json": { scripts }, "bun.lock": "" },
      { setup: [] },
    );
    expect(project.packageManager).toBe("bun");
    expect(project.checks[0]?.command).toEqual(["bun", "run", "test"]);
  });
  test("agent context embeds the detected profile", async () => {
    const project = await inspect({
      "package.json": { scripts, dependencies: { hono: "4" } },
      "bun.lock": "",
    });
    const { packages, warnings, checks } = project;
    const context = projectContext(project);
    expect(context).toStartWith("Repository profile");
    expect(context).toContain(JSON.stringify({ packages, warnings, checks }));
    expect(context).toContain("Do not invent framework APIs");
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
    expect(
      await patterns({ scripts: { test: "node test.js", build: "x" } }),
    ).toEqual(["runtime scripts"]);
    expect(
      await patterns({ scripts: { test: "t", build: "vite build --ssr" } }),
    ).toEqual(["SSR build"]);
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

test("packages released together cannot drift apart", async () => {
  const versions = (react: string, dom: string, radix = "1.1.0") =>
    temporary("milo-installed-", async (root) => {
      const install = (dir: string, name: string, version: string) =>
        Bun.write(
          join(root, dir, "node_modules", name, "package.json"),
          JSON.stringify({ version }),
        );
      await install(".", "react", react);
      // Workspaces may nest their own copy; Node resolution finds it first.
      await install("apps/web", "react-dom", dom);
      await install("apps/web", "@radix-ui/react-dialog", radix);
      await install(".", "@radix-ui/react-popover", "1.1.0");
      const dependencies = {
        react: "^19",
        "react-dom": "^19",
        "@radix-ui/react-dialog": "^1",
        "@radix-ui/react-popover": "^1",
        missing: "^1",
      };
      return installedVersions(root, [{ directory: "apps/web", dependencies }]);
    });
  const before = await versions("19.2.0", "19.2.0");
  expect([...(before.get("apps/web") ?? [])]).toEqual([
    ["react", "19.2.0"],
    ["react-dom", "19.2.0"],
    ["@radix-ui/react-dialog", "1.1.0"],
    ["@radix-ui/react-popover", "1.1.0"],
  ]);
  const always = async () => true;
  expect(
    await lockstepDrift(before, await versions("19.2.1", "19.2.0"), always),
  ).toBe(
    "react moved to 19.2.1 but react-dom stayed at 19.2.0 in apps/web; upgrade them together",
  );
  expect(
    await lockstepDrift(before, await versions("19.2.1", "19.2.1"), always),
  ).toBeUndefined();
  // A sibling that never published the new version is released separately.
  expect(
    await lockstepDrift(
      before,
      await versions("19.2.0", "19.2.0", "1.1.1"),
      async (name) => name !== "@radix-ui/react-popover",
    ),
  ).toBeUndefined();
});
