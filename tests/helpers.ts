import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { confine } from "../src/process.ts";

// macOS refuses some sandbox profiles inside a sandbox, Milo's among them, so tests that start
// Milo's sandbox cannot run under Milo's own checks there. Linux CI still runs them.
const probe = realpathSync(mkdtempSync(`${tmpdir()}/milo-probe-`));
export const nestedSandboxDenied =
  process.platform === "darwin" &&
  Bun.spawnSync(confine(["true"], probe, probe, probe)).exitCode !== 0;
rmSync(probe, { recursive: true });
