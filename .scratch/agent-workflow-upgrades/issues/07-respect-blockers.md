# 07: Skip tickets whose blockers are still open

**What to build:** The task runner works the oldest ready ticket without checking GitHub's issue dependencies. A ticket a maintainer marked as blocked by another can start first and build on code that is about to change. Skip a ready ticket that has an open blocking issue and move to the next one; it becomes eligible once its blockers close, with no label change needed.

**Blocked by:** None (can start immediately)

**Status:** done in 50114b4

List and single-issue responses carry `issue_dependencies_summary` (checked live on zeistapp/milo). GitHub's docs do not say whether `blocked_by` counts only open blockers, so Milo reads `issues/N/dependencies/blocked_by` and checks each state when `total_blocked_by` is non-zero.
- [x] A ready ticket with an open blocker is skipped and the next eligible ticket runs
- [x] A ticket whose blockers are all closed runs as normal
- [x] Repos or API responses without dependency data behave as today
- [x] A test covers blocked, unblocked and missing-data tickets
- [x] Confirm the dependency fields against GitHub's current REST issue response before relying on them
