# 09: Review with a different model from the implementer

**What to build:** The review runs in a fresh context but on the same model as the implementer, so it tends to share the implementer's blind spots. Add an optional `agent.reviewModel`, beside the existing `scanModel`, used for PR reviews. Leave it unset by default so current configs behave as today, and document it next to `scanModel`.

**Blocked by:** None (can start immediately)

**Status:** done in 2f90d10

Milo's own `milo.config.json` reviews with Claude Sonnet 5.5: a different model from the Opus 5.5 implementer at half its per-token price. Fable 5.1 was rejected on cost (2.5x Opus 5.5).
- [x] `agent.reviewModel` is accepted by the config schema and used only for PR reviews
- [x] Without it, reviews use `agent.model` as today
- [x] The usage docs describe it
- [x] A test covers the model chosen for a review with and without the setting
