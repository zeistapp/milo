# 11: Look for bug-prone patterns in the bugs scan

**What to build:** Give the bugs scan a short list of patterns that often hide real defects, taken from Matt's coding standards:
- a `switch` over a union whose `default` silently absorbs members added later;
- a promise nobody awaits, handles or marks `void` with a reason, and async callbacks passed where nothing awaits them;
- throwing a value that is not an `Error`;
- an `any` outside a third-party boundary that lets a wrong type through;
- an optional parameter that callers omit by mistake;
- a function too complex to follow, where the decision belongs in a reducer or helpers.

These are leads, not findings. A ticket still needs the real-and-important bar: a failing input, trace or test.

Where the repo's linter already has a rule for a pattern, the proposed fix should prefer enabling it (see ticket 10). Check which of these Biome 2.6 supports as stable rules before naming any.

**Blocked by:** 01

**Status:** done in a0ee778

Biome 2.6.2 has stable rules for three patterns: `noExplicitAny`, `useThrowOnlyError`, `noExcessiveCognitiveComplexity`. `useExhaustiveSwitchCases`, `noFloatingPromises` and `noMisusedPromises` are still nursery, so the prompt does not name them.
- [x] The bugs area lists the patterns as places to look, not as findings in themselves
- [x] Filed tickets from these patterns still show a failing input, trace or test
- [x] Rule names cited for Biome exist in the installed version
