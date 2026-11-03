// Turbo's scheduling policy as a pure reducer over job keys. Runner.turbo runs the jobs and reports what happened.

// A spending stop for a job that keeps coming back: a PR takes about five review rounds at most.
export const maxRuns = 10;

export interface State {
  // Tickets and PR steps go before scans, so reviews never wait behind a scan.
  readonly ready: readonly string[];
  readonly scans: readonly string[];
  readonly active: readonly string[]; // queued or running
  readonly done: readonly string[]; // failed or out of runs: not retried this run
  readonly runs: Readonly<Record<string, number>>;
  readonly failures: readonly string[]; // "job: reason"
  readonly stopping: boolean; // a look failed: start nothing new
}

export type Event =
  | { type: "found"; key: string; kind: "ready" | "scan" }
  | { type: "started"; key: string }
  // `again`: the job may find more, so queue it as a scan once more.
  | { type: "finished"; key: string; again: boolean }
  | { type: "failed"; key: string; reason: string }
  | { type: "lookFailed"; failure: string };

export const initial: State = {
  ready: [],
  scans: [],
  active: [],
  done: [],
  runs: {},
  failures: [],
  stopping: false,
};

export const ticketKey = (ticket: number) => `#${ticket}`;
export const prKey = (pr: number) => `PR#${pr}`;

export const isActive = (state: State, key: string) =>
  state.active.includes(key);

// A PR whose ticket is still being worked is not finished yet.
export const prBusy = (state: State, pr: number, ticket?: number) =>
  isActive(state, prKey(pr)) ||
  (ticket !== undefined && isActive(state, ticketKey(ticket)));

function found(state: State, key: string, kind: "ready" | "scan"): State {
  if (isActive(state, key) || state.done.includes(key)) return state;
  if ((state.runs[key] ?? 0) >= maxRuns)
    return {
      ...state,
      done: [...state.done, key],
      failures: [...state.failures, `${key}: stopped after ${maxRuns} runs`],
    };
  return {
    ...state,
    active: [...state.active, key],
    ...(kind === "ready"
      ? { ready: [...state.ready, key] }
      : { scans: [...state.scans, key] }),
  };
}

const settle = (state: State, key: string): State => ({
  ...state,
  active: state.active.filter((k) => k !== key),
});

export function schedule(state: State, event: Event): State {
  switch (event.type) {
    case "found":
      return found(state, event.key, event.kind);
    case "started": {
      const { key } = event;
      return {
        ...state,
        ready: state.ready.filter((k) => k !== key),
        scans: state.scans.filter((k) => k !== key),
        runs: { ...state.runs, [key]: (state.runs[key] ?? 0) + 1 },
      };
    }
    case "finished": {
      const next = settle(state, event.key);
      return event.again ? found(next, event.key, "scan") : next;
    }
    case "failed":
      return {
        ...settle(state, event.key),
        done: [...state.done, event.key],
        failures: [...state.failures, `${event.key}: ${event.reason}`],
      };
    case "lookFailed":
      return {
        ...state,
        stopping: true,
        failures: [...state.failures, event.failure],
      };
  }
}

// The key to start next, if a slot is free and the run is not stopping.
export function nextJob(
  state: State,
  agents: number,
  running: number,
): string | undefined {
  if (state.stopping || running >= agents) return;
  return state.ready[0] ?? state.scans[0];
}
