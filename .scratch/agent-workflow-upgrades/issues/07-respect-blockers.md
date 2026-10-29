# 07: Skip tickets whose blockers are still open

**What to build:** The task runner works the oldest ready ticket without checking GitHub's issue dependencies. A ticket a maintainer marked as blocked by another can start first and build on code that is about to change. Skip a ready ticket that has an open blocking issue and move to the next one; it becomes eligible once its blockers close, with no label change needed.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A ready ticket with an open blocker is skipped and the next eligible ticket runs
- [ ] A ticket whose blockers are all closed runs as normal
- [ ] Repos or API responses without dependency data behave as today
- [ ] A test covers blocked, unblocked and missing-data tickets
- [ ] Confirm the dependency fields against GitHub's current REST issue response before relying on them
