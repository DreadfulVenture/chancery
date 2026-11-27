# Deploying Zenigata

Zenigata runs as one process with a configuration it reads entirely from the environment. This document lists every
variable, the NixOS module options that set them, the packaged assets, the metrics and journal formats, and the
contracts the deployment must honor: the memory URL composition, the model routing, and the adapter's expected-head
duty.

## Endpoints the process serves

| Path                | Method | Auth                   | What it does                                                                       |
| ------------------- | ------ | ---------------------- | ---------------------------------------------------------------------------------- |
| `/status`           | GET    | none                   | The status surface as JSON; the pinned machine contract.                           |
| `/page`             | GET    | none                   | The status UI's data feed: the full page data model as JSON (see "The status UI"). |
| `/log/<session id>` | GET    | none                   | A live session's transcript view as JSON; keyed to the sessions this boot holds.   |
| `/v1/events`        | POST   | `ZENIGATA_EVENT_TOKEN` | Intake for adapter events; 202 accepted, processed in the background.              |
| `/metrics`          | GET    | none                   | Prometheus text exposition.                                                        |
| `/healthz`          | GET    | none                   | 200 `ok`.                                                                          |
| `/`                 | GET    | none                   | A placeholder naming the UI app and the machine surface; no run data.              |

This table is the endpoints' canonical contract: what is open and what each endpoint carries. The only write endpoint is
the token-bearing intake; the read-only probes and the status surface sit behind no authentication, and none of them
carries a secret — /metrics exposes durations and counters, and the status surface redacts at every projection (below).
Any other path answers 404; `/ui`, the status page's former address, stays retired.

The server binds `127.0.0.1` only; anything reaching it from elsewhere needs a reverse proxy in front.

## The status UI

The human status page is its own app, `zenigata-ui` (`nix run .#zenigata-ui`), deployed and served separately from the
bot: it runs its own small server that renders the built page and proxies the bot's read surface — `/page`,
`/log/<session id>`, `/status` — server-side, so the browser stays same-origin and the intake keeps its loopback bind.
The bot's HTTP surface above is the contract the UI consumes; the bot renders nothing.

`GET /status` renders one JSON object whose shape is pinned: anything that scrapes it can rely on it byte for byte.
`GET /page` renders the full page data model for the UI: the same projection beside the page-only inputs — the live
rows' started stamps and reviewer-session ids, the runs' wall times, failed drafts, and transcript views, the forge URL,
the narration tail, and the adapter's reachability. The pinned `/status` shape carries none of them.

The UI renders the whole page from that feed, in the order an operator reads at 2am: the health line (uptime, the bound
port, and the adapter's reachability), the sessions running or parked right now, the recent runs with their verdicts and
wall times, the review starts a restart dropped, the bot's own narration as a log tail, and the configuration echo. The
server root names the app and the machine surface instead of rendering data.

While the page is open it polls `GET /page` every 30 seconds and each run that finished since the last check raises one
browser notification: `repo#pr` as the title, the posted run's verdict or the failed run's short reason as the body, and
the run's identity (repo, pull request, start stamp, and the outcome the row carries) as the id, so a repeat poll never
doubles — and a retry that settles the row with a different outcome carries a new identity and notifies: the failure's
follow-up speaks when the retry posts. The id is best-effort: WebKit parses it but does not coalesce by it (two WebKit
bug reports track the no-op), so the dedupe that holds is the seen-state, which open tabs of the same origin share
through localStorage on every poll. Skipped and aborted runs are not finishes — they posted nothing and did not fail —
and notify nobody. Permission is requested through the page's own quiet control in the footer, because browsers require
a user gesture for the prompt: default permission shows a small "enable notifications" button, granted shows a muted
"notifications on", and a declined grant takes the control off the page — the page keeps working, silently, and the
seen-state still advances, so a later grant starts with the next finish rather than replaying old ones. A cold start —
the browser holding no seen-state at all — has no last check to diff against, and the first poll speaks the window it
opens to anyway, at most the ten rows the runs window carries: an open or refresh of a granted tab says what finished
since the last seen state (the operator's ruling, 2026-11-25), so a browser whose localStorage does not persist —
private mode, cleared storage — is not silent forever while the control reads "notifications on". There is no branch to
flip and no latch to arm: a boot window with no finishes in it has nothing to say, and the first finish observed
afterwards speaks on its own poll. Consumption follows delivery: a successfully constructed notification marks the
finish seen, and a construction the browser refuses leaves the finish unseen for the next poll to retry — one try per
finish per poll, quiet and cheap — so a broken notification path eats nothing and still lands its finishes when the
browser recovers; permission that is not granted is the different, deliberate silence, because with no delivery path a
retry could use the window is consumed unread. The seen-state lives in the browser's localStorage under one key, pruned
to the current runs window, with a boot-scoped in-memory twin beside it — a storage that refuses writes still holds each
delivered finish to one notification per tab life, and the twin's delivered records are re-persisted on a later poll
once the storage accepts writes again. And on a non-secure context — plain HTTP from a non-localhost host, the shape a
reverse proxy in front of the loopback bind produces — Notification is undefined: the footer shows no control and no
hint, and the page works exactly as before. Delivery is tab-open only by ruling: the browser's own Notification API, no
service worker, no Web Push — closing the tab stops the notifications, which is the accepted shape, not a defect.

The live rows' session logs refresh in place (PRJ-547's log UX): a running row's expanded log block renders full-width
beneath its own row — dense preformatted text never wraps inside a column again — and while a block stands open the
page's poll also fetches that session's transcript view from `GET /log/<session id>` and re-renders the block's body in
place, on the same 30-second cadence. The block's pin control (a checkbox, rendered checked) chooses the scroll mode:
pinned, each swap rides the tail — the newest turn is the read; unpinned, the reading line carries over so content
appending below does not move it, and re-checking the pin jumps to the tail at once. Settled and swept sessions answer
not found, and an open block keeps the state it rendered; a per-block epoch drops a stale overlapping answer, so two
fetches can never land out of order. A failed run's transcript is frozen between settle and sweep — its block carries
neither the refresh key nor the pin control, because its text never changes.

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
| `ZENIGATA_HUMANS`                   | no       | Comma-separated forge accounts whose thread prose is a human's words to the bot's sessions (see the identity configuration, below). Unset or empty means no account is classified human. An entry that is not an account name refuses to boot.                                                                                                                                                          |
| `ZENIGATA_PERSONA_FILE`             | no       | Path to a persona file overriding the packaged default.                                                                                                                                                                                                                                                                                                                                                 |
| `ZENIGATA_ADAPTER_URL`              | yes      | Base URL of the forge adapter service (see `docs/forge-adapter.md`).                                                                                                                                                                                                                                                                                                                                    |
| `ZENIGATA_FORGE_URL`                | yes      | Base URL of the forge the adapter serves (e.g. `https://forge.example.com`): the status page renders every PR cell as a link into the forge. Not a secret — the config echo shows it plainly.                                                                                                                                                                                                           |
| `ZENIGATA_ADAPTER_TOKEN`            | yes      | Bearer token the bot sends on every adapter call.                                                                                                                                                                                                                                                                                                                                                       |
| `ZENIGATA_EVENT_TOKEN`              | yes      | Bearer token the intake demands on inbound events.                                                                                                                                                                                                                                                                                                                                                      |
| `ZENIGATA_OPENCODE_URL`             | no       | Base URL of the opencode background service the session driver talks to. The packaged stack composes it from the launcher's own serve port; a deployment that runs the bot against an external serve sets it. Unset means the packaged stack's serve.                                                                                                                                                   |
| `ZENIGATA_OPENCODE_KEY`             | no       | The opencode service's password. The packaged stack shares one: the launcher hands it to the serve (as its password) and to the bot (as the Basic-auth key, username `opencode`), and mints one when unset, so the packaged stack carries no state-file password dance. A deployment that runs the bot against an external serve sources that serve's password into the secrets file.                   |
| `ZENIGATA_MEMORY_URL`               | yes      | The full MCP endpoint URL of the memory daemon, query params included (below).                                                                                                                                                                                                                                                                                                                          |
| `ZENIGATA_REVIEW_TIMEOUT_SECONDS`   | no       | Whole-run deadline; default `1800`. A run that exceeds it reaches no verdict and posts nothing: the journal record is the failure surface, and only a completed review reaches the PR. A review the forge created from an abandoned in-flight post can still land afterwards; the run accepts that, and the adapter SHOULD dedupe posts on `(repo, pr, expectedHeadSha)` (see `docs/forge-adapter.md`). |
| `ZENIGATA_TURN_POLL_SECONDS`        | no       | Seconds between the session driver's turn-state polls; default `3`. Each poll is one short request; a long turn backs off mildly.                                                                                                                                                                                                                                                                       |
| `ZENIGATA_TURN_BUDGET_SECONDS`      | no       | Seconds one prompt's turn may run before the driver calls it stuck: it interrupts the turn and the prompt fails; default `900`. The whole-run deadline backstops it.                                                                                                                                                                                                                                    |
| `ZENIGATA_RETRY_POLICY`             | no       | The review-event retry posture; default `never`. `never` refuses to re-process an event the journal already ran, so a replayed (redelivered) event costs nothing — reviews come only from fresh forge deliveries (a re-request), never from a replay. `once` allows one automatic re-run of a failed event on redelivery; only a failure triggers it. An unlisted value refuses to boot.                |
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

| Option                 | Type               | Default             | Sets                                                                                                                                                                  |
| ---------------------- | ------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enable`               | bool               | `false`             | —                                                                                                                                                                     |
| `listenPort`           | port               | `8471`              | `ZENIGATA_LISTEN_PORT`                                                                                                                                                |
| `opencodePort`         | port               | `8473`              | The packaged serve's loopback port; the launcher composes the bot's serve URL from it                                                                                 |
| `overrideConfig`       | nullOr path        | `null`              | The deployment's own config file; the module composes the serve's config directory with it beside the package floor (below)                                           |
| `stateDir`             | str                | `/var/lib/zenigata` | `ZENIGATA_STATE_DIR`; must be exactly `/var/lib/<name>` because systemd's `StateDirectory` takes only the path's last component, which the unit declares              |
| `secretsFile`          | path               | —                   | The unit's `EnvironmentFile`, carrying `ZENIGATA_EVENT_TOKEN`, `ZENIGATA_ADAPTER_TOKEN`, and every credential the stack reads from the environment                    |
| `allowedLogins`        | listOf str         | —                   | `ZENIGATA_ALLOWED_LOGINS` (joined with commas)                                                                                                                        |
| `allowedRepos`         | listOf str         | `[]`                | `ZENIGATA_ALLOWED_REPOS`; an empty list leaves the variable unset, which means every repository                                                                       |
| `humans`               | listOf accountName | `[]`                | `ZENIGATA_HUMANS`; an empty list leaves the variable unset (see the identity configuration, below). Each entry is type-checked against the account-name shape         |
| `personaFile`          | nullOr path        | `null`              | `ZENIGATA_PERSONA_FILE`, set only when non-null                                                                                                                       |
| `adapterUrl`           | str                | —                   | `ZENIGATA_ADAPTER_URL`                                                                                                                                                |
| `forgeUrl`             | str                | —                   | `ZENIGATA_FORGE_URL` — the forge the status page's PR links point into; not a secret, the config echo shows it plainly                                                |
| `memoryUrl`            | str                | —                   | `ZENIGATA_MEMORY_URL`, full endpoint URL with the `app` and `initiator` params; the description of the option spells out that `initiator=agent` must never be dropped |
| `reviewTimeoutSeconds` | ints.positive      | `1800`              | `ZENIGATA_REVIEW_TIMEOUT_SECONDS`                                                                                                                                     |
| `turnPollSeconds`      | ints.positive      | `3`                 | `ZENIGATA_TURN_POLL_SECONDS`, set only when the option differs from its default                                                                                       |
| `turnBudgetSeconds`    | ints.positive      | `900`               | `ZENIGATA_TURN_BUDGET_SECONDS`, set only when the option differs from its default                                                                                     |
| `retryPolicy`          | enum               | `never`             | `ZENIGATA_RETRY_POLICY`, set only when the option differs from its default; `never` keeps every current deployment's posture                                          |
| `agentName`            | str                | `zenigata-reviewer` | `ZENIGATA_AGENT`                                                                                                                                                      |
| `package`              | package            | —                   | The unit's `ExecStart` — set it to the flake's `packages.zenigata-runtime`; the runtime composes flake-pinned inputs a plain nixpkgs callPackage cannot provide       |

The unit runs the runtime package's launcher as its `ExecStart`: the opencode serve starts inside the package's own
config layout and the bot execs beside it, so one unit carries the whole stack, a stop or a crash takes both, and
`Restart=on-failure` loops the pair. The unit runs as a `DynamicUser` with a `StateDirectory`, takes the secrets from
the `EnvironmentFile`, sets the non-secret variables from the options, and hardens with `NoNewPrivileges`,
`ProtectSystem=strict`, and `ReadWritePaths` on the state directory — which also holds the serve's own state, its `HOME`
set to the state directory. `git` rides the package's own PATH wrapper.

### The persona override

The package ships its persona at `<package>/persona.md`, and the process resolves that file relative to the built
entrypoint when `ZENIGATA_PERSONA_FILE` is unset. Setting the module's `personaFile` options (or the variable directly)
replaces the packaged persona for every prompt the bot sends. The override beats the packaged default; the packaged
default is what ships when nobody overrides.

### The agent definition

The runtime package composes the review agent's definition into its own config layout under the id the session driver
selects (`agent/zenigata-reviewer.md`, the file-name-is-the-id rule the agent runtime decodes), so `ZENIGATA_AGENT`'s
default resolves with nothing published. The definition carries its own policy: the `permissions` block in its
frontmatter grants the reviewer's working tools — reading, globbing, grepping, running shell commands, and looking up
reference material on the network, plus the subagent delegation the flow uses. It grants the skill action over the
wildcard, so the session reaches every skill the package ships — `review-pr`, which the driving prompt names, and
`humanizer`, which the session's own flow runs, among them — while every non-skill action stays behind the deny-all
floor an agent ruleset carries. The forge MCP's review-posting tools are the deliberate carve-out that does NOT ship:
the deployment's own override config carries those rows, named for the MCP server that deployment runs
(`<server>_<tool>`, the action format the v2.3.0 source composes for MCP tools). A deployment that pins no rows gets a
reviewer that cannot post — the correct default, since the shipped definition must stay free of any one deployment's
server naming. A file-defined agent's rules land after the runtime's config floor and win, so the definition is the
operative grant map and every deployment carries it without re-allowing anything. The authoring actions (`edit`,
`write`, `patch`) stay denied as tool mounts, and one misuse rides behind them as a denial: a trailing `shell` row
refuses `git push*` commands. That denial matches the command text the shell tool checks as its permission resource —
the raw command string, per command segment (verified against the 2.3.0 source) — so it catches commands spelled
`git push …` and not a push that starts differently; the no-push invariant does not rest on the row alone.

The grants do not make the reviewer harmless. `shell` on `*` subsumes every authoring tool — redirection, `git apply`,
`rm` — so a build writing through the shell is the grant working. The forge surface changed shape with review 665: the
session holds the forge capability the deployment's MCP carries, scoped by the ruleset to the review-posting tools, and
every other MCP server's tools stay behind the deny-all. The integration channel stays denied at the policy level; the
runtime floor no longer refuses `mcp.use` (the deployment's MCP catalog is how the session reaches the forge), and —
since PRJ-535 — no longer carries a blanket `plugin.use` denial either: the earliest-loaded policy wins the serve's
union, so a floor deny would have made every deployment-layer plugin allow ungrantable. Plugins load where the
deployment grants them. The bot's forge adapter keeps its read side — the intake guards and the bookkeeping lookup —
while nothing in the pipeline posts any more.

## The runtime package

`packages.zenigata-runtime` (the flake) is the complete review runtime in one package: the pinned opencode serve binary,
the runtime's neutral serve config at `<package>/share/zenigata/opencode/config.json`, and the bot with its session
driver. The package's version is the serve version, and the compatibility contract is behavior, not version equality:
the flake's `zenigata-runtime-compat` check runs the driver's integration tests against the packaged serve, so an
upgrade that breaks the driver lands red naming the break, and `@opencode/client` upgrades flow freely through Renovate.

The serve tracks nixpkgs-unstable, the branch the deployment's opencode has always come from; the carried version is
whatever the lock has now, and the packaged binary reports it at any time. The driver is background-aware: it waits out
2.3.x's always-background subagent tool through the serve's job endpoint, whose absence fails named as the broken
pairing. The compatibility check is the gate: every lock refresh that moves the branch's opencode runs the
delegated-pass settle test against the new serve on the build.

The config the package ships is the neutral, product-owned floor: it keeps a global deny with the subagent delegation
carve-out after it (a headless serve has nobody to answer a permission ask, so the floor denies instead of asking) and
refuses the integration channel at the policy level — deliberately not `integration.use`, whose deny also covers
providers served from local config and would take out the deployment's own model route — and turns sharing and
self-update off. The `mcp.use` refusal is gone (review 665): the deployment passes the forge MCP into the serve, the
reviewer session posts its own review through it, and the deployment's override config carries the reviewer's forge-tool
rows, named for that server. The `plugin.use` refusal is gone too (PRJ-535): the earliest-loaded policy wins the serve's
union, so a floor deny would have made every deployment-layer plugin allow ungrantable; plugins load where the
deployment grants them, and a deployment that grants no plugin gets none. The reviewer agent's own definition carries
its working grants (reads, searches and globs, shell commands, web lookups, subagent delegation, and its skills): the
file-defined agent's rules land after the floor and win, so the grants travel in the package and no deployment re-allows
anything.

The package composes the serve's whole config layout itself, at `<package>/share/zenigata/opencode-home`: the neutral
floor as `opencode.json` — the layout's only config file — the reviewer agent's definition at
`agent/zenigata-reviewer.md`, and the skills tree — the opencode assets package's per-client composition, built by the
flake's assets packaging from the writs skills tree — linked at the `skills` directory the serve's skill discovery scans
(`<config entry>/skill` and `<config entry>/skills`, the v2.3.0 source's contract). The launcher points
`OPENCODE_CONFIG_DIR` at that layout by default, so the packaged serve loads the package's own composition with nothing
wired: PRJ-539's deployment-side wiring step is gone, and there is nothing left for a deployer to skip.

What remains deployment-owned rides one file, placed the native way. The v2.3.0 serve reads both `opencode.json` and
`opencode.jsonc` from every scanned config directory — `config/discovery.ts`'s `names` list, loaded in that order with
missing files skipped — and merges with the later document winning for settings (`config.ts`'s `latest` is `findLast`),
so a deployment's own `opencode.jsonc` sitting beside the floor's `opencode.json` layers over it through the serve's own
precedence, with no env var carrying a config path. Policy rows are the union with the earliest-loaded document's
authority winning (the PRJ-535 fact), so the floor's policy rows keep their authority. The module's `overrideConfig`
option composes that two-file directory — the package floor's `opencode.json` plus the deployment's `opencode.jsonc`,
with the agent and skills entries beside them — and points the unit's `OPENCODE_CONFIG_DIR` at it; a deployment that
ships no file gets the launcher's package-layout default. The deployment's file carries the model route with the
gateway's virtual-key attribution, the forge MCP server the session posts through with the reviewer's forge-tool rows
named for it, and the plugin grants for the plugins that deployment wires — the credential-bearing surfaces PRJ-501
keeps deployment-injected. The launcher composes the PATH the pair runs under: the runtime's own node and git, appended
after whatever PATH the caller sets (PRJ-539) — the review flow runs the tests and builds the change calls for, and
those are node and git programs a minimal unit PATH leaves dead. The spawn layer itself — which shell the session's
shell tool runs through at all — is the neutral config's `shell` key (`/bin/sh`): the serve inherits the service
account's login shell as `$SHELL`, and a deployment whose service account's shell is nologin dies at spawn, below PATH,
on every shell call; the config names the shell instead, and the deployment's own `shell` key beats it. The reviewer's
skill grant covers everything the layout ships — the prompt names `review-pr`, whose flow carries `humanizer` (which
carries the writing source beside its SKILL.md), and the session reaches the rest as its work demands.

The flake's `.#zenigata` app runs the package's launcher, and that invocation is the whole story between nothing and a
reviewable stack: source the env file (`set -a; . ./zenigata.env; set +a`) and run it. The launcher starts the serve on
`OPENCODE_SERVE_PORT` (default 8473), composes the bot's serve URL, and mints a shared serve password from
`ZENIGATA_OPENCODE_KEY` — unset, it generates one and hands it to both sides — then execs the bot. The acceptance
harness (`test/runtime-compat-run.ts`, the flake's `zenigata-runtime-compat` check) stands the stack up through exactly
that invocation with a fixture env file and the deployment's file placed beside the floor in the config directory, and
runs the review-shaped pass against it: one review event through the bot's intake, the reviewer session loading
`review-pr` from the package's own tree, and the review landing on a local forge fake through the deployment's forge
MCP.

The bin also carries a `--check-config` mode beside the server boot: given a rendered unit environment (JSON), the
unit's environment file, and the identity list that deployment carries (JSON), it composes the environment files the way
a deployed boot composes them and validates the composition through the same boot-time schema. The flake's
`zenigata-rendered-config` check evaluates the module, renders a test deployment, and is that mode's consumer.

## Metrics

`/metrics` renders Prometheus text. Four families, with these labels:

| Series                               | Labels           | Label values                                         |
| ------------------------------------ | ---------------- | ---------------------------------------------------- |
| `zenigata_reviews_total`             | `repo`, `status` | `status` is `posted`, `failed`, or `skipped`         |
| `zenigata_replies_total`             | `repo`           | —                                                    |
| `zenigata_memory_observations_total` | `source`         | `source` is `fact`, `insight`, `decision`, or `task` |
| `zenigata_review_phase_seconds`      | `phase`          | `intake`, `git`, `review`, `bookkeeping`             |

`zenigata_review_phase_seconds` is a histogram with buckets 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800 (seconds).

## The journal

The state dir holds `reviews.jsonl`, one JSON record per line. A review record carries: `ts`, `type` (`"review"`),
`reviewId`, `repo`, `pr`, `headSha` (absent whenever the run settled before the pull request was fetched: a fork skip, a
repository skip, or a failed fetch all leave it absent), `requester`, `phases` (list of `{phase, durationMs}`),
`verdict` (absent without one), `inlineComments`, `outcome` (`posted`, `failed`, or `skipped`), `failure`
(`{stage, message}`, absent unless failed), and, on a posted run whose bookkeeping lookup found the landed review,
`body`, `comments`, and `posted` (`{reviewCommentId, commentRefs}` — the forge's ids, exactly as returned). Since review
665 the session posts the review itself, and the record's landed shape comes from the bookkeeping lookup; a lookup that
finds nothing leaves those fields absent while `outcome` stays `posted`. Older rows carry `humanizer`, `reconciled`,
`failedDrafts`, `droppedComments`, and `verdictReconciled` from the pipeline-assembled era; nothing re-reads a stored
row's field. A reply record carries: `ts`, `type` (`"reply"`), `repo`, `pr`, `author`, `inReplyTo`, `outcome` (`posted`,
`failed`, or `skipped`), `learning` (the observation source, when the reply stored one) and, on a posted reply,
`postedCommentId` (the posted answer's forge id) and `body` (the answer exactly as posted). The process rebuilds its
reply index from this file at boot: posted reviews, and posted replies through their `postedCommentId`, so a reply to
the bot's own answer still resolves after a restart; a torn trailing line from an unclean shutdown is skipped. A reply
record with `outcome` `skipped` marks a reply that never ran — a repository outside `allowedRepos`, or a reply that
arrived past the reply queue's bound — with no session and no post behind it. The status db (see "The status surface")
holds this history as rows: the same records write projection rows at these lifecycle points, and one boot-time walk
syncs a projection that starts empty.

## Model routing

The review session runs the `zenigata-reviewer` agent, and that agent rides the deployment's review route. The route
carries the LLM gateway's virtual-key attribution, so every token the reviewer spends lands on the bot's key. The
subagent passes must not run on the flash tier — the humanize pass is the candidate, since the blind pass reads the
prompt-carried diff in the session itself — and the route configuration enforces it, while the agent definition states
the requirement so a session observed on the wrong route is visibly off-contract. A deployment that routes the agent
outside the review route breaks attribution and the tier contract at once.

## The identity configuration

The deployment configures the humans list (the config layer, #166), and the bot consumes it as instruction (PRJ-514, the
session-origin ADR's review-bot instance):

- **humans** — accounts on the list are operator speech: their prose is the operator's own words, weighted as ground
  truth for veracity and corrections. The list renders one operator-speech sentence into the review session's start
  prompt and the answer session's prompt; prose from any other account is a claim to trace against the code. An empty
  list renders nothing, and the reviewer treats all thread content as claims — the honest default.

The `agents` and `access` lists the earlier design carried are retired (PRJ-518), and each path a stale configuration
names them by fails its own way:

- Setting the module's `agents`/`access` options fails at evaluation with NixOS's own unknown-option error. That is
  deliberate, not a defect: evaluation runs before any deploy, so a stale configuration stops visibly at build time. A
  follow-up review asked for a retirement note there; the operator chose the native error.
- A `ZENIGATA_AGENTS`/`ZENIGATA_ACCESS` variable carrying a value fails at boot naming itself, through the boot-time
  known-set check.
- An empty-valued one counts as unset — the unset-or-empty contract every list variable honors — and fails nothing: an
  empty list names nobody, so there is nothing to refuse.

Every humans entry is validated against the forge's account-name shape at module evaluation and again at boot (naming
the variable and the offending entry). The bot declares its own origin to the store: every session the runtime creates
carries `chancery_origin: { initiator: "program", parent: null }` — the runtime process is not a session, so the record
is the parentless-program declaration — and the memory client registers the conversation as an agent root with no parent
link, which the store's lineage walk resolves unanchored: observation-only writes. The deployed `memoryUrl` still
carries `initiator=agent` (above, and the module asserts it); the create-time declaration now carries the posture with
it.

The store's side of the story needs no mirror in the bot: the daemon gates memory by session lineage, not accounts, and
the bot's sessions are just agent-lineage clients — which the deployed `memoryUrl` already declares with
`initiator=agent` (above, and the module asserts it), so every bot write resolves agent-lineage regardless of what these
lists carry.

## What the deployment grants

- **Repositories.** With `allowedRepos` empty, the bot reviews whatever the adapter serves. Listing repositories
  restricts the bot to them; a request outside the list is skipped with no session and no post. The same guard applies
  to replies: a reply on a repository outside the list skips with a `skipped` journal record and no session or post.
- **Forks.** The bot skips a pull request whose head lives in a fork. The adapter reports that in `isFork`; the
  deployment does not need to do anything.
- **Requesters.** Only logins in `allowedLogins` may trigger a review, and the forge-native review re-request is the
  whole trigger surface: the summon command is gone, so zenigata reviews when a human asks.

The reply grant is deliberately asymmetric. A threaded answer goes to any commenter the adapter relays — the bot answers
the question in its own thread regardless of who asked, bounded by the reply queue's waiter cap and its dedupe on
replayed events — but a memory-learning write gates on `allowedLogins`: only an allowed login teaches the bot. The fixed
no-record reply (an `inReplyTo` the index has no record of) posts into the thread the event names, so an unknown
commenter still gets an answer; it just stores nothing.

## The summon's silence (deliberate)

The removed `@zenigata @review` comment command leaves a surface behind that says nothing back: a human who posts the
old summon now gets the adapter's `202 ignored` — the webhook arrived, the comment became no event, and nothing is
delivered to the bot's intake. That silence is accepted deliberately (PRJ-493 review decision 17954); there is no
dead-command reply surface, and the bot posts no instruction teaching the old command's fate. Reviews still fire on a
forge review re-request — the trigger surface the intake serves — and that is the answer humans eventually read.

## The adapter's expected-head duty

The adapter MUST refuse `POST /review` when the pull request's head no longer matches the payload's `expectedHeadSha`.
Since review 665 the reviewer session posts its own review with the deployment's forge tools, so this duty names what
any post path the bot's identity carries must enforce — it is the one check closest to the forge, and it is not
optional. The pipeline's own post stage is gone: the adapter's `POST /review` stays part of the forge-adapter contract
(read `docs/forge-adapter.md`), and the bookkeeping lookup reads what landed for `(repo, pr, head)`.
