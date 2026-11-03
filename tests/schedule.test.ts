import { expect, test } from "bun:test";
import {
  type Event,
  initial,
  maxRuns,
  nextJob,
  prBusy,
  type State,
  schedule,
} from "../src/schedule.ts";

const run = (events: Event[], state: State = initial) =>
  events.reduce(schedule, state);
const found = (key: string, kind: "ready" | "scan" = "ready"): Event => ({
  type: "found",
  key,
  kind,
});
const started = (key: string): Event => ({ type: "started", key });
const finished = (key: string, again = false): Event => ({
  type: "finished",
  key,
  again,
});

test("tickets and PR steps start before scans, even ones found while a scan runs", () => {
  let state = run([found("bugs scan", "scan"), found("#3")]);
  expect(nextJob(state, 4, 0)).toBe("#3");
  state = run([started("#3"), started("bugs scan"), found("PR#9")], state);
  expect(nextJob(state, 4, 2)).toBe("PR#9");
});

test("nextJob waits for a free agent and for something queued", () => {
  const state = run([found("#3")]);
  expect(nextJob(state, 2, 2)).toBeUndefined();
  expect(nextJob(run([started("#3")], state), 2, 1)).toBeUndefined();
});

test("a key that is queued, running or done is not queued again", () => {
  const queued = run([found("#3"), found("#3")]);
  expect(queued.ready).toEqual(["#3"]);
  const running = run([started("#3"), found("#3")], queued);
  expect(running.ready).toEqual([]);
  const failed = run(
    [{ type: "failed", key: "#3", reason: "checks failed" }, found("#3")],
    running,
  );
  expect(failed.ready).toEqual([]);
  expect(failed.failures).toEqual(["#3: checks failed"]);
  // Finished without `again`, the key can come back when a look finds it.
  expect(run([finished("#3"), found("#3")], running).ready).toEqual(["#3"]);
});

test("a job that finishes with `again` is queued as a scan once more", () => {
  const state = run([
    found("bugs scan", "scan"),
    started("bugs scan"),
    finished("bugs scan", true),
  ]);
  expect(state.scans).toEqual(["bugs scan"]);
  expect(
    run([started("bugs scan"), finished("bugs scan")], state).scans,
  ).toEqual([]);
});

test(`a job is stopped after ${maxRuns} runs and reported once`, () => {
  let state = initial;
  for (let i = 0; i < maxRuns; i++)
    state = run([found("#9"), started("#9"), finished("#9")], state);
  state = run([found("#9"), found("#9")], state);
  expect(nextJob(state, 4, 0)).toBeUndefined();
  expect(state.runs["#9"]).toBe(maxRuns);
  expect(state.failures).toEqual(["#9: stopped after 10 runs"]);
});

test("after a look fails nothing new starts, and running jobs still settle", () => {
  let state = run([found("#3"), found("#5"), found("#6"), started("#3")]);
  state = run(
    [{ type: "lookFailed", failure: "look at owner/repo: GitHub is down" }],
    state,
  );
  expect(nextJob(state, 4, 1)).toBeUndefined();
  state = run([finished("#3")], state);
  expect(state.active).toEqual(["#5", "#6"]);
  expect(state.failures).toEqual(["look at owner/repo: GitHub is down"]);
});

test("a PR is busy while its own step or its ticket is queued or running", () => {
  const state = run([found("#4"), found("PR#7")]);
  expect(prBusy(state, 9, 4)).toBe(true);
  expect(prBusy(state, 7)).toBe(true);
  expect(prBusy(state, 9, 5)).toBe(false);
  expect(prBusy(state, 9)).toBe(false);
});
