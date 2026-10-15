# Milo

Milo maintains JavaScript and TypeScript repos through GitHub issues and pull requests. Milo scans your code and opens an issue only when it finds something worth changing. You approve it; Milo makes the change and runs your checks; you review and merge.

It runs in GitHub Actions. No server or local daemon is needed. Vite, Astro, React, Next.js, Hono and other tools work through your existing package scripts.

## Set up your repo

Use the public `zeistapp/milo` action from any GitHub repository.

1. Add `milo.config.json`, replacing `YOUR_OWNER/YOUR_REPO`:

```json
{
  "agent": {
    "provider": "codex"
  },
  "repos": [{ "name": "YOUR_OWNER/YOUR_REPO", "autoReady": [] }]
}
```

2. Create a `maintenance` GitHub environment restricted to your default branch. Add secrets `OPENAI_API_KEY` and `MILO_GITHUB_TOKEN`, plus variable `CODEX_VERSION` with an exact tested Codex CLI version. The GitHub token needs Contents, Issues and Pull requests write permissions and Metadata read access for the target repo.

3. Add `.github/workflows/milo.yml`. This one file stays the same forever: Milo's schedule, task list and pinned actions come from `zeistapp/milo@main`.

```yaml
name: Milo
on:
  schedule:
    - cron: '23 */2 * * *'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  milo:
    uses: zeistapp/milo/.github/workflows/consumer.yml@main
    # Named, because GitHub only inherits secrets within one owner. Keep them in the maintenance environment.
    secrets:
      MILO_GITHUB_TOKEN: ${{ secrets.MILO_GITHUB_TOKEN }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

4. Commit both files to your default branch and run the workflow. When a scan finds something, Milo opens an issue with the evidence. Approve it by adding `milo:ready`; the next run of that category picks it up. Milo opens a PR after your checks pass. Review and merge it yourself, or let Milo merge minor PRs with [`autoMerge`](docs/usage.md#automatic-merging).

Every run reviews open Milo PRs. Between 02:00 and 05:59 UTC it also runs security daily and one weekly task: dependencies Monday, architecture Tuesday, cleanup Wednesday, modernisation Thursday, performance Friday and organisation Saturday. A manual run starts every task. Limit tasks with `categories` in your config.

## Move an existing setup to automatic updates

Older setups copied one workflow per task, so schedule changes, new tasks and action pins never reached them. Switch once and you won't need to edit workflows again.

1. Delete your old Milo workflows: every file in `.github/workflows/` that uses `zeistapp/milo`.
2. Add the `milo.yml` from step 3 above.
3. Keep your `maintenance` environment, secrets and variables as they are. The `secrets:` block in `milo.yml` is required when your repo has a different owner from `zeistapp`: without it GitHub passes empty secrets.
4. If you used `categories` to limit tasks, keep it. Otherwise Milo now runs all seven, including the new `modernisation` task.
5. Optional: let Milo merge minor dependency PRs by adding `"autoReady": ["dependencies"], "autoMerge": ["dependencies"]` to your repo entry. See [automatic merging](docs/usage.md#automatic-merging) for what that needs.
6. Commit to your default branch, then run **Milo** from the Actions tab to check it works.

If a run fails, the run summary now shows the reason.

## Agent choice

Choose the provider and model in your config:

```json
{
  "agent": { "provider": "claude", "model": "MODEL_ID" },
  "repos": [{ "name": "YOUR_OWNER/YOUR_REPO", "autoReady": [] }]
}
```

Use `codex` or `claude`. Replace `MODEL_ID` with a supported model ID. Omit `model` to use the CLI default. An alias such as `sonnet` follows provider updates; use an exact version ID to pin a release.

For Claude, add an `ANTHROPIC_API_KEY` secret to the `maintenance` environment instead of the OpenAI pair. Milo installs the Claude Code version it has tested and updates it through `@main`; set a `CLAUDE_VERSION` variable (2.1.296 or newer) only to pin your own. Each run installs and checks only the agent your config's `provider` names.

See [local runs, permissions and advanced configuration](docs/usage.md).

Licensed under [MIT](LICENSE), copyright 2026 zeist.
