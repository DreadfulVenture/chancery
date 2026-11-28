<div align="center">

<img src="assets/chancery-logo.svg" alt="Chancery" width="140">

# Chancery

</div>

Chancery is a monorepo of agent tooling. Each product gets a short section below. The rest of this document describes
memory-store: its clients, development, configuration, and deployment. The nix modules under `nix/` deploy all of it.

## The products

### memory-store

Agents lose context between sessions. Last week's fix, a schema decision, a tool's quirk: all of it disappears when the
process exits. memory-store keeps it. It captures every conversation turn into a local SQLite database on your machine.
Recall finds prior decisions and fixes by intent, not by date. Consolidation summarizes quiet sessions into durable
knowledge. A write gate lets only sessions a human started write the memories that steer future behavior. The core path
needs no cloud service and no API keys; an optional hub relay syncs several hosts. An OpenCode plugin and a Cursor hook
are its clients, and the sections after this inventory describe them.

### zenigata

The pull-request review bot. An operator tags a pull request for review, the bot runs a reviewer session over it, and
the review lands on the pull request as comments — verdict, summary, and inline notes. Replies get answers in thread.
Its forge adapter (`review/forgejo-adapter`) receives the forge's webhooks; its own docs live under
`review/zenigata/docs/`.

### the mail-watcher

An OpenCode plugin (`watch/mail-watcher`) and the standalone daemon behind it, watching event sources and delivering
what they see as session mail. The forge source watches Forgejo runs and wakes its session when a pull-request review
arrives after the watch registers; the PagerDuty source turns PagerDuty incidents into mail the same way; the Linear
source turns ticket changes on watched Linear projects into mail under the same temporal rule — a ticket's changes wake
only from its registration cursor onward, never the pre-registration backlog. All of the reading and every source token
live in the standalone daemon (`bin/watcher-daemon`, PRJ-540): the plugin in the session carries no credential and
proxies the watch tools to the daemon's local route.

### the director

An OpenCode plugin (`coordinate/director`) that gives director sessions their coordination tools: dispatching and
steering worker sessions over the host's session API, reading their turn reports as they finish, and a shared manifest
store for run state. The package ships the director agent definition, the orchestration skills, and the commands beside
it, and registers the whole surface when it loads.

### oc-wake

A CLI that delivers one wake prompt to an opencode session when a watched process exits — composition for background
jobs: `long-check & oc-wake --on-exit $! --message "done, look"`. The agent's shell never blocks. Its own doc is
`docs/oc-wake.md`.

### the writs

The skills, agents, and commands the suite's agents work from, under `writs/`. They ship per client —
`share/skills.cursor` and `share/skills.opencode` — because review skills compose per client at build time. The two
reminder plugins (`writs/plan-reminder`, `writs/discovery-reminder`) are writs products too: they deliver the plan and
discovery modes' per-turn reminders into OpenCode sessions.

Memory data is runtime state and is never part of this repository. The daemon stores it beneath `MEMORY_DATA_DIR`
(default: `~/.local/services/memory/data`) and queues sync records beneath `MEMORY_QUEUE_DIR`.

## Clients

One daemon serves both clients, and they do the same two jobs on either side: append every conversation turn to the
capture queue, and deliver at the event-shaped moments — the session-start knowledge-base block, and tool moments when a
bound tool fires. Deciding what to send is the daemon's job throughout; a client renders it. Nothing is injected at
message arrival on either client, and content reaches the agent by pull (`memory_recall`) or the moments.

Clients are told where things are rather than guessing: `client.json` (written by the deployment, overridable per key by
the environment) carries the daemon URL, the queue directory, the rendered floor, and the contract. A missing one is an
error at startup, not a fallback — a client quietly talking to the wrong port looks identical to one with nothing to
say.

- `memory/opencode-client/memory.ts` — OpenCode, holding session state in the process.
- `memory/cursor-client/` — Cursor, run as a hook. Cursor starts a fresh process per event, so the session state the
  plugin keeps in memory lives in a per-conversation file under the queue directory. Activation registers the
  conversation events (`beforeSubmitPrompt`, `afterAgentResponse`, `preCompact`); the daemon registers the tool-time
  events (`beforeShellExecution`, `preToolUse`, `postToolUse`) itself, with matchers it rewrites whenever a tool rule is
  enrolled. The session-start block carries the knowledge-base doc inline, but not the facts matched to the opening
  request: those wait in the daemon, and the block tells the agent to fetch them with `knowledge_read` before anything
  else. If the agent's first tool call is anything but one of the memory tools, the hook refuses it once with the same
  instruction. `preToolUse` matches every tool for that reason, and it is also the counterpart to the plugin's
  `tool.execute.before`: it adds the workspace directory and the conversation to the memory tools that take them. A held
  tool moment refuses the call; an informational one rides `postToolUse` beside the result.

OpenCode keeps the full block, doc and facts together, because Cursor's limit is the only reason to split it. Measured
on Cursor 3.29.9, `additional_context` from `beforeSubmitPrompt` is inlined up to 10,000 characters per turn, and the
limit applies to the text of every hook on the event combined. Above it nothing is dropped: Cursor writes the full text
to a file under `~/.cursor/projects/<project>/agent-tools/` and tells the agent to read it. Blocks of 4 and 8 KB arrived
inline; 12, 16, 24 and 32 KB went to the file, intact. The doc is capped at 6,000 characters, so it fits with room for
the framing and other hooks. Five matched facts can each run to 1,200 characters, and the doc plus five of them can
reach about 13,000. That is why the facts are fetched. This is a separate behavior from `sessionStart`, which drops its
payload outright above a small size and is not used. A refusal from `preToolUse` reaches the agent through
`user_message`, which Cursor hands back as the tool's result; `agent_message` is accepted and not delivered.

`memory/store/instructions/memory.md` is the behavioral contract for the agent, and the daemon renders the persona floor
beside it. Both reach Cursor as always-applied rules and OpenCode through `experimental.chat.system.transform`, which
runs before every request, so a re-rendered floor lands without restarting the client.

## Development

```sh
nix develop
make test
```

`make memory-dev` starts a loopback-only hub, LLM stub, and daemon against a temporary directory. `make rehearse` adds
the client leg: real `opencode run` sessions capture into the same scratch stack, and the registry facts are asserted by
read-only SQL before the run directory is kept for inspection. Both relocate HOME/XDG and point every write path into
the run directory; a lost isolation variable aborts before any process spawns (dev-env.sh).

## Configuration

`MEMORY_SPAN_LOG` (`debug`, `info`, `error`) sets one level for the daemon and both clients; the nix module's `logLevel`
option sets it everywhere at once, reaching the clients through `client.json`. At `debug` each side emits point
observations beside its spans — the locations a client resolved, whether standing context reached the model, why a
prompt was or was not nudged. Reach for it before asking an agent what it received: a small model will flatly deny text
that is present in its own prompt.

Daemon lines go to `logFile`: a launchd log under `~/Library/Logs` on darwin, `stateDir/daemon.log` elsewhere. The
OpenCode plugin writes to the process stderr, so `opencode run` shows them inline. The Cursor hook writes to stderr too,
which Cursor owns; run the hook by hand with a recorded payload to read them directly.

The daemon listens on `MEMORY_MCP_PORT` (default `17173`). Set `MEMORY_HUB_URL` only when using the optional relay; with
it unset, nothing queues for push and no sync cycle runs. Consolidation requires `MEMORY_LLM_BASE_URL` and
`MEMORY_LLM_MODEL`, and `MEMORY_LLM_EXTRA_BODY` for routes that take per-request settings (Ollama only accepts reasoning
controls that way).

Tool rules hold calls by default: a bound tool's first execution in each conversation is refused with the rule as its
error. `MEMORY_TOOL_HOLDS=0` (the nix module's `toolHolds = false`) makes every tool rule informational. Cursor's
first-tool refusal for unfetched session-start facts is not a tool rule, and the flag does not turn it off.

Writes are gated on lineage (PRD 20261114-lineage-gated-writes): a conversation may write only if its parent chain
reaches a human-started session. The initiator is declared by the deployment, never by the model — it rides the MCP
connection's URL beside `app` (the plugin writes `initiator` there from `client.json`'s `initiator` key or
`MEMORY_INITIATOR`; a webhook bot declares `agent`), and each registration line and capture carries the same declaration
for the session it names. The daemon resolves the root through the registry's parent links — a link that arrives after
the row was created backfills — and refuses writes from any conversation that does not reach a human: everything that
steers future behavior (rules, persona, corrections, deletions, tool rules) plus a bare write with no conversation at
all. Allowed for such callers: `memory_remember` with an observation label (`fact`, `insight`, `decision`, `task`),
stamped `author_type "agent"` at default weight and project scope — reads stay open, but their provenance pointers
(session ids, `summary_of`) are redacted, so an injected caller learns no parent id to claim. Agent-attributed rows
never feed the knowledge base; a human session adopting a finding (writing its own row in its own voice) is what
promotes it. Attribution is decided by the daemon from the same resolution — a model never supplies
`author_id`/`author_type`, and a driven session's captured user turns are stamped the agent voice they are. A driven
`opencode run` inherits its parent through `MEMORY_PARENT_CONVERSATION_ID`, set by whichever trusted layer launched it.
What the gate does not close: a same-user process forging registrations or calling the daemon directly — that is daemon
authentication's boundary (PRJ-268; an id in our internal tracker, not a public link), not the write gate's.

## Deployment

`homeManagerModules.default` declares the background service and the client wiring, so a consumer imports it and sets
options rather than reimplementing either against this repo's layout:

```nix
services.memory-store = {
  enable = true;
  port = 17174;
  embeddingModel = "BAAI/bge-large-en-v1.5";
  llm = {
    baseUrl = "http://127.0.0.1:11434/v1";
    model = "qwen3.6:35b-a3b";
  };
  cursor.enable = true;
  opencode.enable = true;
};
```

On darwin the daemon runs as a launchd agent; everywhere else it runs as a `systemd --user` unit named after `label`,
wanted by `default.target` rather than `graphical-session.target` because it serves a loopback port and has nothing to
do with a display. Both write to `logFile`, so the one path this README points at holds under either init —
`journalctl --user -u` works as well on the systemd side.

`cursor.enable` registers the MCP server in `~/.cursor/mcp.json`, the capture hooks in `~/.cursor/hooks.json`, and the
contract as an always-applied rule at `~/.cursor/rules/memory.mdc`. Both JSON files are shared with everything else
installed, so they are merged key by key rather than declared whole. The floor sits beside the contract at
`~/.cursor/rules/memory-floor.mdc`, written by the daemon rather than by nix because it is re-rendered on every persona
write.

It also links every directory under `writs/skills/` into `~/.cursor/skills/`, so those skills load in any Cursor chat.
The names are read off the directory at build time, and the links reach into the package rather than at a working tree,
so adding a skill needs a rebuild — and so does editing one. `writs/skills/` ships as one full tree per client
(`share/skills.cursor`, `share/skills.opencode`), because `review-pr` is composed per client at build: its
`@workspaceSetup@` marker gets the host's workspace block spliced over it, so each client loads a complete document;
every other skill is the same bytes in both trees.

**Do not put this in a Cursor plugin.** One directory would be tidier and there is no durable way to deliver one.
`~/.cursor/plugins/local` is refused for a team account whose admin has `allowUserLocalPluginImports` off; the loader
checks it on every load and skips the directory entirely. The only other route is answering a `workspaceOpen` hook with
a path, and a plugin arriving that way survives exactly until the extension host restarts. The restart rebuilds the
plugin registry from its sources and does not re-fire `workspaceOpen`, so the plugin is dropped while its hook entry
stays in `hooks.json` looking healthy. Nothing reports it. The tools going missing is the visible half; the capture
hooks stopping is the half that costs you, because turns go unrecorded with no error anywhere. Measured on Cursor
3.21.18, with the servers already in `mcp.json` surviving the same restart untouched.

Registered this way the server shows up in Cursor's own MCP settings, which a hook-delivered plugin never did, so a
missing server is visible rather than something to infer from logs. For the rule half, ask an agent in a fresh chat to
report its always-applied rules.

`opencode.enable` links `memory/opencode-client/memory.ts` into `~/.config/opencode/plugins/` and the same skill
directories into `~/.config/opencode/skills/`. The plugin is the whole capture install: OpenCode discovers anything in
that directory, and the plugin registers the MCP server and pushes the contract and floor itself. Both link into the
package, so a plugin or skill edit ships with the next rebuild.

For testing work that is not merged yet, point the consuming flake's `memory-store` input at the worktree
(`--override-input memory-store path:...` for one switch, or the input line flipped for the duration); modified tracked
files read dirty, and new files need `git add -N` to enter the flake's fileset. That covers quick tests with a real,
traceable generation; the scratch-home rehearsal covers running uncommitted code without touching the real store.

Beyond the links, the flake ships the client assets as real packages, which is the boundary anything that is not
home-manager builds against. `memory-store-plugin` carries the capture plugin at `share/opencode/plugins/`;
`memory-store-opencode` carries the agents, commands and skills at `share/opencode/{agents,commands}` and
`share/skills.{cursor,opencode}`, plus the plan-permission fragment at `share/opencode/plan-permissions.json` — the
permission rules a deployment folds into its OpenCode configuration under `agents.plan.permissions`. The fragment is the
whole array on purpose: JSON array elements carry no identity, so a partial merge can neither update nor remove a rule,
and a renderer overrides it wholesale. The default keeps the PRD directory writable from plan mode and denies plan mode
from launching the implementer subagent, which runs with its own permissions and could otherwise edit despite the plan
agent's own restrictions.

`mail-watcher` is not linked by the module. Since the split (PRJ-540) it is two halves. The plugin — a directory plugin
at `lib/mail-watcher` — is the credential-free half: it registers the watch tools and proxies them to the daemon's local
route, and OpenCode gives options only to plugins its config names, so the deployment adds that path with the route
address, for example
`{ "package": "<store path>/lib/mail-watcher", "options": { "watcher": { "daemonUrl": "http://127.0.0.1:8473" } } }`. It
must not also be copied into a scanned `plugins/` directory, or it loads twice. The daemon — `bin/watcher-daemon` in the
same package, run by `services.watcher-daemon.enable` (`nixosModules.watcher-daemon`) — holds every source token in its
own secrets file and does all the forge (and GitHub, Slack, PagerDuty, Linear) reading there; the operator's ruling of
2026-11-26 is the shape: forge credentials never land in the opencode environment. The daemon's `settings` is the
watcher block's non-secret surface (`forgeUrl`, `pollSeconds`, the source blocks); the secrets file feeds the unit's
`EnvironmentFile` (`FORGEJO_TOKEN` and the other tokens, plus `WATCHER_OPENCODE_PASSWORD`), and `opencodeUrl` states the
opencode server the daemon delivers mail through. Without the daemon running, the tools error named on the call.

The other non-memory plugins load the same two ways. The reminders ride the scanned plugins directory like the memory
plugin — `plan-reminder` and `discovery-reminder` ship as flat files the module links out of their packages. The
director is its own product with its own module: `homeManagerModules.director` exposes `services.director.enable` (and
`package`, `pluginDir`, and the `permissionRules` floor), installs with no memory dependency at all, and links the built
plugin folder whole into the scanned plugins directory — the plugin registers its agent, skills, and commands at load,
so no per-file links ride the deployment; settings ride an object-form `plugins` entry naming that linked directory,
spelled exactly as it sits on disk (the directory's own README carries the rule and why). The floor's permission rules
render from `services.director.permissionRules`.

### Running the daemon as a system service (hosts without home-manager)

`nix build .#memory-store` packages the application itself: the app package — `memory/store/`, with the app's sources
under its own project root (`memory_store/`, the daemon, sync, and hub sources grouped as the app composes them, the
daemon entry at `memory_store/server/daemon.py`) — plus `uv.lock` and `pyproject.toml`, the capture hook (the memory
product's `cursor-client/`, installed at the `clients/cursor` layout the daemon matches on), the shipped
`instructions/`, and a `VERSION` stamp, land at `lib/memory-store` in the store path, and it wires nothing on their
behalf: no launchd agent, no systemd unit, no client registration. The sibling packages round out the suite
(`.#memory-hub`, the sync relay; `.#memory-store-plugin`, the OpenCode capture plugin; `.#zenigata`, the pull-request
review bot; `.#forgejo-adapter`, its forge adapter; `.#mail-watcher`, the OpenCode plugin and the watcher daemon behind
it — the plugin reports watched Forgejo runs as session mail, wakes its session on pull-request reviews that arrive
after the watch registers — never on the backlog the PR already carried, never on an unsubmitted draft — and turns
PagerDuty incidents and Linear ticket changes into mail the same way, all of it read by the standalone daemon
(`services.watcher-daemon`), which holds the tokens and serves the credential-free route the plugin proxies to;
`.#director`, the coordination plugin; and the writs' reminder plugins, `.#plan-reminder` and `.#discovery-reminder`). A
host without home-manager runs the daemon straight out of that package, with the recipe its own module uses on Linux —
`<app-src>` below is the package's `lib/memory-store` path, and the recipe points the daemon's package imports at it via
`PYTHONPATH`, the package's import root:

```sh
export UV_PYTHON=<nixpkgs python>/bin/python3.12
export UV_PYTHON_PREFERENCE=only-system
export UV_PROJECT_ENVIRONMENT=<writable state dir>/venv
export PYTHONPATH=<app-src>
uv sync --frozen --project <app-src>
exec uv run --frozen --no-sync --project <app-src> python3 <app-src>/memory_store/server/daemon.py
```

The environment contract, with the home-manager module's daemon defaults:

| Variable                         | What it carries                                                                                                                                                         | Default                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `MEMORY_MCP_PORT`                | The MCP and `/nudge` listen port — the daemon binds 127.0.0.1 unconditionally, so the number is the only thing a host chooses                                           | `17173`                          |
| `MEMORY_DATA_DIR`                | The SQLite store and the rendered floor                                                                                                                                 | `~/.local/services/memory/data`  |
| `MEMORY_QUEUE_DIR`               | The capture queue the clients append to                                                                                                                                 | `~/.local/services/memory/queue` |
| `MEMORY_HUB_URL`                 | The hub relay to sync with; empty keeps a local-only store: nothing queues for push and no sync cycle runs                                                              | empty                            |
| `MEMORY_EMBEDDING_MODEL`         | The fastembed model for recall vectors; its dimension is written into the store the first time the store is created, so changing it later is a migration, not a setting | `BAAI/bge-small-en-v1.5`         |
| `MEMORY_EMBEDDING_DIM`           | Vector width, needed only for models outside the known-dimension table                                                                                                  | unset                            |
| `MEMORY_LLM_BASE_URL`            | OpenAI-compatible endpoint for consolidation; empty disables summarizing                                                                                                | empty                            |
| `MEMORY_LLM_MODEL`               | The model name at that endpoint                                                                                                                                         | empty                            |
| `MEMORY_LLM_TIMEOUT`             | Ceiling, in seconds, on one summarize call                                                                                                                              | `300`                            |
| `MEMORY_LLM_EXTRA_BODY`          | A JSON object merged into every chat-completion request                                                                                                                 | empty                            |
| `MEMORY_CONSOLIDATION_IDLE_SECS` | How quiet a session must be before its turns are summarized                                                                                                             | `600`                            |
| `MEMORY_SPAN_LOG`                | The daemon's span-log level: `debug`, `info`, or `error`                                                                                                                | `info`                           |
| `MEMORY_TOOL_HOLDS`              | Whether a tool rule may refuse a bound tool's first call in a conversation; `0` makes every tool rule informational                                                     | `1`                              |
| `MEMORY_MACHINE_ID`              | The origin stamp on records; the hostname when unset                                                                                                                    | unset                            |
| `MEMORY_HUB_API_KEY`             | The hub's credential — secret-file territory (agenix/sops), not cleartext config                                                                                        | empty                            |
| `FASTEMBED_CACHE_PATH`           | Where fastembed caches the embedding model                                                                                                                              | `~/.cache/fastembed`             |
| `UV_CACHE_DIR`                   | uv's cache for the venv bootstrap; its stock location is `~/.cache/uv`                                                                                                  | unset                            |
| `UV_PROJECT_ENVIRONMENT`         | Where uv builds the venv — the nix store path holding the app package is read-only, so a host recipe always sets this                                                   | unset                            |
| `UV_PYTHON`                      | The interpreter uv builds and runs the app with                                                                                                                         | unset (the recipe above pins it) |

On a hardened host (`ProtectSystem=strict`, as systemd spells the idea), the paths that take writes must sit inside the
service's grants: the state directory (the venv), `MEMORY_DATA_DIR`, `MEMORY_QUEUE_DIR`, `FASTEMBED_CACHE_PATH`, and
`UV_CACHE_DIR`. The two directory defaults above live under a home directory, which a system service should not touch,
so a host recipe relocates them together and grants them in one place — `StateDirectory`/`ReadWritePaths` wiring on
systemd, the equivalents on other inits. The same grant set needs the cache paths, since both take writes during
startup; create the directories before the first start, because the daemon itself only guarantees the queue dir.

Two notes the home-manager module documents and this recipe inherits:

- The store loads `sqlite-vec` through python's loadable-extension hook. NixOS refuses uv's own managed CPython (a
  dynamically linked binary; the service crash-loops with exit 2), which is why `UV_PYTHON` points at a nixpkgs python:
  `pkgs.python312` is the tested pick and loads `sqlite-vec` via `enable_load_extension`. A python that cannot load
  extensions degrades recall from an index lookup to a scan of every vector, and nothing reports the loss — keep that
  property if you point the recipe at a different interpreter.
- The first start needs network: `uv sync --frozen` resolves the dependency set from `uv.lock` and populates
  `UV_PROJECT_ENVIRONMENT` and `UV_CACHE_DIR` from the package index. Later starts run offline — uv re-syncs from the
  warm cache and then execs the daemon.

`nix/hm-module.nix` is the readable reference implementation of the same recipe: its Linux branch carries this exact
export ordering and the writable-path layout in one place. Any consumer of the same shape can point at this section
instead of carrying its own copy of the recipe, so a change to how the daemon starts has to land once rather than twice.
