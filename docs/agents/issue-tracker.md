# Issue tracker: GitHub

Development issues and specs live in GitHub Issues. Use the gh CLI.

Infer the repository from its GitHub remote. If no remote is configured, require an explicit owner/repository before publishing anything.

## Conventions

- Create: `rtk gh issue create --repo owner/repo --title "..." --body-file path`
- Read: `rtk gh issue view NUMBER --repo owner/repo --comments`
- List: `rtk gh issue list --repo owner/repo --state open --json number,title,body,labels`
- Comment: `rtk gh issue comment NUMBER --repo owner/repo --body-file path`
- Label: `rtk gh issue edit NUMBER --repo owner/repo --add-label LABEL`
- Remove label: `rtk gh issue edit NUMBER --repo owner/repo --remove-label LABEL`
- Close: `rtk gh issue close NUMBER --repo owner/repo`

Use a temporary file for multiline bodies. Publishing to the issue tracker means creating a GitHub issue. Fetching a ticket means reading that issue and its comments.

## Pull requests as a triage surface

PRs as a request surface: no.

## Wayfinding

Keep one map issue labelled `wayfinder:map`, with linked child issues. Use sub-issues and native dependencies where available; otherwise use a task list, `Part of #NUMBER`, and `Blocked by: #NUMBER` references. Claim a ticket by assigning it before work. Resolve it with an answer, close it, and add the result to the map's decisions.
