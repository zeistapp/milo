# Milo

Milo keeps improving your JavaScript or TypeScript repo, the way a senior full-stack engineer would if they reviewed it every day. It opens a GitHub issue only for a real, important problem it has verified in your code. You approve it; Milo makes the change and runs your checks; you review and merge.

It runs in GitHub Actions. No server or local daemon is needed. Vite, Astro, React, Next.js, Hono and other tools work through your existing package scripts.

## What Milo does

Every six hours Milo works the oldest approved ticket and reviews open Milo PRs. Once a day it scans for security, bugs and architecture, and every third day for simplify. Each scan stays in its own area:

| Task         | What it does                                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security     | Reviews authentication, authorisation, injection, secret handling and data crossing trust boundaries, and shows the exploit path.                                             |
| Bugs         | Finds behaviour that is wrong today: unhandled edge cases, races and stuck state. Each fix comes with a test that fails before it.                                            |
| Architecture | Starts from recent hot spots and proposes one change that makes modules deeper and easier to test.                                                                            |
| Simplify     | Makes code shorter and clearer without changing behaviour: removes dead code and duplication, and uses modern native features.                                                |
| PR reviews   | Reviews each commit on Milo's PRs by running the code, fixes what the review finds (up to twice per PR), and addresses **Changes requested** reviews from repository writers. |

## Set up your repo

Use the public `zeistapp/milo` action from any GitHub repository.
1. Add `milo.config.json`, replacing `YOUR_OWNER/YOUR_REPO`:

```json
{
  "agent": {
    "provider": "claude"
  },
  "repos": [{ "name": "YOUR_OWNER/YOUR_REPO", "autoReady": [] }]
}
```

2. Create a `maintenance` GitHub environment restricted to your default branch. Add secret `ANTHROPIC_API_KEY`. Then give Milo GitHub access through a [GitHub App](docs/usage.md#run-milo-as-a-github-app): add variable `MILO_APP_CLIENT_ID` and secret `MILO_APP_PRIVATE_KEY`. Milo then works as its own bot, so you can approve its PRs and no token expires.

3. Add `.github/workflows/milo.yml`. This one file stays the same forever: Milo's schedule, task list and pinned actions come from `zeistapp/milo@main`.

```yaml
name: Milo
on:
  schedule:
    - cron: "23 */6 * * *"
  workflow_dispatch:
permissions:
  contents: read
jobs:
  milo:
    uses: zeistapp/milo/.github/workflows/consumer.yml@main
    # Named, because GitHub only inherits secrets within one owner. Keep them in the maintenance environment.
    secrets:
      MILO_APP_PRIVATE_KEY: ${{ secrets.MILO_APP_PRIVATE_KEY }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

4. Commit both files to your default branch and run the workflow. When a scan finds something, Milo opens an issue with the evidence. If its verifier reproduced the problem and found nothing for you to decide, the issue is already labelled `milo:ready`; otherwise approve it by adding the label. The next run picks it up. Milo opens a PR after your checks pass. Review and merge it yourself, or let Milo merge minor PRs with [`autoMerge`](docs/usage.md#automatic-merging).

Steer Milo through the issue itself. Close a finding as **not planned** and say why in a comment; later scans won't raise it again unless the code changes in a way that answers your reason. Comment on an approved ticket to correct its plan before Milo starts. Mark a ticket as blocked by another issue and Milo waits until that issue closes.

Limit scans with `categories` in your config. Use [Dependabot](https://docs.github.com/en/code-security/dependabot) for dependency upgrades; Milo dropped its dependency and performance scans ([why](docs/adr/0001-remove-dependency-and-performance-scans.md)), and configs that still list them load without them. The retired names `cleanup` and `modernisation` still work as `simplify`, and `organisation` as `architecture`.

## Move an existing setup to automatic updates

Older setups copied one workflow per task, so schedule changes, new tasks and action pins never reached them. Switch once and you won't need to edit workflows again.
1. Delete your old Milo workflows: every file in `.github/workflows/` that uses `zeistapp/milo`.
2. Add the `milo.yml` from step 3 above. If you still use a personal token, add `MILO_GITHUB_TOKEN: ${{ secrets.MILO_GITHUB_TOKEN }}` to its `secrets:` block, or [switch to the GitHub App](docs/usage.md#run-milo-as-a-github-app).
3. Keep your `maintenance` environment, secrets and variables as they are. The `secrets:` block in `milo.yml` is required when your repo has a different owner from `zeistapp`: without it GitHub passes empty secrets.
4. If you used `categories` to limit tasks, keep it. Otherwise Milo scans security, bugs and architecture daily and simplify every third day.
5. Commit to your default branch, then run **Milo** from the Actions tab to check it works.

If a run fails, the run summary now shows the reason.

## Model

Milo runs Claude Code and picks the models: Opus 5.5 for edits and verification, Sonnet 5.5 for scans and PR reviews. Leave models out of your config and your repo follows Milo's choices as they change. To override, set a model in your config:

```json
{
  "agent": { "provider": "claude", "model": "MODEL_ID" },
  "repos": [{ "name": "YOUR_OWNER/YOUR_REPO", "autoReady": [] }]
}
```

`model` replaces every default. Milo runs edits and reviews at `medium` effort and stops any single Claude call at $5; change these with `agent.effort` and `agent.maxBudgetUsd`. An alias such as `sonnet` follows Anthropic's updates; use an exact version ID to pin a release. Set `agent.scanModel` or `agent.reviewModel` to override only scans or only reviews ([details](docs/usage.md)).

Milo installs the Claude Code version it has tested and updates it through `@main`; set a `CLAUDE_VERSION` variable (2.1.296 or newer) only to pin your own.

See [local runs, permissions and advanced configuration](docs/usage.md).

Licensed under [MIT](LICENSE), copyright 2026 zeist.
