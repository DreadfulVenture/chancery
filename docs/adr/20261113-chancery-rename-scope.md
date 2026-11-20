# ADR 20261113: Chancery names the repo only — component names stay at their own scope

- **Status**: Draft
- **Provenance**:
  - Authored: agent (boundary dictated by the operator in four corrections, 2026-11-13, planning PRJ-223)
  - Edited: none
  - Approved: none
- **Companion**: PRJ-223 (repo rename)

## Decision

The Forgejo repository `memory-store` is renamed to `chancery`, and only repo-identity references rename with it.
`memory-store` is, and stays, the name of the Python application this repository distributes: the daemon, its store, its
plugin, and every identifier that belongs to the application keep the memory-store name inside a repository called
chancery.

The boundary, with the operator's rulings attached:

- **Repo/suite → chancery.** The Forgejo repo name, the README title, and prose that refers to the repository as an
  entity. The suite is a set of products under one roof, in the same dry-British-institution register as bedlam;
  chancery is the office that keeps the rolls and issues the writs.
- **The app → memory-store, unchanged.** The pyproject name, `package.json`, the flake packages `memory-store`,
  `memory-hub`, `memory-store-plugin`, `memory-store-opencode` ("memory-store-plugin is memory-store-plugin. It stays.
  Maybe chancery grows another plugin later... It's a suite."), the `lib/memory-store` share layouts, the
  `services.memory-store.*` home-manager option tree, the daemon unit/bin/stateDir names,
  `memory-store-register-plugin`, the `memory-store.example.com` hub domain, and the `app='memory-store'` provenance
  labels written into the store. Consumers keep their flake input key `memory-store` and change only the input URL.
- **Preserved by the ticket, still preserved.** The `memory_*` tool family, the daemon home `~/.local/services/memory`,
  the plugin file `plugin/memory.js` (and the plugin id inside it), and the deployed rule names
  `~/.cursor/rules/memory.mdc` / `memory-floor.mdc`.
- **The writs are chancery-level products.** The fourteen skills (the review-\* family, write-ticket, claim-check,
  adr-writing, decision-lookup, git-workflow, humanizer, incident-timeline), the OpenCode agents, and the commands are
  the suite's own output, not memory-store's. Only `humanizer` mentions memory-store; where it names the daemon or the
  writing source the referral stays app-correct, and where it names the repo the phrasing becomes chancery.
- **Other repos are their own lanes.** The work deployment's consumer-side change is the operator's alone; agents do not
  clone, read, or sweep that repository. The example deployment stays this repo's own PR per PRJ-223's terms.

## Why

An agent drafting PRJ-223 wrote "packages rename: memory-store-plugin → chancery-plugin, memory-store-opencode →
chancery-opencode" and a repo-wide sweep, reading the repo name as a namespace prefix. The name is not a prefix: each
name in this repository belongs to a component with its own identity. The memory-store application keeps its name
because that application is what the plugin, the options, and the deployed paths belong to; renaming the repo would
otherwise strand identifiers at a level they do not sit at. Four corrections settled it: first the app-is-a-component
ruling, then the plugin package stays, then the skills are not memory-store's, then the work deployment is not even
opened.

The two exceptions to the memory-store namespace were known and deliberate before this ticket: the shipped-rules surface
already deploys under the office's name, and the Linear project is already Chancery (renamed 2026-11-10). Rules ship
under the office's name; the app keeps its own. A suite that grows another component names that component for itself.

Rejected alternative: the ticket's original sweep — every `memory-store` string to `chancery`. Rejected because it
renames component identity, breaks consumer contracts named after the app (`services.memory-store.*`, the
`memory-store.example.com` domain) while nothing about the app changes, and pastes a suite name over rows of stored
provenance data that no session ever asked to re-read differently. Consequence: PRJ-223's own description carries this
falsified bullet and is corrected in the rename's Linear sweep; the actual code diff is prose-only in this repository.

## Consequences

The repo-identity update is a small, prose-level diff in this repository, plus the Forgejo rename itself; consumers
update nothing but input URLs and identity phrasing, and Forgejo's redirect on the old URL means no consumer breaks
during the window. The app's contract surface — options, packages, tool names, paths — is untouched, so no stored-data
migration, tool rename, or deployed-path relocation belongs to this pass. If a future pass renames any component-level
identifier, it rides its own ticket with its own blast radius.
