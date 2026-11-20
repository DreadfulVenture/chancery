---
description: Produce a lane status report and one next suggested action from live Linear, Forgejo, and repo state
---

Produce a self-contained, point-in-time status report for this lane's coordinator/director session and end with exactly
one next suggested action. Compute everything fresh at send time from live tool output; do not reuse earlier
conversation state.

## Lane resolution

- Resolve the lane from the session's working repository by default: the repository/worktree name is the Linear project
  name (chancery convention). If ambiguous, resolve with `git remote get-url origin` and take the repository name. State
  the resolved lane/project and repo in the report.
- `$ARGUMENTS` may override: accept a bare project/lane name, or `lane=<project>` (and optionally `repo=<name>`). If
  provided, use it as the sweep target and still state what was resolved/used.

Arguments: $ARGUMENTS

## Required sweeps (live, no cached assumptions)

Name and use the concrete MCP/tool surfaces available in this session. If a specific tool name or field is not exposed,
fall back to the equivalent available Linear or Forgejo MCP tool/operation to retrieve the same signal and note the
limitation explicitly (never guess).

1. **Open tickets (Linear, lane project):** use Linear MCP tools to locate the project by the resolved lane name (for
   example `list_projects` / project lookup) and list its issues (for example `list_issues` scoped to that project).
   Collect open issues with identifier, title, state/status, and (if cheaply available) priority/assignee. Present them
   grouped by state (e.g. active/in progress, todo/backlog, blocked/waiting) so readiness is visible.
2. **Open PRs and CI (Forgejo, repo):** use Forgejo MCP tools to list open pull requests for the repository (for example
   list repository pull requests) and, for each PR, fetch the latest CI/check or actions-run verdict for its head commit
   (pass/fail/running/pending/unknown) using the status/checks or actions endpoints/tools exposed. Report PR number,
   title, head/base branch, and CI verdict.
3. **Recently closed work (Linear, lane project):** use Linear MCP tools (for example `list_issues` filtered to
   completed/closed/canceled states in the same project) over a practical recent window: **last 14 days, up to 10
   items**, sourced from the issue's completed/updated time as available. Report identifier, title, outcome/state, and
   closed/updated date, and state the exact window and source used.
4. **Live observable session/repo facts (not run state):** include only what is verifiable now from the worktree/repo
   (for example current branch and `git status --short` / HEAD). Do not read or reference coordinator manifests or run
   artifacts, and do not invent run state; manifests are not a delivery or state source for this report.

## Output shape

Produce a compact, scannable report containing:

- **Status table/sections:** (a) lane open tickets by state, (b) open PRs with CI verdicts, (c) recently closed work
  (with window noted). Keep entries factual.
- **One `Next suggested action:` line:** a single recommendation naming the coherent next increment and **why it is
  next**, reasoned from the swept evidence (readiness, CI blockers/failures, dependencies, and recently closed context).
  Guide the reasoning; do not prescribe outcomes.
- **`Operator decision:` lines (only if any):** surface anything requiring the operator's judgment as its own explicit
  labeled line/block, not buried in prose. Omit this section entirely if there are no operator decisions.

## Reporting discipline (comply by construction)

Follow the reporting rules in `skills/orchestrate/SKILL.md` and `skills/steer-worker/SKILL.md`: make the report
self-contained (name the lane/repo, state where each signal came from, and include the evidence needed to understand it
cold), compute and state status at send time from live tool output, never re-present answered gates or standing grants
as open, and never deliver or reference content via a coordinator manifest/run artifact. If a signal cannot be
retrieved, state that fact plainly rather than guessing.
