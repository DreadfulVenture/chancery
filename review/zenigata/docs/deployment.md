# Deploying Zenigata

Zenigata runs as one process with a configuration it reads entirely from the environment. This document lists every
variable, the NixOS module options that set them, the packaged assets, the metrics and journal formats, and the
contracts the deployment must honor: the memory URL composition, the model routing, and the adapter's expected-head
duty.

## Endpoints the process serves

| Path         | Method | Auth                   | What it does                                                          |
| ------------ | ------ | ---------------------- | --------------------------------------------------------------------- |
| `/`          | GET    | none                   | The status surface as one human page (see "The status surface").      |
| `/status`    | GET    | none                   | The status surface as JSON; the pinned machine contract.              |
| `/v1/events` | POST   | `ZENIGATA_EVENT_TOKEN` | Intake for adapter events; 202 accepted, processed in the background. |
| `/metrics`   | GET    | none                   | Prometheus text exposition.                                           |
| `/healthz`   | GET    | none                   | 200 `ok`.                                                             |

This table is the endpoints' canonical contract: what is open and what each endpoint carries. The only write endpoint is
the token-bearing intake; the read-only probes and the status surface sit behind no authentication, and none of them
carries a secret — /metrics exposes durations and counters, and the status surface redacts at every projection (below).
Any other path answers 404; `/ui`, the status page's former address, retired when the human page moved to `/`.

The server binds `127.0.0.1` only; anything reaching it from elsewhere needs a reverse proxy in front.

## The status surface

`GET /status` renders one JSON object, and `GET /` renders the same object as the human page, so the answer to "is the
bot functioning and what has it done" needs no journal walk or process probe. The JSON is the machine contract: its
shape is pinned, and anything that scrapes it can rely on it byte for byte. The human page renders the same projection
for reading, in the order an operator reads at 2am: the health line (uptime, the bound port, and the adapter's
reachability), the sessions running or parked right now, the recent runs with their verdicts and wall times, the review
starts a restart dropped, the bot's own narration as a log tail, and the configuration echo. It is one static page — one
embedded CSS block, no scripts, no external assets.

The human page has seven inputs the JSON does not carry, counted the same way in the renderer's own header: (1) each
page view probes the adapter (a plain, tokenless GET of the configured base URL, bounded to a wait of one and a half
seconds; any HTTP response, even an error status, reads reachable), and the health line renders that answer; (2) the
live sessions' rows read with each run's started stamp, from which the running duration renders; (3) the runs table
reads each settled run's wall time from the row's own start and finish stamps in the projection; (4) the failed runs'
failed drafts ride that same projection read; (5) the page renders every `repo#pr` cell as a link into the forge,
composed from `ZENIGATA_FORGE_URL` above — the dropped starts' re-request affordance (and the live sessions', same
cells) is that same link, pointing at the forge's own PR page; (6) the narration tail (PRJ-461): the bot's own lines,
captured at emission through the logger's one write path — the same lines journald collects on stdout/stderr — held in a
bounded in-memory ring (500 lines, 64 KiB, oldest dropped) and rendered oldest first under a note saying the store is
memory since boot, written nowhere, and emptied by a restart. Redaction holds at capture: the credentialed-URL machinery
runs on a line before the ring stores it, so the page never carries a secret the journal wouldn't. The ring is the bot's
voice only — the reviewer session's turns ride the session driver and are never captured. (7) the failed run's
transcript view: a failed run whose journal record carried a retained session (PRJ-382's window) reads that session's
turns live through the session driver — the same surface the sweep disposes with — and renders them in the failure cell,
redacted and byte-capped at composition, each read bounded like the adapter probe. The composed view caches per session
until the sweep disposes it — a failed run's session is frozen between settle and sweep, so a page view re-reads only
what changed. The panel's reach is a deliberate choice: the human page is the operator's post-mortem surface, open like
`/metrics` and `/healthz`, and a failed run's diagnosis wants the session's own words beside the failure — the
diff-bearing prompts and the reviewer's replies for exactly the failed runs whose sessions the retention window still
holds. The posture is worth naming plainly: the page carries no gate, so those prompts — which quote the reviewed
repository's source, private repositories included — and the reviewer's replies are readable by anything that can reach
the host, and the redaction they ride is the credentialed-URL and query-token machinery and nothing else. A deployment
that cannot accept an open surface puts its own gate in front of the reverse proxy; the panel gains no gate of its own.
A session the driver reports not found reads as gone — the retention sweep being the usual hand, though the note does
not attribute it ("the session is gone — the transcript is not available"); a read that failed for any other reason says
that instead. The sweep's window is the transcript's whole retention — nothing new is stored anywhere, and a window-0
run (which tears its session down at settle) offers no transcript at all. The JSON keeps the shape it was pinned with,
so none of the seven is in it.

The surface has no write endpoints of its own and carries no secret — /metrics exposes durations and counters, and the
status surface redacts at every projection (below); the endpoint is open like `/metrics` and `/healthz`.

| Field           | What it holds                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uptime`        | Process start (ISO), uptime in seconds, the port actually bound, and the configured adapter URL with its credentials stripped.                                                                                                |
| `sessions`      | Review events this boot accepted and has not settled: `repo#pr`, event kind, requester, comment, the stage the pipeline last reported (`queued` while waiting for a review slot), and the accepted and last-activity moments. |
| `droppedStarts` | Accepted-start records a bot restart dropped: the boot walk's journaled starts with no terminal review behind them, minus anything this boot accepted; a redelivery re-runs the event free.                                   |
| `runs`          | The 10 most recent review runs, newest first, one SQL read over the status db: when the run started, `repo#pr`, outcome, verdict, per-stage durations, and the redacted failure on a failed run.                              |
| `config`        | The redacted echo: configured listen port, allowlist sizes, retry policy, timeout values, and the agent name.                                                                                                                 |

A session the surface shows as `queued` for a long time sits behind a full review limiter; one that stays in a stage for
a long time is the run an operator can correlate against journalctl for that moment. The narration tail on the human
page is the same correlation without leaving the browser: it reads what the bot itself said this boot, bounded and
memory-only, with journald still the durable record.

### Where the status surface reads

The surface reads a sqlite projection, not the journal: one `status.db` file per state dir, one `runs` table keyed on
the event's identity, so a replayed event cannot double-count. The pipeline writes through at the journal's lifecycle
points — every site that appends an accepted-start or run record also applies the projection row — and a failed write
logs and continues, on the journal's own append-and-log contract. The three-part read contract:

- **in-process truth while this boot runs:** the live session list and the intake's own maps;
- **durable truth across restarts:** `status.db`; at boot, when the projection starts empty, one walk of the journal
  backfills it, and after that the `runs` answer is one SQL read over it;
- **audit:** the journal stays the durability record (above) and is not a read API for the surface — no request reads
  `reviews.jsonl`.

The projection's schema evolves by rebuild, never by migration: a table change deletes `status.db` and the boot backfill
regenerates the projection from the journal, so the service ships no migration tooling (no drizzle-kit).

The per-request window read this surface once performed is gone with it: the runs answer is one SQL select, ordered by
the start moment and capped at 10 rows, so a request's cost is fixed by the window and never by the journal's size.

## Environment variables

The process validates its configuration at boot and names the offending variable in the error when one is missing or
malformed.

| Variable                            | Required | Meaning                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZENIGATA_LISTEN_PORT`              | no       | Intake port; default `8471`. `0` lets the OS pick.                                                                                                                                                                                                                                                                                                                                                      |
| `ZENIGATA_STATE_DIR`                | yes      | Directory holding `reviews.jsonl`, the status db (`status.db`), and the per-PR review worktrees (kept past each run and swept by the retention window).                                                                                                                                                                                                                                                 |
| `ZENIGATA_ALLOWED_LOGINS`           | yes      | Comma-separated logins whose review requests are honored; a requester outside the list is skipped.                                                                                                                                                                                                                                                                                                      |
| `ZENIGATA_ALLOWED_REPOS`            | no       | Comma-separated repositories to review. Unset or empty means every repository the adapter serves.                                                                                                                                                                                                                                                                                                       |
| `ZENIGATA_PERSONA_FILE`             | no       | Path to a persona file overriding the packaged default.                                                                                                                                                                                                                                                                                                                                                 |
| `ZENIGATA_ADAPTER_URL`              | yes      | Base URL of the forge adapter service (see `docs/forge-adapter.md`).                                                                                                                                                                                                                                                                                                                                    |
| `ZENIGATA_FORGE_URL`                | yes      | Base URL of the forge the adapter serves (e.g. `https://forge.example.com`): the status page renders every PR cell as a link into the forge. Not a secret — the config echo shows it plainly.                                                                                                                                                                                                           |
| `ZENIGATA_ADAPTER_TOKEN`            | yes      | Bearer token the bot sends on every adapter call.                                                                                                                                                                                                                                                                                                                                                       |
| `ZENIGATA_EVENT_TOKEN`              | yes      | Bearer token the intake demands on inbound events.                                                                                                                                                                                                                                                                                                                                                      |
| `ZENIGATA_OPENCODE_URL`             | yes      | Base URL of the opencode background service the session driver talks to.                                                                                                                                                                                                                                                                                                                                |
| `ZENIGATA_OPENCODE_KEY`             | no       | The opencode service's password, when it has one. The service authenticates mutations with HTTP Basic auth (username `opencode`) and leaves reads open; no header is sent when unset. The deployment sources the password from the service's state file (`~/.local/state/opencode/service.json`, `password` key on the service host) and puts it in the secrets file.                                   |
| `ZENIGATA_MEMORY_URL`               | yes      | The full MCP endpoint URL of the memory daemon, query params included (below).                                                                                                                                                                                                                                                                                                                          |
| `ZENIGATA_REVIEW_TIMEOUT_SECONDS`   | no       | Whole-run deadline; default `1800`. A run that exceeds it reaches no verdict and posts nothing: the journal record is the failure surface, and only a completed review reaches the PR. A review the forge created from an abandoned in-flight post can still land afterwards; the run accepts that, and the adapter SHOULD dedupe posts on `(repo, pr, expectedHeadSha)` (see `docs/forge-adapter.md`). |
| `ZENIGATA_TURN_POLL_SECONDS`        | no       | Seconds between the session driver's turn-state polls; default `3`. Each poll is one short request; a long turn backs off mildly.                                                                                                                                                                                                                                                                       |
| `ZENIGATA_TURN_BUDGET_SECONDS`      | no       | Seconds one prompt's turn may run before the driver calls it stuck: it interrupts the turn and the prompt fails; default `900`. The whole-run deadline backstops it.                                                                                                                                                                                                                                    |
| `ZENIGATA_RETRY_POLICY`             | no       | The review-event retry posture; default `never`. `never` refuses to re-process an event the journal already ran, so an automatic re-fire path exists nowhere in the default configuration. `once` allows one automatic re-run of a failed event on redelivery; only a failure triggers it. An unlisted value refuses to boot.                                                                           |
| `ZENIGATA_AGENT`                    | no       | Agent name the session driver selects; default `zenigata-reviewer`.                                                                                                                                                                                                                                                                                                                                     |
| `ZENIGATA_WORKTREES_DIR`            | no       | Where the bot clones and reviews; default `<state dir>/worktrees`.                                                                                                                                                                                                                                                                                                                                      |
| `ZENIGATA_RETENTION_WINDOW_SECONDS` | no       | Seconds a finished run's work — its opencode session and the per-PR review worktree — stays on disk before the retention sweep disposes and removes it; default `86400` (24h). The settled run's journal record names the retained work and stamps the settle moment, so the hourly sweep covers pre-restart runs too. `0` disables retention: the run tears its work down the moment it settles.       |

## The memory URL

`ZENIGATA_MEMORY_URL` is the full MCP endpoint URL, query params included, composed by the deployment. It carries the
shape `http://<host>:<port>/mcp?app=zenigata&initiator=agent`. The `initiator=agent` param is the lineage gate's
deployment declaration: it tells the memory daemon that writes from this connection are agent-attributed observations.
Dropping it changes what the daemon refuses, so a deployment that strips the params breaks the memory gateway's contract
with the daemon. The gateway itself never modifies the URL; it connects to it as given.

### Where the daemon must run

The memory gateway stamps each write with a project by handing the daemon a filesystem path — a git checkout of the
repository (the per-repo checkouts live under `<stateDir>/canonical-clones/`) — and the daemon resolves the project from
that path on the host it runs on. The path only resolves if the daemon can see it: deploy the daemon on the same host as
zenigata, or on a host sharing the filesystem that holds the bot's state directory. On a split deployment where the
daemon cannot see the bot's paths, a write files with no project and recall cannot scope it; nothing fails loudly. A
daemon that maintains its own checkouts of the served repositories removes this constraint; until that exists,
co-location or a shared filesystem is part of this URL's contract.

## The NixOS module

`nixosModules.zenigata` (imported from `flake.nix`) exposes `services.zenigata`. Every option maps onto the environment
above:

| Option                 | Type          | Default                        | Sets                                                                                                                                                                  |
| ---------------------- | ------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enable`               | bool          | `false`                        | —                                                                                                                                                                     |
| `listenPort`           | port          | `8471`                         | `ZENIGATA_LISTEN_PORT`                                                                                                                                                |
| `stateDir`             | str           | `/var/lib/zenigata`            | `ZENIGATA_STATE_DIR`; must be exactly `/var/lib/<name>` because systemd's `StateDirectory` takes only the path's last component, which the unit declares              |
| `secretsFile`          | path          | —                              | The unit's `EnvironmentFile`, carrying `ZENIGATA_EVENT_TOKEN`, `ZENIGATA_ADAPTER_TOKEN`, and (when the opencode service has a password) `ZENIGATA_OPENCODE_KEY`       |
| `allowedLogins`        | listOf str    | —                              | `ZENIGATA_ALLOWED_LOGINS` (joined with commas)                                                                                                                        |
| `allowedRepos`         | listOf str    | `[]`                           | `ZENIGATA_ALLOWED_REPOS`; an empty list leaves the variable unset, which means every repository                                                                       |
| `personaFile`          | nullOr path   | `null`                         | `ZENIGATA_PERSONA_FILE`, set only when non-null                                                                                                                       |
| `adapterUrl`           | str           | —                              | `ZENIGATA_ADAPTER_URL`                                                                                                                                                |
| `forgeUrl`             | str           | —                              | `ZENIGATA_FORGE_URL` — the forge the status page's PR links point into; not a secret, the config echo shows it plainly                                                |
| `opencodeUrl`          | str           | —                              | `ZENIGATA_OPENCODE_URL`                                                                                                                                               |
| `memoryUrl`            | str           | —                              | `ZENIGATA_MEMORY_URL`, full endpoint URL with the `app` and `initiator` params; the description of the option spells out that `initiator=agent` must never be dropped |
| `reviewTimeoutSeconds` | ints.positive | `1800`                         | `ZENIGATA_REVIEW_TIMEOUT_SECONDS`                                                                                                                                     |
| `turnPollSeconds`      | ints.positive | `3`                            | `ZENIGATA_TURN_POLL_SECONDS`, set only when the option differs from its default                                                                                       |
| `turnBudgetSeconds`    | ints.positive | `900`                          | `ZENIGATA_TURN_BUDGET_SECONDS`, set only when the option differs from its default                                                                                     |
| `retryPolicy`          | enum          | `never`                        | `ZENIGATA_RETRY_POLICY`, set only when the option differs from its default; `never` keeps every current deployment's posture                                          |
| `agentName`            | str           | `zenigata-reviewer`            | `ZENIGATA_AGENT`                                                                                                                                                      |
| `agentFile`            | nullOr path   | `null`                         | Publishes the agent definition under the module's conf dir (below)                                                                                                    |
| `package`              | package       | the flake's `zenigata` package | The unit's `ExecStart`                                                                                                                                                |

The unit runs as a `DynamicUser` with a `StateDirectory`, takes the secrets from the `EnvironmentFile`, sets the
non-secret variables from the options, and hardens with `NoNewPrivileges`, `ProtectSystem=strict`, and `ReadWritePaths`
on the state directory. `git` is on the unit's PATH because the pipeline clones and fetches.

### The persona override

The package ships its persona at `<package>/persona.md`, and the process resolves that file relative to the built
entrypoint when `ZENIGATA_PERSONA_FILE` is unset. Setting the module's `personaFile` options (or the variable directly)
replaces the packaged persona for every prompt the bot sends. The override beats the packaged default; the packaged
default is what ships when nobody overrides.

### The agent definition and `agentFile`

The package ships the review agent's definition at `<package>/share/zenigata/agent/reviewer.md`. When the module's
`agentFile` is set, the module publishes a copy of that definition at `/etc/zenigata/agent/<agentName>.md`; a change to
the definition lands at the next system rebuild. The agent runtime derives an agent's id from the file name, and the
session driver selects the agent by id — publishing under `<agentName>.md` is what makes `ZENIGATA_AGENT` resolve.
Registering the conf dir with the opencode service is the deployment's business: the opencode service config decides
which directories it scans, and the module stays out of that wiring. The deployment must also scope the review session's
tools at the opencode runtime's agent grants: the agent definition's "no connection to the forge, the checkout, or the
network" line is prompt-level instruction, not policy, and the runtime's tool grants are what actually enforce it.

## Metrics

`/metrics` renders Prometheus text. Four families, with these labels:

| Series                               | Labels           | Label values                                            |
| ------------------------------------ | ---------------- | ------------------------------------------------------- |
| `zenigata_reviews_total`             | `repo`, `status` | `status` is `posted`, `aborted`, `failed`, or `skipped` |
| `zenigata_replies_total`             | `repo`           | —                                                       |
| `zenigata_memory_observations_total` | `source`         | `source` is `fact`, `insight`, `decision`, or `task`    |
| `zenigata_review_phase_seconds`      | `phase`          | `intake`, `git`, `blind`, `context`, `humanize`, `post` |

`zenigata_review_phase_seconds` is a histogram with buckets 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800 (seconds).

## The journal

The state dir holds `reviews.jsonl`, one JSON record per line. A review record carries: `ts`, `type` (`"review"`),
`reviewId`, `repo`, `pr`, `headSha` (absent whenever the run settled before the pull request was fetched: a fork skip, a
repository skip, or a failed fetch all leave it absent), `requester`, `phases` (list of `{phase, durationMs}`),
`verdict` (absent without one), `inlineComments`, `humanizer` (`{assessment, changed}`), `outcome` (`posted`, `aborted`,
`failed`, or `skipped`), `failure` (`{stage, message}`, absent unless failed), and, on a posted run, `body`, `comments`,
and `posted` (`{reviewCommentId, commentRefs}` — the forge's ids, exactly as returned). A posted run whose review came
from the reconciliation — the forge already had the review from an in-flight post the client abandoned — also carries
`reconciled: true`. A reply record carries: `ts`, `type` (`"reply"`), `repo`, `pr`, `author`, `inReplyTo`, `outcome`
(`posted`, `failed`, or `skipped`), `learning` (the observation source, when the reply stored one) and, on a posted
reply, `postedCommentId` (the posted answer's forge id) and `body` (the answer exactly as posted). The process rebuilds
its reply index from this file at boot: posted reviews, and posted replies through their `postedCommentId`, so a reply
to the bot's own answer still resolves after a restart; a torn trailing line from an unclean shutdown is skipped. A
reply record with `outcome` `skipped` marks a reply that never ran — a repository outside `allowedRepos`, or a reply
that arrived past the reply queue's bound — with no session and no post behind it. The status db (see "The status
surface") holds this history as rows: the same records write projection rows at these lifecycle points, and one
boot-time walk syncs a projection that starts empty.

## Model routing

The review session runs the `zenigata-reviewer` agent, and that agent rides the deployment's review route. The route
carries the LLM gateway's virtual-key attribution, so every token the reviewer spends lands on the bot's key. The
subagent passes (blind, humanize) must not run on the flash tier; the route configuration enforces it, and the agent
definition states the requirement so a session observed on the wrong route is visibly off-contract. A deployment that
routes the agent outside the review route breaks attribution and the tier contract at once.

## What the deployment grants

- **Repositories.** With `allowedRepos` empty, the bot reviews whatever the adapter serves. Listing repositories
  restricts the bot to them; a request outside the list is skipped with no session and no post. The same guard applies
  to replies: a reply on a repository outside the list skips with a `skipped` journal record and no session or post.
- **Forks.** The bot skips a pull request whose head lives in a fork. The adapter reports that in `isFork`; the
  deployment does not need to do anything.
- **Requesters.** Only logins in `allowedLogins` may trigger a review.

The reply grant is deliberately asymmetric. A threaded answer goes to any commenter the adapter relays — the bot answers
the question in its own thread regardless of who asked, bounded by the reply queue's waiter cap and its dedupe on
replayed events — but a memory-learning write gates on `allowedLogins`: only an allowed login teaches the bot. The fixed
no-record reply (an `inReplyTo` the index has no record of) posts into the thread the event names, so an unknown
commenter still gets an answer; it just stores nothing.

## The adapter's expected-head duty

The adapter MUST refuse `POST /review` when the pull request's head no longer matches the payload's `expectedHeadSha`.
The bot re-checks the head before posting, and on an adapter refusal it re-fetches the head: when the head actually
moved it treats the refusal as the abort it already handles, and when it did not the run reconciles: a review that
landed despite the refusal is journaled as posted, and otherwise the failure comment posts. The adapter's check is the
one closest to the forge and it is not optional. The full contract is in `docs/forge-adapter.md`.
