---
name: licensing
description:
  Use when creating files that lift, port, or duplicate logic from an upstream source; when adding a dependency or
  vendored code; when touching LICENSE or NOTICE.md; and when unsure whether a copy counts as derived.
license: MIT
metadata:
  audience: agents
  workflow: licensing
---

# Licensing

Chancery records third-party derivation in three places, each with one job: the license text lives in `LICENSE`;
`NOTICE.md` is the map, not a second legal notice (its own words); and lifted sites carry one-line provenance comments
in the file itself. `plugin/director.ts` — the director module, derived from `@sysread/thatch` — is the worked example
for all three. The artifacts win over this file wherever it compresses them; read them, not just this skill, when a
change needs the exact wording.

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
the source in the upstream (file and approximate lines), a classification (`verbatim`, `lightly-adapted`, `structural`),
and what was rewritten rather than lifted.

- The bar is the map's own: a row exists where a specific source mechanism can be named and located. Lifted functions,
  structurally copied mechanisms, and close rewrites count. Generic idioms that independent code would express in
  passing get no row; the director module's independent remainder is covered the way the map's closing paragraph covers
  it, as code with no counterpart, not as rows.
- Each row is matched by a one-line `from @sysread/thatch` comment at the lifted site naming the same origin: map and
  code tell one story.
- The map mirrors `LICENSE` and never duplicates legal text.

## The same change

Provenance ships with the lifted code it describes: the NOTICE.md row and the in-code comment land in the same change as
the lifted logic, and the LICENSE part lands in that change too when the source is new to the repo. Provenance is never
deferred to a cleanup pass and never batched.

## Adding a new source

In order:

1. Extend `LICENSE`: the new source joins as its own part with its own copyright line, on the part pattern above.
2. Add `NOTICE.md` rows, one per derived site, in the map's four-column format.
3. Add the matching one-line comments at each lifted site, in the module's shape — origin, upstream file with
   approximate lines, license, and what was taken:
   `// from @sysread/thatch (src/opencode/v2.ts ~934-938, MIT): the session.create no-id guard.`
4. State the fence honestly: what in the source is platform-specific and what is portable here. Take the map's wording
   as the pattern — comment and row name the lifted piece and the chancery-owned rest in the same breath ("the
   dead-target refusal's opening clause …; the rest is ours"). A prose port states the same fence in place, as the
   humanizer's NOTICE.md does: upstream named, license preserved, local divergence listed.

## Before committing

- The diff is reviewed for lifted, ported, or duplicated logic.
- Rows, comments, and — when the source is new — the LICENSE part are present, and they agree with each other.
- `NOTICE.md` is still the map, not a second legal notice.
- No new policy: the change adds no licensing rule the artifacts do not already show.
