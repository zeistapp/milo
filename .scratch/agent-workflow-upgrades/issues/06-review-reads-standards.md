# 06: Review against the repo's own standards files

**What to build:** The harness tells every agent to read AGENTS.md and CLAUDE.md, but many repos keep their rules in `CODING_STANDARDS.md` or `CONTRIBUTING.md`. The implementer is under the most context pressure and the most likely to miss them, so make the reviewer enforce them: the review reads every standards file the repo has (at least those two when present) and reports violations in changed code as findings, citing the rule.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The review prompt names `CODING_STANDARDS.md` and `CONTRIBUTING.md`, and other standards docs they link to, as rules to check the diff against
- [ ] Findings cite the rule they break
- [ ] Repos without these files review exactly as before
