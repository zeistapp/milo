# Milo usage guide

Milo maintains JavaScript and TypeScript repos through GitHub tickets and reviewed pull requests. It runs on Bun, locally or in GitHub Actions. No server or local daemon is required.

Separate runners cover dependencies, security, architecture, cleanup, organisation, performance and PR reviews. Add `milo:ready` to approve a ticket. Milo clones the repo, checks its baseline, runs the agent, installs from the resulting lockfile, reruns checks and opens a linked PR. The review runner checks each PR commit and addresses a repository writer's **Changes requested** review. Humans control merging.

## Your frameworks and build patterns

Validation comes from existing package scripts, rather than a closed list of adapters. Framework detection gives the agent context. Unknown tools work when the repo provides runnable checks.

| Project | Checks and review context |
| --- | --- |
| Vite, React, vanilla JS | Repo checks, tests and production builds |
| Astro | Repo check/build scripts, islands and deployment adapters |
| Next.js | Typechecks, lint, tests and builds; server/client boundaries |
| Hono and other servers | Route and middleware tests, runtime bindings, auth and validation |
| Vue, Nuxt, SvelteKit, Angular, Solid, TanStack Start and others | Repo scripts and dependency versions |
| Libraries | Tests, builds, exports, peer dependencies and consumer compatibility |
| Monorepos, Turborepo, Nx, custom pipelines | Package scripts or explicit aggregate commands |

Milo detects Bun, npm, pnpm and Yarn from lockfiles and `packageManager`. Frozen installs preserve the package manager. Its binary must be available on the runner. Milo running on Bun does not change the target application's runtime. Plain JS repos do not need TypeScript.

Discovery selects existing typecheck, check, lint, test and build scripts, including common CI aliases. Vitest runs once; Jest receives its CI flag. Explicit watch/interactive scripts are rejected. Missing tests or typechecks are reported as gaps. Repos without runnable checks are blocked. A successful bundler build is not treated as proof of type safety.

The agent receives dependency declarations and must consult current official documentation for unfamiliar APIs and upgrades. Detection tests use manifest fixtures, not complete application suites for every framework release. No blanket compatibility claim is made for every latest release.

## Run locally

Requires Bun 1.4.3+, Git, GitHub CLI and a configured agent. Edit `milo.config.json` with repos you own. Install and authenticate the agent; the example uses [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint:ci
bun test
bun run milo validate
bun run milo inspect /path/to/project  # Show detected packages/checks, no execution
bun run milo check /path/to/disposable-checkout --report-dir .milo/runs/local
gh auth login
bun run milo plan                     # Preview tickets, no writes or agent calls
bun run milo plan --apply
bun run milo --repo owner/repo work 12
bun run milo --repo owner/repo review 34
bun run milo --repo owner/repo revise 34
bun run milo tick
bun run milo --config examples/ecosystem.json --category security --period day task
bun run milo --config examples/ecosystem.json reviews
```

The agent reads its prompt from stdin. `agent.command` is an argv array: `{output}` is the final report path and `{sandbox}` is `workspace-write` or `read-only`. Replace it to use another agent or a sandboxed wrapper.

For unusual scripts, integration services or an aggregate monorepo pipeline, replace discovery with explicit commands in the repo entry:

```json
{
  "name": "owner/product",
  "autoReady": [],
  "setup": [{ "command": ["bun", "install", "--frozen-lockfile"] }],
  "checks": [
    { "command": ["bun", "run", "ci"] },
    { "command": ["bun", "run", "test:integration"], "cwd": "apps/api" }
  ]
}
```

Command directories must stay inside the repo, including through symlinks. Supply both setup and checks for a static JS repo without a package manifest or lockfile. `setup: []` deliberately skips installation; checks cannot be empty. Use validation scripts that do not deploy or modify production data.

Discovery skips dependency/generated directories, but can find example and fixture packages. Use explicit commands to define the intended CI boundary. For efficient task-graph builds, configure a root aggregate command instead of repeating each package's scripts.

The local `check` command runs setup and validation without GitHub writes or agent calls. It saves a JSON report and private command logs, continues after failed checks, and skips checks when setup fails. Scripts can write generated files, so use a disposable checkout to preserve your working tree. The `examples/ecosystem.json` template shows a monorepo pipeline with six Wrangler deployment dry runs. Replace its repository name and example API URL before using it. Astro SSR checks use the generated deployment configs; other Workers use their source configs. These checks validate local bundles and configuration without uploading. They do not check live Cloudflare resources, secrets, DNS, migration safety or deployed health. Use the preset only in a disposable checkout, since setup replaces `.dev.vars` with the tracked example.

## Agents, models and credentials

Choose `agent.provider` (`codex` or `claude`) and optionally `agent.model`:

```json
{
  "agent": { "provider": "claude", "model": "MODEL_ID", "timeoutSeconds": 1800 },
  "repos": [{ "name": "owner/product", "autoReady": [] }]
}
```

Replace `MODEL_ID` with a model supported by your CLI and account. Milo passes it through `--model`, overriding the CLI default. Use an exact version ID to pin a release; aliases can change. Omit `model` to use the CLI's default. Milo maintains no fixed list of models, so new IDs do not require a Milo update. Unsupported models fail the task. See the [Codex command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) and [Claude command reference](https://code.claude.com/docs/en/cli-reference).

| Provider | Action installation input | Agent credential |
| --- | --- | --- |
| Codex | `codex-version` (exact tested version) | `CODEX_API_KEY` (an OpenAI API key) |
| Claude Code | `claude-version` (exact version, 2.1.296+) | `ANTHROPIC_API_KEY` |

The supplied workflows map the `OPENAI_API_KEY` secret to `CODEX_API_KEY`. For Claude, change the config provider, set `CLAUDE_VERSION` and add the `ANTHROPIC_API_KEY` secret. The shared maintenance workflow accepts either version variable. Install only the chosen provider unless your configs need both. CLI version and model version are separate choices. Local Codex can use its authenticated CLI; Milo's Claude adapter uses bare mode and requires API authentication rather than a subscription login.

Claude receives the prompt through stdin. Milo validates its JSON result and saves the final report through the same checks as Codex. Errors, denied permissions, empty reports and oversized reports stop the task. Reviews receive the PR diff and expose only Read, Glob, Grep, WebFetch and WebSearch. They cannot run shell commands or use edit tools.

Editing tasks add Edit, Write and Bash. Restricted mode confines file tools to the working directory; bare mode disables automatic project customizations, and MCP servers and slash commands are disabled. The Bash sandbox must be available, has no unsandboxed fallback, denies credential directories and protected automation directories, and strips provider keys from sandboxed commands. Shell network access is limited to the npm registry; web tools remain available for documentation. Other package registries or tools needing additional shell network access may require a custom adapter. Linux requires bubblewrap and socat. The action installs these on Ubuntu/Debian runners and adds the documented bubblewrap AppArmor profile if required; self-hosted runners need sudo access or a prepared installation. macOS uses its built-in sandbox.

These controls do not isolate all host processes. Use disposable runners for trusted repos, or a container/VM for stronger isolation. Automated tests use simulated CLI results. A [live Claude Opus 5.5 dependency audit of Milo](https://github.com/zeistapp/milo/actions/runs/38521719265) also passed: the agent verified current registry versions and the harness passed lint, types, all 37 tests and build. The agent used direct npm registry queries because `bun outdated` hit a sandbox temp-directory restriction; no dependency changes were needed.

Existing `agent.command` configs still work for custom agents. Choose either `provider` or `command`, not both. Put model flags directly in a custom command. The command must read stdin, write its report to `{output}`, and enforce `{sandbox}`. Milo retains agent credentials for agent execution and strips common provider keys from repository setup/check subprocesses. A GitHub token is separate and grants repository access, not model access.

## Host and distribute

Milo's own `milo.config.json` targets `zeistapp/milo` with Claude Opus 5.5 (`claude-opus-5-5`). Its `maintenance` environment allows only `main`, pins `CLAUDE_VERSION` to `2.1.296`, and needs `ANTHROPIC_API_KEY` plus a fine-grained `MILO_GITHUB_TOKEN` scoped to this repo. Give the token Contents, Issues and Pull requests write permissions, and Metadata read access. Add the secrets under Settings → Environments → maintenance. Run the Manual maintenance workflow with `action: plan` to create initial tickets, then add `milo:ready` to approve work. Scheduled runners keep creating tickets at their configured intervals; `autoReady: []` requires approval before agent edits.

Push Milo to GitHub. Restrict a `maintenance` environment to the default branch and set `MILO_GITHUB_TOKEN` and `OPENAI_API_KEY` as secrets, plus an exact tested `CODEX_VERSION` as an environment variable. For Claude, use `ANTHROPIC_API_KEY` and `CLAUDE_VERSION` instead and change the config provider. Use a fine-grained user token with Contents, Issues and Pull requests write permissions, and Metadata read access, restricted to the ecosystem and Milo repos. GitHub App installation tokens need additional bot identity handling and are not supported yet. The [default workflow token](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token) only covers its own repo.

Each schedule calls the shared `maintenance.yml` workflow with its own category, ticket period and runner. The shared workflow selects `milo.config.json` and adds the published Milo repository as a target using `github.repository`. It runs only on the default branch. Set `include-self: false` in a caller to disable self-maintenance. Configured targets require ticket approval by default. Add a `milo:<category>` label to custom tickets so the right runner can pick them up.

| Runner | Default interval |
| --- | --- |
| Security | Daily |
| Dependencies | Weekly, Monday |
| Cleanup | Weekly, Wednesday |
| Architecture | Monthly |
| Organisation | Monthly |
| Performance | Monthly |
| PR reviews and revisions | Every two hours |

Edit each `maintenance-<task>.yml` cron independently. Times use UTC. Match its `period` to the desired ticket cadence: day, week or month. Runs of the same category are serialised; different categories run independently on their own branches. Reviews and revisions share one concurrency group. The manual workflow supports targeted tasks and individual issue/PR operations. Avoid running the legacy all-category `tick` concurrently with the separate schedules.

Other users can invoke this [composite action](https://docs.github.com/en/actions/tutorials/create-actions/create-a-composite-action) after publication using `zeistapp/milo@COMMIT_SHA`, after checking out their config. For a dedicated runner, pass `action: task`, `category`, `period`, a pinned `codex-version`, and `GH_TOKEN`/`CODEX_API_KEY` through the step environment. Use `action: reviews` for the review queue. Use `claude-version` and `ANTHROPIC_API_KEY` for the built-in Claude adapter. Omit both installation inputs when supplying an installed custom agent. There are no production npm dependencies. Linux and macOS are supported; Windows is not supported yet.

Require target-repo CI and human approval through branch rules, dismissing stale approvals after updates. Milo never merges and does not install CI or branch rules in other repos. Automated reviews are advisory comments. Start with `autoReady: []`; add categories once you trust their results. A tick runs at most one new task and one review/revision per repo. Set provider spending limits for a hard billing cap. Avoid overlapping local runs; the workflow serialises scheduled runs.

## Recovery and boundaries

Failures label tickets `milo:blocked`. Reproduce the failed configured command locally, fix it and remove the label. Command output is withheld from logs to avoid publishing secrets. Broken baselines stop before the agent. Retries recover pushed branches, and concurrent PR updates stop publication. No-change tasks close with a report; merged PRs close their tickets. Closed unmerged PRs require human triage. Older reviews need resubmission on the current commit before another revision.

Use disposable runners for trusted repos. GitHub tokens are stripped from agent/check environments, Git credential helpers are disabled there, and policy/automation file changes are rejected. This is defence in depth, not OS isolation: agents, setup scripts and repo code execute commands. Use a container or VM for stronger isolation. Keep sensitive security findings private and enable dependency alerts, secret scanning and code scanning where available.

CI runs Biome formatting/lint checks, types, tests, build and the composite entry point on Linux and macOS. A separate job validates all workflow files with checksum-verified, pinned actionlint. Local flow tests use real Git with a simulated agent and GitHub boundary. Live GitHub/model runs require credentials and are not covered by these tests.
