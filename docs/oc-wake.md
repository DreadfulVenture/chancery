# oc-wake — agents can wake themselves when a command exits (PRJ-383)

`oc-wake` is a CLI bin that delivers one wake prompt to an opencode session when a watched process exits (PRJ-383 review
163 reversed the trigger: no timers — the wake follows completion, not a delay; review 179 shaped the watchdog; review
189 moved the packaging). It ships as its own package, not the memory plugin's: `wake/oc-wake/package.nix` wraps the bin
with the package's own nodejs, so `oc-wake` on PATH never depends on the user's node — the home-manager module puts the
package on PATH under `services.memory-store.*opencode.enable`. The bin creates its state dir lazily, so the package
carries no state paths. The intended use is composition with a background job:

```
long-check & oc-wake --on-exit $! --message "done, look"
```

or with the pid of a command the agent already started in another shell. The bin arms a detached watcher and returns
immediately: the agent's shell never blocks, which is what the old `&&` composition could not do. The wake is a
scheduled prompt, not a new execution path — no review pipeline, no permission policy change. The delivered message is
an ordinary turn in the addressed session, prefixed with a fixed label so the turn names its own origin:

```
Scheduled wake (oc-wake): done, look
```

## Usage

```
oc-wake [session-id] --on-exit <pid> --message <text|->
```

- The target session defaults to `OPENCODE_SESSION_ID`, which every session tool shell carries — an agent calling the
  bin from its own shell wakes itself. A positional session id (or `--session`) targets another session instead.
- `--on-exit` takes the pid to watch. A pid that does not exist on this machine is a usage error at arm time, as is a
  malformed or non-http(s) `--url`. The timer forms are gone: `--after` errors as usage and points at `--on-exit`.
- `--message -` reads the message from stdin, so a pipe can carry it; a NUL byte in the message is a usage error (an
  environment value cannot carry one either).
- The default output is one JSON record with the watcher's pid and the target; the watcher's pid is also in there
  because killing it cancels the wake. `--quiet` prints only that pid. Cancel captures the pid at arm time —
  `watcher=$(oc-wake ... --quiet)` then `kill $watcher` — because a later `kill $(oc-wake ...)` would arm a second wake
  and cancel that one instead, leaving the first running.
- The host password is read from `OC_WAKE_PASSWORD` (or the registration file); it is never a command-line argument, so
  it stays out of `ps`. A deployment that resolves to no credential — the variable unset or empty and no usable
  registration password — is an arm-time error: the command exits 1 with the sources named, instead of arming a watcher
  whose post fails only where the trace file observes it.
- `--help` carries the full argument list, including the registration-file and URL overrides the tests and non-standard
  deployments use.

## Watchdog semantics

Identity is pid + starttime: on Linux that pair is unique against pid recycling, and cmdline is no part of identity. The
watcher captures the `/proc/<pid>/stat` starttime at arm time (an entry that exists and records one), then polls, and on
every tick reads the entry in one order — identity before state: a vanished proc entry is the watched process EXITED and
the wake fires; an entry that exists but carries a different starttime is checked next and is the recycled-slug case —
the only wrong-target branch — dropped by design: what the slot now holds is not the process the agent named, its
eventual exit is nobody's scheduled wake, and re-arming onto the stranger would invent one the caller never scheduled.
There is no clean way to tell the slot was ever ours once the starttime is not, so the watcher stops, posts nothing, and
writes the record; the trace is the receipt. Only when the starttime matches does the STATE field decide: a zombie
(`'Z'`, the unreaped orphan of a backgrounded command) fires, and `'R'`/`'S'`/`'D'` and friends keep the ticker running.

Being a live process, the watcher is the trigger — the wake fires only while this machine and the watcher live:

- Nothing persists before the command exits. If the machine reboots, the watcher is killed or lost, the wake simply
  never enqueues, silently. Only after the enqueue does the host own the wake (below).
- A post that fails is not retried — schedule creation is not idempotent, and a retried post could double-schedule. A
  failed wake is absent; the trace below says so. The one retryable mistake is re-running the bin itself, which
  schedules a second wake, as running any command twice would.

## Timing

Read the whole timing story here, once elsewhere: poll ticks run a few seconds apart in production (an `OC_WAKE_TICK_MS`
override exists for tests), so exit detection adds up to one tick after the watched process exits — zombie or vanish.
The post goes out at detection; the host admits and fires the one-shot within about a second more (its doorbell wakes
the tick loop at create). End to end, a wake follows the command's exit within a handful of seconds. Everything before
detection is watchdog work (above), everything after the post is host work (below).

## Traces (the chancery state location)

The plugin keeps its small state under `$XDG_STATE_HOME/chancery` (default `~/.local/state/chancery`):

- `oc-wake.jsonl` — one fire-time outcome record per watcher decision, JSON per line:
  `{"at": "<ISO time>", "watcher": <pid>, "pid": <watched pid>, "sessionID": "<target>", "status": "<posted|failed|recycled-slug>", "scheduleId": "<sch_... on a post>", "why": "<the decision's reason>"}`.
  A lost wake leaves a line here.
- `oc-wake.log` — the watcher's stderr, routed to a file so it survives (the stdio is otherwise dropped). Only anomalous
  paths write: a recycled slug, a post failure. The happy path is silent. `OC_WAKE_STATE_FILE` and `OC_WAKE_LOG_FILE`
  override the paths; the tests use them.

## Where the scheduler lives

The enqueue rides the opencode host's own schedule mechanism; the chancery plugin runs none of it. The watcher posts
`POST /api/experimental/schedule` with `when: { in: "1 second" }` — a one-shot "wake now" row the host admits and fires
right away. After the enqueue, the host's Schedule service owns the wake: rows persist in the host's SQLite, so a
restart after enqueue delivers a due wake late, marked late; one message id per schedule run for delivery
reconciliation; a leader lease among processes sharing the database keeps two servers from firing the same schedule. A
retried enqueue is a second wake — running the command twice schedules two wakes.

## What the deployment needs

The host refuses schedule creation until `experimental.schedules` is enabled in the config where the target session
lives (or `OPENCODE_FLAGS=schedules` is set on the service's environment, which needs a service restart to take effect).
Until one of those lands, the wake is silently absent for on-exit use — the CLI validates discovery at arm time, but the
host's refusal arrives at the watcher's post, where only the trace file observes it. Check the flag before arming a wake
you care about:

```
URL=$(jq -r .url $XDG_STATE_HOME/opencode/service.json)
PW=$(jq -r .password $XDG_STATE_HOME/opencode/service.json)
curl -s -u "opencode:$PW" "$URL/api/experimental/schedule?sessionID=<session-id>"
```

A 403 with the disabled text means the flag is off; a 200 means the path is live. The upstream routes live in the
`server.experimental` group and may change with opencode versions; the bin speaks only the create route.

## Discovery and trust

Service discovery reads the host's registration file at the XDG state root — `$XDG_STATE_HOME/opencode/service.json`
(0600: base URL and local password; by default `~/.local/state/opencode/service.json`) — which is the same file every
opencode client on the machine reads. Local authentication is HTTP Basic with the fixed username `opencode` and the
registration password, or the `OC_WAKE_PASSWORD` environment variable when it is set.

The wake is therefore id-addressable within the local trust domain: anyone who can read that registration file — by
default, only the user who runs the agent — can schedule a prompt into any session that host knows. Attribution rides
the schedule id the host stamps on the admitted message plus the fixed label in the text itself. Beyond that domain
(another machine, another user) the registration file is not readable and discovery fails named at arm time.
