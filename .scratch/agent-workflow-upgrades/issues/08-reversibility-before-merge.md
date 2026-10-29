# 08: Require a reversibility call before a merge verdict

**What to build:** Auto-merge is the one step Milo takes with no human. The deterministic merge blocker catches mechanical risk (size, dependency changes, binary files) but not risk in meaning: a small diff that changes a public API, a stored data format, a migration or user-visible behaviour. Have the reviewer state whether the change is a two-way door (easily reverted, small blast radius) or a one-way door, with one line naming the blast radius. A one-way door holds the merge for a human, whatever the verdict.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] The review result carries a reversibility field and a blast-radius line
- [ ] A one-way door, or a missing field, holds auto-merge with that reason in the review note
- [ ] The deterministic merge blocker still applies on top
- [ ] Tests cover two-way, one-way and missing reversibility with each verdict
