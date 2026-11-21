---
name: licensing-chancery
description: >-
  The chancery lens for licensing: load it alongside licensing when working in the chancery repo. Carries this repo's
  provenance system — the three-place record, the worked example, and the attribution convention — faithful to the facts
  the artifacts state. Read the artifacts, not just the skills, when exact wording matters.
---

# The chancery lens

This lens modifies `licensing` for the chancery repo. Where it speaks, it wins on its own subject matter — this repo's
provenance system. Verified against the artifacts on 2026-11-20: `LICENSE`, `NOTICE.md`, and the lifted sites'
provenance comments.

Chancery records third-party derivation in three places, each with one job: the license text lives in `LICENSE`;
`NOTICE.md` is the map, not a second legal notice (its own words); and lifted sites carry one-line provenance comments
in the file itself. `coordinate/director/director.ts` — the director module, derived from `@sysread/thatch` — is the
worked example for all three.

## LICENSE

The license text lives in `LICENSE` alone, in two parts.

- Chancery's own part comes first: the MIT license, `Copyright (c) 2026 nalabelle`.
- A third-party source joins as its own part below a `---` separator, on the pattern of the `@sysread/thatch` part: a
  short prose line naming the source, the notice the source requires, and the license text carrying the source's own
  copyright line (`Copyright (c) 2026 Jeff Ober`).
- Parts are never dissolved or merged into one block: each part keeps its own copyright line, so the notice a source
  requires stays attached to that source.
- No per-file license headers.

## NOTICE.md

`NOTICE.md` opens `# Provenance` by stating the role the map plays: attribution sits next to the code it describes, and
the license text stays in `LICENSE`. One row per derived site, in its four-column form: the derived site in chancery,
the source in the upstream (file and approximate lines), a classification (`verbatim`, `lightly-adapted`, `structural`,
`imported`, `ported`), and what was rewritten rather than lifted.

- The bar is the map's own: a row exists where a specific source mechanism can be named and located. Lifted functions,
  structurally copied mechanisms, and close rewrites count. Generic idioms that independent code would express in
  passing get no row; the director module's independent remainder is covered the way the map's closing paragraph covers
  it, as code with no counterpart, not as rows.
- A lifted row is matched by a one-line `from @sysread/thatch` comment at the lifted site naming the same origin: map
  and code tell one story. The other rows match by their own form — an `imported` row's derivation lives in the module
  rows it points at, and the `ported` row's match is the port's own NOTICE.md (the fence section below).
- The map mirrors `LICENSE` and never duplicates legal text.

## Provenance comments

The matching one-line comment at each lifted site, in the module's shape — origin, upstream file with approximate lines,
license, and what was taken:

`// from @sysread/thatch (src/opencode/v2.ts ~934-938, MIT): the session.create no-id guard.`

## Stating the fence

Comment and row name the lifted piece and the chancery-owned rest in the same breath ("the dead-target refusal's opening
clause …; the rest is ours"). A prose port states the same fence in place, as the `humanizer` skill's NOTICE.md does —
upstream named, license preserved, local divergence listed (its "Local divergence from upstream" section).

## Attribution

Attribution prose — the includes-code-from line in `LICENSE` and the from-comments at lifted sites — names
`@sysread/thatch`, the public home's owner and name (`https://github.com/sysread/thatch`), never the npm scope. The npm
package name `@jeffober/thatch` stays for real npm-package references; none exist in-tree today.

## The artifacts win

The artifacts win over this file and the core skill wherever they compress them: read `LICENSE`, `NOTICE.md`, and the
lifted sites — not just the skills — when a change needs the exact wording.
