import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { temporary } from "../src/process.ts";
import { Runner } from "../src/runner.ts";

const actions = [
  "plan",
  "runTasks",
  "runReviews",
  "work",
  "review",
  "tick",
] as const;
const runner = Object.fromEntries(
  actions.map((name) => [
    name,
    spyOn(Runner.prototype, name).mockResolvedValue(undefined),
  ]),
) as Record<(typeof actions)[number], ReturnType<typeof spyOn>>;
const log = spyOn(console, "log").mockImplementation(() => {});
const error = spyOn(console, "error").mockImplementation(() => {});
let folder: string;
let config: string;
const a = expect.objectContaining({ name: "owner/a" });
const b = expect.objectContaining({ name: "owner/b" });
const run = (...args: string[]) => main(["--config", config, ...args]);
const calls = () =>
  Object.fromEntries(
    Object.entries(runner)
      .filter(([, spy]) => spy.mock.calls.length)
      .map(([name, spy]) => [name, spy.mock.calls]),
  );

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "milo-cli-"));
  config = join(folder, "milo.config.json");
  await Bun.write(
    config,
    JSON.stringify({
      agent: { provider: "claude" },
      repos: [
        { name: "owner/a" },
        { name: "owner/b", categories: ["security"] },
      ],
    }),
  );
});
beforeEach(() => {
  for (const spy of [...Object.values(runner), log, error]) spy.mockClear();
  delete process.env.GITHUB_ACTIONS;
});
afterAll(async () => {
  mock.restore();
  await rm(folder, { recursive: true, force: true });
});

test("commands dispatch to the runner with parsed options", async () => {
  await run("plan", "--apply", "--period", "day");
  expect(calls()).toEqual({
    plan: [
      [a, true, "day"],
      [b, true, "day"],
    ],
  });
  for (const [args, expected] of [
    // Retired category names map to their replacements.
    [
      ["plan", "--category", "cleanup"],
      {
        plan: [
          [
            expect.objectContaining({
              name: "owner/a",
              categories: ["simplify"],
            }),
            false,
            "week",
          ],
        ],
      },
    ],
    [
      ["task", "--category", "security"],
      {
        runTasks: [
          [a, "security", "week"],
          [b, "security", "week"],
        ],
      },
    ],
    [
      ["task", "--repo", "owner/a", "--period", "day"],
      { runTasks: [[a, undefined, "day"]] },
    ],
    [["reviews", "--repo", "owner/b"], { runReviews: [[b]] }],
    [
      ["plan", "--repo", "owner/b", "--period", "month"],
      { plan: [[b, false, "month"]] },
    ],
    [
      ["work", "--repo", "owner/a", "12", "--category", "cleanup"],
      { work: [[a, 12, "simplify"]] },
    ],
    [["review", "--repo", "owner/a", "7"], { review: [[a, 7, false]] }],
    [["revise", "--repo", "owner/a", "7"], { review: [[a, 7, true]] }],
    [["tick", "--repo", "owner/a"], { tick: [[a]] }],
    [
      ["reviews", "--self-repo", "owner/c", "--repo", "owner/c"],
      { runReviews: [[expect.objectContaining({ name: "owner/c" })]] },
    ],
    [["validate"], {}],
  ] as const) {
    for (const spy of Object.values(runner)) spy.mockClear();
    await run(...args);
    expect(calls()).toEqual(expected);
  }
  expect(log).toHaveBeenCalledWith("Configuration valid");
});

test("invalid commands fail before the runner starts", async () => {
  const cases: [string[], string][] = [
    [[], "Specify a command"],
    [["deploy"], "Specify a command"],
    [["plan", "--category", "nope"], "Unknown maintenance category"],
    [["reviews", "--category", "security"], "Use --category"],
    [["plan", "--period", "year"], "period must be"],
    [["work", "12"], "Select one repository"],
    [["work", "--repo", "owner/a"], "Select one repository"],
    ...["0", "012", "1.5", "12x", "x12", "99999999999999999999"].map(
      (number): [string[], string] => [
        ["review", "--repo", "owner/a", number],
        "Select one repository",
      ],
    ),
    [["plan", "5"], "Unexpected positional argument"],
    [["reviews", "--repo", "owner/z"], "No configured repositories matched"],
    [["check", "--repo", "owner/z"], "No configured repository matched"],
  ];
  for (const [args, message] of cases)
    await expect(run(...args), args.join(" ")).rejects.toThrow(message);
  expect(calls()).toEqual({});
});

test("--help prints usage without loading config or running", async () => {
  await main(["--config", "missing.json", "--help", "tick"]);
  expect(log.mock.calls[0]?.[0]).toStartWith("Milo: bun run milo");
  expect(calls()).toEqual({});
});
test("the default config file is milo.config.json", async () => {
  await main(["validate"]);
  expect(log).toHaveBeenCalledWith("Configuration valid");
});

test("one failing repository does not stop the rest and is annotated in Actions", async () => {
  runner.runReviews.mockImplementationOnce(async () => {
    throw new Error("boom\r\n100%");
  });
  await expect(run("reviews")).rejects.toThrow("1 repository run(s) failed");
  expect(calls()).toEqual({ runReviews: [[a], [b]] });
  expect(error).toHaveBeenCalledWith("owner/a: boom\r\n100%");
  process.env.GITHUB_ACTIONS = "true";
  runner.runReviews.mockImplementationOnce(async () => {
    throw "not an error";
  });
  await expect(run("reviews")).rejects.toThrow("1 repository run(s) failed");
  runner.runReviews.mockImplementationOnce(async () => {
    throw new Error("boom\r\n100%");
  });
  await expect(run("reviews")).rejects.toThrow("1 repository run(s) failed");
  expect(error.mock.calls.slice(1)).toEqual([
    ["::error::owner/a: Unknown failure"],
    ["::error::owner/a: boom%0D%0A100%25"],
  ]);
});

test("check runs the configured repo's checks and fails when they fail", () =>
  temporary("milo-cli-check-", async (root) => {
    const file = join(root, "check.json");
    const write = (code: number) =>
      Bun.write(
        file,
        JSON.stringify({
          agent: { provider: "claude" },
          repos: [
            {
              name: "owner/a",
              setup: [],
              checks: [
                {
                  command: [
                    process.execPath,
                    "-e",
                    `process.exit(require("fs").existsSync("marker") ? ${code} : 2)`,
                  ],
                },
              ],
            },
          ],
        }),
      );
    const check = () =>
      main([
        "--config",
        file,
        "--repo",
        "owner/a",
        "--report-dir",
        join(root, "report"),
        "check",
        root,
      ]);
    // Each check exits 2 unless it runs inside the target directory.
    await Bun.write(join(root, "marker"), "");
    await write(0);
    await check();
    await write(1);
    await expect(check()).rejects.toThrow("Local checks failed");
  }));

test("packages prints every configured repo's system packages once", () =>
  temporary("milo-cli-packages-", async (root) => {
    const file = join(root, "packages.json");
    await Bun.write(
      file,
      JSON.stringify({
        agent: { provider: "claude" },
        repos: [
          { name: "owner/a", systemPackages: ["ffmpeg", "rsync"] },
          { name: "owner/b", systemPackages: ["rsync", "git"] },
          { name: "owner/c" },
        ],
      }),
    );
    await main(["--config", file, "packages"]);
    await main(["--config", config, "packages"]);
    expect(log.mock.calls).toEqual([["ffmpeg rsync git"], [""]]);
  }));

test("inspect profiles the target directory", () =>
  temporary("milo-cli-inspect-", async (root) => {
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ name: "target", scripts: { test: "bun test" } }),
    );
    await Bun.write(join(root, "bun.lock"), "");
    await main(["inspect", root]);
    expect(JSON.parse(log.mock.calls[0]?.[0]).packages[0].name).toBe("target");
  }));
