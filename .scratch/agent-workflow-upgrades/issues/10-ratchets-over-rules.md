# 10: Prefer ratchets to written rules

**What to build:** A mechanical rule written in prose relies on an agent remembering it. Matt's standards pair each rule with the lint rule or script that enforces it, and hold legacy violations in an allowlist that can only shrink. Bring both into Milo. The review requires that a file a PR touches leaves with no more lint warnings than it had at the merge base. The architecture scan, when its proposal is a rule that code can check, proposes the check (a lint rule, an import-boundary config, a small guard script with a shrink-only allowlist) rather than a written convention.

**Blocked by:** 01

**Status:** done in a0ee778

The reviewer lints each touched file at HEAD and at the merge base (a git worktree) and compares warning counts.
- [x] The review flags a touched file whose lint warnings grew against the merge base
- [x] The architecture area prefers an enforcing check, with a shrink-only allowlist for existing violations, over a written rule
- [x] Neither change adds a dependency to Milo itself
