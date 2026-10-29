# 02: Read agent results as structured output

**What to build:** Milo finds `Title:`, `Verdict:` and `Ready:` lines in free-text reports with deliberately forgiving regexes, and several past fixes only widened them. A report they cannot read throws after the whole scan or review has been paid for. Ask the Claude provider for structured output instead, using the CLI's `--json-schema` flag with a Zod-derived schema, and read the validated object: scan result (clean, or title and body), verifier result (clean, or title, body and ready), review result (verdict and body).

If the output fails validation, resume the same session once with the validation error rather than redoing the work. That needs session persistence for the call, which Milo disables today; keep sessions in the run's temporary home so nothing outlives the run.

The custom `agent.command` provider has no schema flag. Keep the text parsing for it, or document that it must emit the same JSON.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Scan, verify and review results are parsed from a validated schema for the Claude provider
- [ ] A malformed result triggers one in-session repair attempt before the run fails
- [ ] Text parsing that only served the Claude provider is deleted
- [ ] The rule that a verdict quoted from the diff or ticket cannot set the review verdict still holds
- [ ] Tests cover a valid result, a repaired result and a result that stays invalid
- [ ] Confirm the result field name and flag behaviour against the installed Claude Code version before relying on them
