# Remove the dependency and performance scans

Status: accepted, 2026-10-28

## Decision

Milo no longer scans for dependency upgrades or performance work. The `dependencies` and `performance` categories are gone. Configs that still list them load without them, so existing consumers keep running.

Don't add either scan back in its old form. It produced nothing. If you want one back, change the approach first (see the last section).

## Evidence

We reviewed every scheduled run on the three repos Milo maintains: milo (daily scans from 17 to 27 October 2026), zeist (24 to 27 October) and hegira (25 to 27 October).

**Dependencies:** no tickets on any repo. The only dependency ticket ever filed was milo #3, a weekly placeholder from before scans verified their findings. Dependabot did the actual work. It opened and merged every dependency PR on milo (#1, #2, #31, #62, #63), and zeist and hegira have it set up too. The scan ran 2 to 4 agent turns for $0.02 to $0.05, which is too shallow to find anything Dependabot misses.

**Performance:** no tickets on any repo. The only performance ticket ever filed was zeist #25. Milo's #6 was a placeholder, closed as not planned. Each scan cost $0.04 to $0.10.

Cost wasn't the reason. Together the two scans cost about $0.30 a day across all three repos. We removed them because they produced nothing while adding runs, labels and code to maintain.

The other scans did produce work. Over the same period they filed tickets that became merged PRs: architecture (milo #61, #67, #77), bugs (milo #58, #66, #73) and security (milo #69, zeist #74).

## What to try instead

**Dependencies:** Dependabot handles routine upgrades. A Milo scan only earns its place if it does what Dependabot can't, such as:

- moving packages released together (react and react-dom, for example) in one change
- major upgrades that need code changes, with the migration done and tested

Run it weekly or when Dependabot opens a major-version PR, not daily.

**Performance:** the scan prompt required a baseline measurement, but these repos have nothing the agent can measure without editing files. Before adding it back:

- give it a repeatable benchmark, or CI timing history, it can run read-only
- trigger it on a measured regression (a slower test suite, build or bundle) rather than on a timer
