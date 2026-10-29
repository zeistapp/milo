# 06: Review against the repo's own standards files

**What to build:** The harness tells every agent to read AGENTS.md and CLAUDE.md, but many repos keep their rules in `CODING_STANDARDS.md` or `CONTRIBUTING.md`. The implementer is under the most context pressure and the most likely to miss them, so make the reviewer enforce them: the review reads every standards file the repo has (at least those two when present) and reports violations in changed code as findings, citing the rule.

Do the same for Milo's own rules. The review prompt (`src/runner.ts`, the architecture line) checks correctness, security, scope, testing and architecture, but not the "Code" section of `src/guidelines.txt` that the implementer works under. So a diff with a speculative abstraction or new dependency, a patch to one caller of a shared function while its siblings stay broken, or an unmarked corner-cut with no `CEILING:` comment passes review. Add one clause naming these.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
- [ ] The review prompt names `CODING_STANDARDS.md` and `CONTRIBUTING.md`, and other standards docs they link to, as rules to check the diff against
- [ ] Findings cite the rule they break
- [ ] The review prompt flags speculative abstractions or dependencies, a fix applied to one caller instead of the shared function, and a corner-cut without a `CEILING:` comment
- [ ] Repos without these files review exactly as before
