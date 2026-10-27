# Milo usage guide

Milo maintains JavaScript and TypeScript repos through GitHub tickets and reviewed pull requests. It runs on Bun, locally or in GitHub Actions. No server or local daemon is required.

Separate runners cover dependencies, security, bugs, architecture, simplify, performance and PR reviews. Every agent call receives the shared guidelines in `src/guidelines.txt` (Milo's objective as a senior full-stack engineer reviewing the codebase daily, plus long-term architecture principles and coding and writing standards) ahead of the harness policy. Each run first works the oldest approved ticket, then scans read-only. A scan that finds nothing leaves no issue; a finding becomes an issue with evidence and acceptance criteria. Add `milo:ready` to approve it. Milo clones the repo, checks its baseline, runs the agent, installs from the resulting lockfile, reruns checks and opens a linked PR. The review runner checks each PR commit and addresses a repository writer's **Changes requested** review. Humans merge, except for categories you list in `autoMerge`.

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

Requires Bun 1.4.3+, Git, GitHub CLI and a configured agent. Edit `milo.config.json` with repos you own. Install Claude Code 2.1.296+ and set `ANTHROPIC_API_KEY`.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint:ci
bun test
bun run milo validate
bun run milo inspect /path/to/project  # Show detected packages/checks, no execution
bun run milo check /path/to/disposable-checkout --report-dir .milo/runs/local
gh auth login
bun run milo plan                     # Scan and print findings, no GitHub writes
bun run milo plan --apply             # Scan and open issues for findings
bun run milo --repo owner/repo work 12
bun run milo --repo owner/repo review 34
bun run milo --repo owner/repo revise 34
bun run milo tick
bun run milo --config examples/ecosystem.json --category security --period day task
bun run milo --config examples/ecosystem.json reviews
```

The agent reads its prompt from stdin. A custom `agent.command` is an argv array: `{output}` is the final report path and `{sandbox}` is `workspace-write` or `read-only`. Use it to run another agent or a sandboxed wrapper.

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

Setup and check steps run in a sandbox: bubblewrap on Linux, Apple's built-in sandbox on macOS. They can write only to the clone (not `.git`), a scratch home that is also their temp folder, and `/tmp`. They cannot read other processes' environments, so they cannot reach Milo's tokens, and credential folders such as `~/.ssh` and `~/.config/gh` are hidden. On Linux, processes a step leaves running are killed when it ends. Steps that write elsewhere, such as global tool installs, fail. The agent's own sandboxed shell uses the same scratch home, so it can run what setup installed, such as Playwright's browsers. The action installs bubblewrap on Linux runners; self-hosted Linux runners need it installed with unprivileged user namespaces allowed.

Steps run without sudo, so they cannot install system packages. List the ones they need in the repo entry, such as `"systemPackages": ["ffmpeg", "rsync"]`. On Linux, Milo installs a repo's packages with `apt-get`, outside the sandbox, just before that repo's first setup step, so runs that only triage, review or scan skip the install. The action caches the downloaded `.deb` files per runner image. Entries must be plain Debian package names: no options, `.deb` paths or version pins. On macOS the action skips them with a warning, and local runs never install them, so install them yourself there. A step can start its own bubblewrap sandbox inside Milo's; CI checks this on Ubuntu.

Discovery skips dependency/generated directories, but can find example and fixture packages. Use explicit commands to define the intended CI boundary. For efficient task-graph builds, configure a root aggregate command instead of repeating each package's scripts.

The local `check` command runs setup and validation in the same sandbox as scheduled work, without GitHub writes or agent calls. It saves a JSON report and private command logs, continues after failed checks, and skips checks when setup fails. Scripts can write generated files, so use a disposable checkout to preserve your working tree. The `examples/ecosystem.json` template shows a monorepo pipeline with six Wrangler deployment dry runs. Replace its repository name and example API URL before using it. Astro SSR checks use the generated deployment configs; other Workers use their source configs. These checks validate local bundles and configuration without uploading. They do not check live Cloudflare resources, secrets, DNS, migration safety or deployed health. Use the preset only in a disposable checkout, since setup replaces `.dev.vars` with the tracked example.

Run the same checks in your CI, so CI and Milo's baseline share one list in `milo.config.json`:

```yaml
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: zeistapp/milo@main
        with:
          action: check
```

`action: check` lints the repo's workflows with actionlint on Linux, installs the calling repository's `systemPackages`, then runs its setup and checks in the sandbox and prints each failed step's output. It needs no secrets.

## Agents, models and credentials

Set `agent.provider` to `claude` and optionally choose `agent.model` and `agent.scanModel`:

```json
{
  "agent": { "provider": "claude", "model": "MODEL_ID", "scanModel": "SCAN_MODEL_ID", "timeoutSeconds": 1800 },
  "repos": [{ "name": "owner/product", "autoReady": [] }]
}
```

Replace `MODEL_ID` with a model supported by your CLI and account. Milo passes it through `--model`, overriding the CLI default. Use an exact version ID to pin a release; aliases can change. Omit `model` to use the CLI's default. `scanModel` applies only to read-only scans, which run once per category, so a cheaper model there cuts most of the cost; omit it to scan with `model`. Milo maintains no fixed list of models, so new IDs do not require a Milo update. Unsupported models fail the task. See the [Claude command reference](https://code.claude.com/docs/en/cli-reference).

Add the `ANTHROPIC_API_KEY` secret to the `maintenance` environment. The action's `claude-version` input takes an exact version, 2.1.296+; the shared workflow defaults to Milo's tested version, and an optional `CLAUDE_VERSION` variable overrides it. Configs with a custom `agent.command` install nothing. CLI version and model version are separate choices. Milo's Claude adapter uses bare mode and requires API authentication rather than a subscription login.

Claude receives the prompt through stdin. Milo validates its JSON result and saves the final report through the same checks as a custom agent's. Errors, denied permissions, empty reports and oversized reports stop the task. Scans and reviews expose Read, Glob, Grep, WebFetch, WebSearch and sandboxed Bash, with the whole repository denied for writes, so they can search, read git history and query the npm registry but not edit.

Editing tasks add Edit and Write, and the sandbox allows writes outside protected directories. Restricted mode confines file tools to the working directory; bare mode disables automatic project customizations, so Milo passes the repository with `--add-dir` to load its CLAUDE.md files. MCP servers and slash commands are disabled. Tasks cannot change AGENTS.md, CLAUDE.md or `.claude/`. The Bash sandbox must be available, has no unsandboxed fallback, denies credential directories and protected automation directories, and strips provider keys from sandboxed commands. Shell network access is limited to the npm registry; web tools remain available for documentation. Other package registries or tools needing additional shell network access may require a custom adapter. Linux requires bubblewrap and socat. The action installs these on Ubuntu/Debian runners and adds the documented bubblewrap AppArmor profile if required; self-hosted runners need sudo access or a prepared installation. macOS uses its built-in sandbox.

These controls do not isolate all host processes. Use disposable runners for trusted repos, or a container/VM for stronger isolation. Automated tests use simulated CLI results. A [live Claude Opus 5.5 dependency audit of Milo](https://github.com/zeistapp/milo/actions/runs/38521719265) also passed: the agent verified current registry versions and the harness passed lint, types, all 37 tests and build. The agent used direct npm registry queries because `bun outdated` hit a sandbox temp-directory restriction; no dependency changes were needed.

Existing `agent.command` configs still work for custom agents. Choose either `provider` or `command`, not both. Put model flags directly in a custom command. The command must read stdin, write its report to `{output}`, and enforce `{sandbox}`. Milo retains agent credentials for agent execution and strips common provider keys from repository setup/check subprocesses. A GitHub token is separate and grants repository access, not model access.

## Run Milo as a GitHub App

With a personal token, Milo's issues and PRs show as you, so you can't approve its PRs, and the token expires. A GitHub App gives Milo its own `<app-name>[bot]` identity for issues, PRs, comments and commits, with tokens that renew on every run.

1. [Register an App](https://github.com/settings/apps/new?url=https://github.com/zeistapp/milo&public=true&webhook_active=false&contents=write&issues=write&pull_requests=write&checks=read&statuses=read). The link fills in the permissions Milo needs: Contents, Issues and Pull requests write; Checks and Commit statuses read. Pick a name no GitHub user or App already has. For an organization, open the same link with `https://github.com/organizations/ORG/settings/apps/new` instead.
2. On the App's settings page, note the Client ID. Then open **Credentials → Key pairs** in the left sidebar and click **New key** to download a private key.
3. Install the App on every repo Milo maintains.
4. In each repo's `maintenance` environment, add variable `MILO_APP_CLIENT_ID` and secret `MILO_APP_PRIVATE_KEY` (the whole `.pem` file).
5. Add `MILO_APP_PRIVATE_KEY: ${{ secrets.MILO_APP_PRIVATE_KEY }}` to the `secrets:` block of each repo's `milo.yml`.

Milo uses the App whenever `MILO_APP_CLIENT_ID` is set. Otherwise it uses a personal token in secret `MILO_GITHUB_TOKEN`, which `milo.yml` must pass with `MILO_GITHUB_TOKEN: ${{ secrets.MILO_GITHUB_TOKEN }}`; Milo then acts as you. Delete the personal token once a run succeeds. After the switch, Milo reviews each open PR once more, because it no longer recognises reviews it posted under the old identity.

The link registers a public App, so you can install it on every account you own. Anyone else can install it too, but that gives them nothing. Never give its private key to anyone else: whoever holds it can act as the App on every account that installed it, including yours. Other people should register their own App with the link above.

An App token covers repos under the calling repo's owner, so a config that targets repos under another owner still needs `MILO_GITHUB_TOKEN`. It also lasts one hour: a run that goes longer loses GitHub access partway, and the next run picks up the remaining scans. A ticket that takes over an hour to work is retried rather than blocked, so raise `agent.timeoutSeconds` with care.

## Host and distribute

Milo's own `milo.config.json` targets `zeistapp/milo` with Claude Opus 5.5 (`claude-opus-5-5`) and scans with Claude Sonnet 5.5 (`claude-sonnet-5-5`). Its `maintenance` environment allows only `main`, sets `CLAUDE_VERSION` to `2.1.296` (the same as the default), and needs `ANTHROPIC_API_KEY`. Milo acts as the `milo-maintainer` GitHub App through `MILO_APP_CLIENT_ID` and `MILO_APP_PRIVATE_KEY`; see [Run Milo as a GitHub App](#run-milo-as-a-github-app). Add the secrets under Settings → Environments → maintenance. Run the Manual maintenance workflow with `action: plan` to scan every category, then add `milo:ready` to the findings you want worked. Scheduled runners scan again at their configured intervals; `autoReady: []` requires approval before agent edits.

Push Milo to GitHub. Restrict a `maintenance` environment to the default branch and set `MILO_GITHUB_TOKEN` and `ANTHROPIC_API_KEY` as secrets; `CLAUDE_VERSION` is optional. Use a fine-grained user token with Contents, Issues and Pull requests write permissions, and Metadata read access, restricted to the ecosystem and Milo repos. Or [run Milo as a GitHub App](#run-milo-as-a-github-app). The [default workflow token](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token) only covers its own repo.

Consumers and Milo itself use the same two-line `milo.yml` caller, which runs every six hours and calls `consumer.yml`. That workflow calls the shared `maintenance.yml` once for tasks and once for reviews. Schedule, task list and action pins therefore update for every consumer through `@main`. The shared workflow selects `milo.config.json`, adds the calling repository as a target, and runs only on the default branch. Configured targets require ticket approval by default. Milo works any approved custom ticket written by a repository writer; it skips tickets from anyone else, because their authors could edit them after approval. Add a `milo:<category>` label if that category is in `autoMerge` and you want Milo to merge it.

| Runner | Interval |
| --- | --- |
| Approved tickets, one per run | Every run (six hours) |
| PR reviews, revisions and merges | Every run |
| Scans of every category | Once per UTC day |

The first run of each UTC day scans every category in turn; the category label's description records the scan (`Milo scanned 2026-10-16`), so later runs that day skip it. A missed or late scheduled run just moves the scan to the next run. Milo also skips a category's scan while it has an open ticket, so triage or close findings to keep scans running. Categories a repo excludes through `categories` are skipped. Tasks share one concurrency group and reviews share another. The Manual maintenance workflow supports targeted tasks and individual issue/PR operations. To keep your own cron and periods instead, call `zeistapp/milo/.github/workflows/maintenance.yml@main` from your own workflows with `action`, `category` and `period`; those copies don't receive schedule changes.

Other users can invoke this [composite action](https://docs.github.com/en/actions/tutorials/create-actions/create-a-composite-action) using `zeistapp/milo@main`, after checking out their config. This automatically follows updates to Milo's main branch. For a dedicated runner, pass `action: task`, `category`, `period`, a pinned `claude-version`, and `GH_TOKEN`/`ANTHROPIC_API_KEY` through the step environment. Use `action: reviews` for the review queue. Omit `claude-version` when supplying an installed custom agent. Linux and macOS are supported; Windows is not supported yet.

Require target-repo CI and human approval through branch rules, dismissing stale approvals after updates. Milo does not install CI or branch rules in other repos. Automated reviews are advisory comments, and Milo merges nothing unless you opt in with `autoMerge`. Start with `autoReady: []`; add categories once you trust their results. A tick runs at most one new task and one review/revision per repo. Set provider spending limits for a hard billing cap. Avoid overlapping local runs; the workflow serialises scheduled runs.

## Automatic merging

List categories in a repo's `autoMerge` to let Milo merge their PRs without a human, for example `"autoReady": ["dependencies"], "autoMerge": ["dependencies"]`. Milo merges a PR only when all of these hold:

- The reviewer agent ends its review with `Verdict: merge` (minor, non-breaking, in scope and tested).
- The change is at most 300 lines outside lockfiles, has no binary files, and adds or removes no dependencies or package manifests.
- Every changed dependency is a plain semver version and stays within its current major (or minor below 1.0).
- A later review run finds at least one CI check on that exact commit, and all of them passed.
- No one's latest review requests changes, and the branch is not behind its base. Milo updates a stale branch, then reviews and checks the new commit again.

Merges use squash and pin the reviewed commit. Branch rules still apply, so a rule requiring human approval keeps these PRs waiting. Your repo must run CI on pull requests; Milo's own checks are not enough on their own. The token also needs Checks and Commit statuses read access.

## Recovery and boundaries

Failures label tickets `milo:blocked` and print the reason as a run annotation. Reproduce the failed configured command locally, fix it and remove the label. Command output is withheld from logs to avoid publishing secrets. In a private repo, a failed run uploads each step's output and the agent's report as a `milo-logs-*` artifact, kept for three days. Broken baselines stop before the agent. Retries recover pushed branches, and concurrent PR updates stop publication. No-change tasks close with a report; merged PRs close their tickets. Closed unmerged PRs require human triage. Older reviews need resubmission on the current commit before another revision.

Use disposable runners for trusted repos. GitHub tokens are stripped from agent/check environments, setup and check steps run sandboxed, Git credential helpers are disabled there, and policy/automation file changes are rejected. This is defence in depth, not full isolation: steps keep network access and can read most of the runner's files. Use a container or VM for stronger isolation. Keep sensitive security findings private and enable dependency alerts, secret scanning and code scanning where available.

CI runs Biome formatting/lint checks, types, tests, build and the composite entry point on Linux and macOS. A separate job validates all workflow files with checksum-verified, pinned actionlint. Local flow tests use real Git with a simulated agent and GitHub boundary. Live GitHub/model runs require credentials and are not covered by these tests.
