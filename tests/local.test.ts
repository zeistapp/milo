import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { localCheck } from "../src/local.ts";
import { temporary } from "../src/process.ts";

test("local checks report failures, continue checks and save private logs", () =>
  temporary("milo-local-", async (root) => {
    const report = await localCheck(root, join(root, "reports"), {
      setup: [],
      checks: [
        {
          command: [
            process.execPath,
            "-e",
            "console.error('diagnostic');process.exit(1)",
          ],
        },
        { command: [process.execPath, "-e", "console.log('passed')"] },
      ],
    });
    expect(report.passed).toBeFalse();
    expect(report.results.map((result) => result.status)).toEqual([
      "failed",
      "passed",
    ]);
    const log = report.results[0]?.log;
    assert(log);
    expect(await Bun.file(log).text()).toContain("diagnostic");
    expect((await stat(log)).mode & 0o777).toBe(0o600);
  }));
test("failed setup skips checks without claiming they passed", () =>
  temporary("milo-local-", async (root) => {
    const report = await localCheck(root, join(root, "reports"), {
      setup: [{ command: [process.execPath, "-e", "process.exit(1)"] }],
      checks: [
        {
          command: [process.execPath, "-e", "throw new Error('must not run')"],
        },
      ],
    });
    expect(report.results.map((result) => result.status)).toEqual([
      "failed",
      "skipped",
    ]);
    expect(report.passed).toBeFalse();
  }));
