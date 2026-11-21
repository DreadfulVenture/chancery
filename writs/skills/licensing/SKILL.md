---
name: licensing
description:
  Use when creating files that lift, port, or duplicate logic from an upstream source; when adding a dependency or
  vendored code; when touching LICENSE or NOTICE.md; and when unsure whether a copy counts as derived. Repo-specific
  provenance systems ride in lens skills loaded alongside this one (the registry in the Lenses section names them).
license: MIT
metadata:
  audience: agents
  workflow: licensing
---

# Licensing

A repo records third-party derivation in its own artifacts: a license text, an attribution map beside the code, and
one-line provenance comments at the lifted sites. This skill states the discipline those artifacts carry. Where a repo
has a provenance system of its own, it rides in a lens skill loaded alongside this one (see Lenses); the lens carries
that repo's concrete record and its worked example, and wins on its own subject matter.

## LICENSE

The license text lives in the repo's `LICENSE` alone, in parts.

- The repo's own part comes first: its license and its own copyright line.
- A third-party source joins as its own part below a `---` separator: a short prose line naming the source, the notice
  the source requires, and the license text carrying the source's own copyright line.
- Parts are never dissolved or merged into one block: each part keeps its own copyright line, so the notice a source
  requires stays attached to that source.
- No per-file license headers.

## The attribution map

Attribution sits next to the code it describes. A map file — `NOTICE.md` or the repo's equivalent — lives beside the
operative files it describes and carries one row per derived site: where the derivation came from (file and approximate
lines), how close the copy is, and what was rewritten rather than lifted. The license text stays in `LICENSE` — the map
is attribution beside the code, not a second legal notice.

- The bar is the map's own: a row exists where a specific source mechanism can be named and located. Lifted functions,
  structurally copied mechanisms, and close rewrites count. Generic idioms that independent code would express in
  passing get no row; an independent remainder is covered as code with no counterpart, not as rows.
- Each row is matched by a one-line provenance comment at the lifted site naming the same origin: map and code tell one
  story.
- The map mirrors `LICENSE` and never duplicates legal text.

## Attribution conventions

Attribution prose — the license's includes-code-from lines and the provenance comments at lifted sites — names the
upstream's public home by owner and name, so the prose resolves to where the source lives. An npm scope stays where an
npm package is genuinely referenced: a package name in a manifest, a lockfile, or an import is a package reference and
keeps its scope; attribution prose is not one.

## The same change

Provenance ships with the lifted code it describes: the map row and the in-code comment land in the same change as the
lifted logic, and the LICENSE part lands in that change too when the source is new to the repo. Provenance is never
deferred to a cleanup pass and never batched.

## Adding a new source

In order:

1. Extend `LICENSE`: the new source joins as its own part with its own copyright line, on the part pattern above.
2. Add map rows, one per derived site, in the map's format.
3. Add the matching one-line comments at each lifted site, in the module's shape — origin, upstream file with
   approximate lines, license, and what was taken.
4. State the fence honestly: what in the source is platform-specific and what is portable here. Take the map's wording
   as the pattern — comment and row name the lifted piece and the repo-owned rest in the same breath ("the lifted
   piece's opening clause …; the rest is ours"). A prose port states the same fence in place, in a provenance notice
   beside it: upstream named, license preserved, local divergence listed.

## Before committing

- The diff is reviewed for lifted, ported, or duplicated logic.
- Rows, comments, and — when the source is new — the LICENSE part are present, and they agree with each other.
- The map is still attribution beside the code, not a second legal notice.
- No new policy: the change adds no licensing rule the artifacts do not already show.

## Lenses

The discipline is repo-agnostic: it speaks of a license text, an attribution map, and lifted sites, and never names a
product. The repo-specific provenance systems live in lens skills — one skill per repo, loaded by its ID through the
skill tool:

- `licensing-chancery` — the repo is chancery.

Load the lens for the repo at hand alongside this skill, and run the discipline with the lens's record applied. Where a
lens and this skill disagree, the lens wins on its own subject matter: the repo's concrete provenance system. A repo
with no lens yet runs the discipline plain, reading its artifacts as you go — write the lens down afterward, so the next
run starts from it.
