# 04: Give the implementer maintainers' ticket comments

**What to build:** The implementer sees only the ticket's title, body and creation date. A maintainer's comment such as "use the existing helper", "not this module" or "already fixed" never reaches it, so Milo can build a PR the maintainer already knew was wrong. Pass comments from repository writers and from Milo itself to the implementer, in order, as data. Comments from anyone else stay out, because ticket text is a trust boundary. Treat a new writer comment during the run like an edit to the ticket: stop with "ticket changed during execution".

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The implement prompt includes writer and Milo comments, oldest first, marked as data
- [ ] Comments from users without write access are excluded
- [ ] A writer comment added mid-run stops the run before a PR opens
- [ ] Tests cover writer, Milo and outside comments, and the mid-run case
