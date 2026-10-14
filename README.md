# Milo

Milo maintains JavaScript and TypeScript repos through GitHub issues and pull requests. You approve tickets; Milo makes changes and runs your checks; you review and merge.

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

3. Add `.github/workflows/milo.yml`. This example pins Milo to a full commit SHA:

```yaml
name: Milo dependencies
on:
  schedule:
    - cron: '0 6 * * 1'
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: milo-dependencies
  cancel-in-progress: false
jobs:
  maintain:
    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest
    environment: maintenance
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
      - uses: zeistapp/milo@43f62e58a9e4b699924ee8e08f9c531cbed3dc80
        with:
          action: task
          category: dependencies
          period: week
          codex-version: ${{ vars.CODEX_VERSION }}
        env:
          GH_TOKEN: ${{ secrets.MILO_GITHUB_TOKEN }}
          CODEX_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

4. Commit both files to your default branch and run the workflow. Approve a generated issue by adding `milo:ready`, then rerun. Milo opens a PR after your checks pass. Review and merge it yourself.

Copy the workflow for `security`, `architecture`, `cleanup`, `organisation` or `performance`. Give each its own concurrency group, cron and ticket period (`day`, `week`, `month`). For PR reviews and requested revisions, use a separate workflow with `action: reviews`, no `category`, and its own group.

## Agent choice

Choose the provider and model in your config:

```json
{
  "agent": { "provider": "claude", "model": "MODEL_ID" },
  "repos": [{ "name": "YOUR_OWNER/YOUR_REPO", "autoReady": [] }]
}
```

Use `codex` or `claude`. Replace `MODEL_ID` with a supported model ID. Omit `model` to use the CLI default. An alias such as `sonnet` follows provider updates; use an exact version ID to pin a release.

For Claude, replace `codex-version` with `claude-version: ${{ vars.CLAUDE_VERSION }}` in the workflow and replace its `CODEX_API_KEY` environment entry with `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`. Set an exact `CLAUDE_VERSION` of 2.1.296 or newer and add the matching secret.

See [local runs, permissions and advanced configuration](docs/usage.md).

Licensed under [MIT](LICENSE), copyright 2026 zeist.
