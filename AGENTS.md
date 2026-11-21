# Repository agent guidance

This is a monorepo for multiple agent tooling projects.

## Background work belongs with the product that owns it

When a design in this repo needs background, periodic, watching, or scheduled behavior, name the product that owns that
behavior before choosing where it runs. Chancery is a monorepo of multiple products: the memory daemon and its plugin,
zenigata (`review/zenigata`), the forgejo-adapter (`review/forgejo-adapter`), the skill tree (`writs/skills`), and the
nix modules (`nix/`). Each product owns its own surface. If no product owns the behavior, choosing that product's home
is part of the design, not an afterthought.

## The memory daemon is not a hosting service

The memory daemon hosts memory-platform behavior only: capture, sync, recall, nudges, consolidation, and their kin.
Reading or extending memory behavior in the daemon is normal work; adding unrelated background behavior to the daemon is
not. A daemon that exists is not a hosting service.

The memory daemon sits on the critical path of memory reliability for every host that adopts it. A job stapled onto the
daemon widens its failure surface, its lock contention, and its deploy risk for every consumer that only wanted memory.
One running process is not a claim on another product's work; keeping work with its owning product keeps each product's
failures inside that product.

## Gates and hooks

Gates run under `nix develop`, and one invocation writes the untracked `.pre-commit-config.yaml` (a symlink into the
store config) plus the `.git/hooks` pre-commit and pre-push files that linked worktrees share through the common gitdir.
A fresh worktree needs one `nix develop` run before its first push, or the shared pre-push hook refuses it ("No
.pre-commit-config.yaml file was found"). The hooks are never silenced or bypassed.

## Source language

New source code is TypeScript. Raw JavaScript does not enter the repo without the operator's express approval (ruled
2026-11-19): no new `.js` sources, no new extensionless JS scripts. The existing raw js — the mail-watcher's modules and
the oc-wake bin — converts to TypeScript; until a file converts, edits to it ride the conversion instead of growing the
js surface. The loader is not a constraint: opencode runs on Bun, which imports TypeScript natively.

## Skill references resolve at runtime

A skill's ID is the directory name on its deployment path, exact and case-sensitive; the frontmatter name is only a
display label (`opencode.ai/docs/skills`, "IDs" and "Loading"). When prose tells an agent to use a skill, the reference
has to resolve where the prose is read: "Load the `humanizer` skill" resolves everywhere, because the agent loads it
through the `skill` tool with that ID. A repo-relative path (`writs/skills/humanizer/SKILL.md`) resolves only in a
checkout; deployed rule files live in the operator's home directory, where the repo tree does not follow. In chat, the
operator loads a skill by mentioning it as `@skill-id`.

Skills ship from `writs/skills` to the deployed clients. Repo-specific skills that must NOT ship globally live in
`.agents/skills/` in the repo tree instead — an in-repo home a checkout resolves but the deployment story never carries
(the chancery licensing lens is there, because it describes this repo's own provenance system). Record any new home a
skill takes here, so the delivery story and the tree tell one story.

## State that keeps needing line math lives in the director plugin's manifest surface

When a working state — a run manifest, a plan, a slice's fact sheet — starts needing exact-match edits, `grep -n`, or
line-number surgery to update, the file has rotted as that state's home: write the state as facts into the director
plugin's manifest surface instead. `manifest_write({key, fact, supersedes?})` stores one fact under a stable key,
`manifest_read()` renders the composed view (the newest fact per key, superseded rows folded out), and
`manifest_drop({key | id})` retires rows you own. Files are exports of the view, never the source of truth: generate a
file from `manifest_read()` when one is needed, and never hand-edit that file back as if it were the state itself.
Nothing delivers on its own — the surface is read-when-read, and every session shares the same view.

## Publication hygiene

This repo is published to a public GitHub mirror as MIT, while the private Forgejo stays the working origin. Nothing
private enters the tree, the history, or a commit message. New prose and new code never name: the private forge or its
domains, employer systems or addresses, the machine names of the operator's hosts, other private repos or trackers
(other systems' PR or project numbers), internal tool names, or personal usernames in fixtures. Use the neutral
placeholders the tree already carries: the example.com forge, git, and service hosts, the neutral login, "the operator",
and host role words ("the hub host", "a client host", "a laptop"). PRJ-### ids and "the operator" are expected and fine.
