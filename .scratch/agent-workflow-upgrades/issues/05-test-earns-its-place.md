# 05: Hold tests to "can it catch a real bug"

**What to build:** Adopt the rule from Matt's testing standards: a test must be able to fail for a plausible real bug in behaviour a user or caller observes. It complements mutation testing: Stryker finds tests that miss bugs, this finds tests that can never catch one. The simplify scan may propose deleting tests that fail the bar: tautologies (a mock returning what it was told, a restated constant or snapshot of static markup), tests of implementation details (call counts, call order, private state), near-duplicates of the same rule at the same seam, tests of pass-through glue, and tests of third-party behaviour. Review flags new tests in a PR that fail the same bar.

Before deleting a test, check it is not the last guard on a real rule; if it is, keep it or fold its assertion into a survivor. Regression tests from a past bug fix stay.

**Blocked by:** 01

**Status:** ready-for-agent
- [ ] The simplify area names the test bar and the five kinds of test that fail it
- [ ] Simplify deletions keep the last guard on each real rule and keep regression tests
- [ ] The review prompt flags new tests that fail the bar
- [ ] The rule appears once, not repeated across prompts
