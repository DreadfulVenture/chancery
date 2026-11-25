# director

The coordination plugin for OpenCode: one folder that gives a director session its whole surface. Loaded, it registers

- the **director agent** (parsed from `agent/director.md` at load time),
- the **orchestration skills** — `orchestrate`, `dispatch-worker`, `steer-worker` — from `skills/`,
- the **commands** — `drive-project`, `status-report` — from `commands/`,
- the **tools**: `director_dispatch`, `director_steer`, `director_worker_status`, `director_sessions`, `report_read`,
  `manifest_write`, `manifest_read`, `manifest_drop`, `worktree_add`, `worktree_remove`, `worktree_list`.

The module (`director.ts`) is the server part and has no npm dependencies — node builtins only. It is also the mail leg
the mail-watcher imports; one envelope definition for the family, never a fork. The files it reads at load time resolve
beside itself, so the packaged layout mirrors the source layout: `agent/`, `skills/`, `commands/` at the artifact root.
The entry's setup also registers the per-turn delegation reminder (PRJ-519), inline in the entry so the folder ships no
second module file. The mechanism is the built-in plan plugin's: the reminder is stored as a host synthetic with
`resume: false` the moment a session is created as the director or switched onto it, so the transcript carries it into
every model window with no wake and no empty turn, and the model-request assembly hook re-checks each window and splices
(and re-stores) what compaction stripped — or a leave line, when the session's agent moved off the director. Two
activations that both see a lane change each persist their own copy; the reconcile's exact-text scan of the window
treats any copy as carried, the same unguarded shape the plan reminder ships with.

## Install

`nix build .#director` from the chancery flake produces the plugin folder. Link it into the scanned plugins directory:

```
~/.config/opencode/plugins/director -> <the built folder>
```

The home-manager wiring does exactly that: import the flake's `homeManagerModules.director` and set
`services.director.enable = true;` (the `pluginDir` option relocates the link; `permissionRules` carries the
deny-by-default floor for deployments that render their own opencode config). The module installs independently of the
memory stack.

OpenCode discovers package directories there, so every session gets the surface; the directory is a watched config root,
so a rebuild is picked up the way the other scanned plugins are. A running session keeps the version it loaded; new
sessions pick up the new build.

## Configure

No settings by default. To attach settings, add one object-form entry to `opencode.json` naming the **same directory**,
spelled exactly as it sits on disk — absolute path, no `~`, no trailing slash:

```json
{
  "plugins": [
    {
      "package": "/home/<user>/.config/opencode/plugins/director",
      "options": { "logLevel": "debug" }
    }
  ]
}
```

Because the entry names the directory the scan already found, it attaches to that one load; there is still exactly one
instance. The spelling is load-bearing: a differently spelled path to the same directory registers a second instance
under the same plugin id, the entry is discarded as a duplicate, and its options vanish silently (the only trace is a
`failed` row in `opencode plugin list`; upstream issue anomalyco/opencode#48706, still open).

The one option today is `logLevel`: set it to `debug` to make the module emit point observations on stderr (dispatches,
steering, registrations, wake notices). The environment is not read — a client runs with whatever its editor was
launched from, so settings ride the config entry or nothing.

## The agent definition

`agent/director.md` is the source of truth for the agent, in the frontmatter-plus-body form. The plugin parses it
strictly: the fields it accepts are exactly `description`, `mode`, `temperature`, and the legacy `permission` map (whose
action names it migrates the way the host migrates agent files — `task` to `subagent`, `bash` to `shell`). An unknown
field, an unknown mode, or an unknown effect is an error at load time, never a silent ignore. The parsed definition is
registered through an upsert: the host's `update` creates the agent when the id is missing (upstream #45841), then
applies the callback. A consumer's own `agents.director` entry or `agent/director.md` overrides it per field: the host
applies configured plugins before config-file agents, and the config layer sets only the fields its entry defines, so
the consumer's values win. Permission rules evaluate last-match-wins (the host's `Permission.evaluate` takes the last
matching rule), and the consumer's rules land after the shipped ones.

The local-permission rules and this file move in lockstep: a rule in the module's permission floor without its
counterpart allow here strips a tool from the director agent.

## Checks

- `make test-director` runs the tests, including the shipped-file parse and the registration assertions.
- The package build refuses skills that still carry a client-split marker.
- The root flake's `director-loads` check imports the packaged entry and parses the packaged agent definition, so a
  layout slip or a malformed file is a build failure instead of a plugin OpenCode silently skips.
