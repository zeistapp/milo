# 04: Give the implementer maintainers' ticket comments

**What to build:** The implementer sees only the ticket's title, body and creation date. A maintainer's comment such as "use the existing helper", "not this module" or "already fixed" never reaches it, so Milo can build a PR the maintainer already knew was wrong. Pass comments from repository writers and from Milo itself to the implementer, in order, as data. Comments from anyone else stay out, because ticket text is a trust boundary. Treat a new writer comment during the run like an edit to the ticket: stop with "ticket changed during execution".

**Blocked by:** None (can start immediately)

**Status:** done in 50114b4

The permission endpoint answers `none` for bots and `read` for outsiders, so unknown commenters are excluded without failing the run. Any change to the trusted comments (new, edited or deleted) stops the run.
- [x] The implement prompt includes writer and Milo comments, oldest first, marked as data
- [x] Comments from users without write access are excluded
- [x] A writer comment added mid-run stops the run before a PR opens
- [x] Tests cover writer, Milo and outside comments, and the mid-run case
