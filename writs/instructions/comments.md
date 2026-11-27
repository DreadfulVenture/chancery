# Comments

Context for every agent reading this: this file holds the operator's standing rules for comments, always in force.

Durable comments only. Comment to explain why, inline and self-contained: not where the code lives, not what comes next,
and never a restatement of what the code already says. If your comment is annotating the code right next to it that
someone can read themselves, it does not need to exist. Comments should be minimal, code should be simple and
self-explanatory and generally sparse on commenting except in cases where someone needs to be aware of something
unexpected.

Never reference what goes stale: line numbers, "above" and "below", volatile file paths, module or symbol locations used
as navigation, branch-local or uncommitted docs, plans, roadmaps, change history, internal wikis, and GitHub blob or
line URLs.

Durable anchors are fine: a file, module, or doc already on origin/main (prefer a stable title over a path), a
consistent feature label linking distant pieces of one feature (`// feature foo: ...`), a ticket ID when the reason
depends on a tracked decision and the comment still stands if the issue closes, and stable external specs such as RFCs
and vendor docs. The pointer is supporting context, never the sole carrier of the why.

No history. A comment describes the code as it is now, never the change: no "we used to", "now we", "switched to",
"originally". One exception: a current condition that reads like history, such as "older DB rows may still have X, so
Y".

No "temporary until" without a concrete, checkable trigger; prefer fixing the debt or opening an issue. A TODO describes
the problem, not a prescribed fix, and is never a bare stub. No commented-out code, and no duplicating types or
contracts in prose. Do comment non-obvious rationale, invariants, external quirks, and security or safety intent.

A comment describing a third-party library's internal behavior is a non-durable comment, the same family as one citing
line numbers or a volatile path. It rots on a dependency upgrade, and it rots when our own code stops taking that path.
Nothing fails when it does: no test asserts a comment, and nobody greps prose on a lockfile bump. It is worse than a
stale doc reference because it reads like knowledge of our own code. Readers trust it, and only someone reading the
vendor source catches the rot.

First choice is to avoid the claim. If the point survives without it, drop it and state the contract our own code
enforces instead: "a length has to be a whole number of seconds, whatever the flag source returns" survives any upgrade.

When the point genuinely needs the vendor's behavior, two requirements, both mandatory. Pin the version in the sentence,
and validate the claim by reading that exact version's source and tracing the path our own call takes. Recalling the
behavior does not count, and neither does citing a guard that merely resembles the claim. For a deliberate workaround,
also cite the upstream issue, so staleness on upgrade is the signal to revisit.
