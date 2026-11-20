---
name: forgejo-ci
description:
  Read Forgejo Actions history end to end — given a PR, find its runs in the order they ran with each run's head sha and
  per-job outcomes; given a run, its jobs, attempts, and log URLs; given a run, the PR it came from. Covers the runs,
  tasks, jobs, and job-log endpoints, the attempt-versus-re-run distinction, and the traps that GitHub-shaped clients
  fall into on a Forgejo host. Use when investigating CI results on a Forgejo forge, or when a CI watcher or reviewer
  needs run, job, or log evidence.
license: MIT
metadata:
  audience: agents
  workflow: ci-investigation
---

# Reading Forgejo CI — PR to runs to jobs to logs

Forgejo Actions looks GitHub-compatible and is not. The endpoints that exist answer with Forgejo's own field names, the
endpoints a GitHub client expects mostly 404, and the logs live behind one working route. This skill walks the chain
that works — run, then jobs, then attempts, then logs — with commands exercised against a live Forgejo v17 host. Older
versions may differ; re-verify when the answers look wrong.

Unauthenticated GETs work on public repositories. Private repositories need a token: add
`-H "Authorization: token <token>"` to the commands below.

Throughout, `{owner}` is the repo owner and `example-repo` the repository. The forge host appears as `git.example.com`.

## The object model

Three layers, and the API names all three differently:

- **Run** — one execution of a workflow file. The number in the UI URL (`…/actions/runs/N`) is the run's
  `index_in_repo`; the task rows call the same number `run_number`. A run also has a much larger `id`, the database id,
  which the jobs endpoint keys on. The two numbers are not interchangeable.
- **Job** — one leg of a run. The jobs endpoint returns one row per job, in job-creation order: `id` (the job's database
  id, stable across attempts), `attempt` (the highest attempt number so far), `task_id`, `status`, `name`, and an
  `html_url` that already names the job's UI index and attempt.
- **Task** — one execution of one job. The `/actions/tasks` endpoint returns one row per task, so a retried job owns two
  task rows. The job log's first line names the task id (`received task <id> of job <internal-name>`).

## Given a PR — its runs in the order they ran

A pull request runs on an ephemeral CI branch the UI shows as `#<pr>`. The run list reports that in `prettyref`:

```bash
curl -s "https://git.example.com/api/v1/repos/{owner}/example-repo/actions/runs" \
  | jq -r '.workflow_runs[]
      | select(.prettyref == "#12")
      | [.index_in_repo, .status, .commit_sha[0:7], .created, .html_url] | @tsv' \
  | sort -n
```

- Call the endpoint with no page parameter and it answers with every run in one response. The `limit` parameter is
  ignored; `page` switches to 30-row pages. The no-parameter call is the dependable one.
- Rows arrive newest first, so `sort -n` restores run order.
- Each row carries `commit_sha` — the head the PR had when that run started. Only the newest run's sha equals the PR's
  current head (`GET /pulls/12` answers `head.sha`); older runs carry older heads by design. Never treat a sha mismatch
  on an older run as an anomaly.

## Given a run — its jobs, attempts, and logs

Take the run's **database id** from the run row's `id` field, not the number in the UI URL:

```bash
curl -s "https://git.example.com/api/v1/repos/{owner}/example-repo/actions/runs/<run-db-id>/jobs" \
  | jq -r '.[] | [.id, .attempt, .task_id, .status, .name] | @tsv'
```

The rows come in job-creation order, and each row's `html_url` names its position in that order and its attempt —
`…/actions/runs/<run-number>/jobs/0/attempt/1`. Count nothing by hand; read the field.

Two routes fetch a job's log, both unauthenticated on public repos:

```bash
# The API route — full plaintext, one attempt at a time
curl -s "https://git.example.com/api/v1/repos/{owner}/example-repo/actions/jobs/<job-db-id>/logs?attempt=1"

# The UI route the browser uses — same plaintext, addressed by position instead of id
curl -s "https://git.example.com/{owner}/example-repo/actions/runs/<run-number>/jobs/<index>/attempt/<n>/logs"
```

`<index>` is the 0-based position in the jobs array, `<n>` the 1-based attempt number. The log's first line names the
task id and the workflow's internal job name, which is how a log URL confirms which job it answered.

## Retried attempt, or fresh re-run?

The two look similar in a log and are different things in the data:

- **Retried attempt** — stays inside the same run. The job row's `attempt` field counts the attempts, and each attempt
  adds one task row to `/actions/tasks`: same `run_number`, same job name, higher task id, later `created_at`. Fetch
  attempt N's log with `?attempt=N` on either log route.
- **Fresh re-run** — a new run row: new `index_in_repo`, new run database id, its own task rows. It can carry the same
  `commit_sha` as the run it retriggers. Group task rows by `run_number` to tell which run a row belongs to; never by
  position.

Asking for an attempt past the last one errors with the reason in the body:
`task with job_id <id> and attempt N: resource does not exist` — **HTTP 404 on the API route, HTTP 500 on the UI
route**, same body. On either logs route, that error means "that attempt does not exist", not a broken endpoint.

## Given a run — the PR it came from

Reverse the first walk. The run row's `prettyref` (or the task rows' `head_branch`) answers it:

- `pull_request` runs carry `#<pr>` — `#12` means PR 12.
- `push` runs carry the branch name (`main`). Schedule runs carry the branch the schedule targets. For both, the branch
  alone does not name a PR; the `commit_sha` is the only link, matched against branch heads or PR heads.

## The traps

1. `/actions/runs` rows name their sha `commit_sha` and carry **no `head_sha` field**. A GitHub-shaped client reads
   `row.head_sha` as empty and concludes the data is missing. The sha is there; the field name is not.
2. `/actions/runs/<run-number>` and `/actions/runs/<run-number>/jobs` both 404. The jobs endpoint takes the run's
   database id, which only the run list (or the MCP's run listing) hands you.
3. `/actions/tasks` ignores `run_number`, `head_branch`, and `event` parameters — they answer with the unfiltered list.
   Only `?status=<status>` filters, and it filters well. Page through the endpoint and filter client-side.
4. `/actions/tasks` sorts by task id, newest execution first, across the whole repo. A retried attempt sorts wherever
   its retry landed in time, possibly far from its run's other rows. Group by `run_number`, never by adjacency.
5. The `/actions/tasks` response shape varies between a bare array and `{"workflow_runs": [...], "total_count": n}`
   depending on the call. Parse defensively: read `workflow_runs` when the body is an object, the body itself when it is
   an array.
6. An out-of-range job index on the UI log route does **not** error — it answered with a job's log anyway. Trust the
   jobs array's `html_url` fields, not your own arithmetic on the URL scheme.

## Driving the llmProxy MCP instead

When the session drives the llmProxy MCP's Forgejo tools, the same chain has three tools, and the id conventions are the
whole trick:

- `Forgejo-list_workflow_runs` renders prose: `#<db-id> (run number <n>) - <title>`, with status, event, short sha, and
  URL per run. This is the tool that maps a UI run number to the run database id. Its `head_sha` and `event` filters
  work.
- `Forgejo-list_action_run_jobs(owner, repo, run_id=<run-db-id>)` returns JSON job rows — `id`, `attempt`, `task_id`,
  `status` — with paging metadata around them.
- `Forgejo-get_action_job_logs(job_id=<job-db-id>, attempt, offset, max_bytes)` returns a bounded plaintext range.
  `job_id` is the **job's** database id; a task id answers 404. Omitting `offset` returns the tail, which is usually
  what you want for a failing job. `max_bytes` caps at 262144.

The same server also carries GitHub-flavored tools. When matching a capability by tool name, prefer the `Forgejo-`
prefix — a bare name match can land on the GitHub flavor instead.
