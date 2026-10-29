# 09: Review with a different model from the implementer

**What to build:** The review runs in a fresh context but on the same model as the implementer, so it tends to share the implementer's blind spots. Add an optional `agent.reviewModel`, beside the existing `scanModel`, used for PR reviews. Leave it unset by default so current configs behave as today, and document it next to `scanModel`.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `agent.reviewModel` is accepted by the config schema and used only for PR reviews
- [ ] Without it, reviews use `agent.model` as today
- [ ] The usage docs describe it
- [ ] A test covers the model chosen for a review with and without the setting
