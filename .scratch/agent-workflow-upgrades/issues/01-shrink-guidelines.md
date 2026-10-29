# 01: Shrink the shared guidelines to Milo's own rules

**What to build:** Every agent call (scan, verify, implement, review, revise) carries the shared guidelines, now 2,278 words. Much of it was copied from a personal assistant setup and does not apply to an unattended maintenance bot: how to report to "me", writing rules for marketing copy and emails, copywriting briefs, and a "build process" for new projects. Cut the guidelines to what Milo acts on: the real-and-important bar, the long-term architecture vocabulary, minimal-code rules, UI-state-in-reducers, and the report rules. Models follow only a few hundred instructions reliably, so fewer, relevant rules cost less per call and are followed better.

Where a remaining rule is non-obvious, give it one clause naming the failure it prevents, so later edits can tell which rules still earn their place.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
- [ ] No section addresses a human reader as "me", or covers marketing copy, emails, copywriting briefs or new-project build process
- [ ] Every rule left applies to at least one of scan, verify, implement, review or revise
- [ ] Rules that the harness policy already states are not repeated in the guidelines
- [ ] The guidelines are at most half their current word count
- [ ] Lint, typecheck and tests pass
