# Plan: adopt Matt Pocock's agent-workflow ideas in Milo

Eleven changes, drawn from aihero.dev and Matt's repos (sandcastle, course-video-manager, skills). Together they cut cost and noise on every run, stop Milo repeating or ignoring maintainer decisions, and raise the bar on what it merges. Most are prompt changes or small harness changes; none adds a dependency.

## Order

Work the frontier: any ticket whose blockers are done.

| #   | Ticket                                              | Blocked by |
| --- | --------------------------------------------------- | ---------- |
| 01  | Shrink the shared guidelines to Milo's own rules    | None       |
| 02  | Read agent results as structured output             | None       |
| 03  | Stop re-raising findings a maintainer rejected      | None       |
| 04  | Give the implementer maintainers' ticket comments   | None       |
| 05  | Hold tests to "can it catch a real bug"             | 01         |
| 06  | Review against the repo's own standards files       | None       |
| 07  | Skip tickets whose blockers are still open          | None       |
| 08  | Require a reversibility call before a merge verdict | 02         |
| 09  | Review with a different model from the implementer  | None       |
| 10  | Prefer ratchets to written rules                    | 01         |
| 11  | Look for bug-prone patterns in the bugs scan        | 01         |

01 comes first among the prompt tickets so 05, 10 and 11 add their rules to the slimmed guidelines rather than re-bloating them. 08 waits for 02 because both change how the review verdict is read.

## Changes

Ship the tickets as five changes, in this order. A and B can run in parallel, then C and E.

| Change | Tickets        | Why together                                                                                                                    |
| ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A      | 01             | Pure deletion. Alone, it is easy to review and its effect on cost and output is easy to measure.                                |
| B      | 02, 08         | 08 adds a reversibility field to the review result 02 creates; together, the schema changes once.                               |
| C      | 03, 04, 07     | All make Milo respect what maintainers already said (rejections, comments, blockers). Same kind of GitHub reads and test fakes. |
| D      | 05, 06, 10, 11 | All scan and review prompt rules. One pass keeps wording consistent. After A.                                                   |
| E      | 09             | Small config option. Lands any time.                                                                                            |

Done: A (f62e927), B (4cb3020), C (50114b4), D (a0ee778), E (2f90d10). All five changes are done.

Land B before C: 03 adds data to the scan and verifier prompts whose output instructions B rewrites.

## Sources

- Instruction budget: aihero.dev/never-run-claude-init
- Structured output with in-session repair: sandcastle `Output.object`, `shared/run-with-extraction.ts`
- Rejection records: skills `engineering/triage/OUT-OF-SCOPE.md`; course-video-manager architecture-review prompt
- Read comments, not just bodies: aihero.dev/skills-triage
- Test bar and ratchets: course-video-manager `CODING_STANDARDS.md`, `docs/TESTING_STANDARDS.md`, `docs/plans/test-pruning.md`
- Reviewer enforces standards: skills `engineering/retro`, `code-review` 1.3.1
- Dependency-driven queue: course-video-manager `agent-promote-queued.yml`
- One-way and two-way doors: skills `pr` 1.3 "Merge Danger"
- Separate reviewer: aihero.dev/ai-coding-dictionary/automated-review

## Not in this plan

Later: a stream-json trace per run, flaky-check detection, a manual retro on run traces, prompt regression tests on fixture repos.

Skipped: Ralph loops, Sandcastle as a dependency, system-prompt trimming (Milo already runs `--bare` with an explicit tool list), backlog gates (one open ticket per category already), parallel worktrees, path-free tickets (`work()` already rechecks a ticket against `git log` since it was filed).
