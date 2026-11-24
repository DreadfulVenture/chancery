# Zenigata

Zenigata is the pull-request review bot of the chancery house: an operator tags a pull request for review, the bot runs
a reviewer session over it, and the review lands on the pull request as comments — verdict, summary, and inline notes.
Replies to its comments get answers in thread, and what those exchanges surface about the repository is stored for the
next review. The bot never merges, never labels, and never publishes anything beyond its own comments.

A review runs in three passes — a blind pass over the diff, a context pass that reconciles it with the pull request's
description and with what the memory store holds about the repository, and a humanize pass that strips the machine tells
from the prose. The verdict follows from the findings alone: nothing blocking approves, anything blocking requests
changes.

## Architecture

The bot core consumes two contracts and nothing concrete: a `ForgeAdapter`, which isolates it from whatever forge the
deployment runs, and a `SessionDriver`, which isolates it from the agent runtime. The concrete adapters — HTTP for the
forge side, the opencode background service for the sessions, the memory daemon's MCP endpoint for observations — live
in `src/adapters/`, so a deployment can swap either side without touching the pipeline. The intake server accepts
adapter events, the review pipeline drives the three passes, validation and one corrective retry per JSON stage guard
the payloads, and everything the bot does lands in an append-only journal and a set of metrics.

## Layout

| What                        | Where                                                     |
| --------------------------- | --------------------------------------------------------- |
| Bot core and pipeline       | `src/`                                                    |
| Contracts                   | `src/contracts/`                                          |
| Adapters and test doubles   | `src/adapters/`                                           |
| Review agent definition     | `agent/reviewer.md`                                       |
| Persona (packaged default)  | `persona.md`                                              |
| Status page icon (packaged) | `assets/favicon.svg`                                      |
| Nix package and module      | `package.nix` (this dir), `../../nix/zenigata-module.nix` |
| Docs                        | `docs/`                                                   |

## Local development

Node and npm come from the flake's dev shell:

```sh
nix develop -c npm test        # the full suite
nix develop -c npm run build   # tsc into dist/
nix develop -c npm run typecheck
```

The tests are hermetic: they run against a bare git fixture, the in-tree adapter doubles, and an in-memory MCP server —
no forge, no network, no agent runtime.

## Building the package

```sh
nix build .#zenigata
```

The output carries `bin/zenigata`, the packaged persona at `persona.md`, and the agent definition at
`share/zenigata/agent/`. The NixOS module (`nixosModules.zenigata`) wires the service.

## Docs

- `docs/forge-adapter.md` — the HTTP contract an adapter author implements.
- `docs/session-driver.md` — the session driver contract and the version-pin rationale.
- `docs/deployment.md` — every environment variable, the NixOS module options, metrics, the journal schema, and the
  memory URL composition.
