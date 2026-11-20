# ADR 20260921: Injection/tool key alignment — `rule_feedback` accepts the injection's `id`

- **Status**: Draft
- **Provenance**:
  - Authored: agent (opencode, poor-ladybug worktree)
  - Edited: (none)
  - Approved: (none)

## Context

The fired-rules injection renders each rule's key as `id`, and the standing instruction layer
(opencode/instructions/memory.md) says to grade a surfaced rule "using its `id` directly". The `rule_feedback` tool —
schema and handler — takes `rule_id`. On 2026-09-21 an ears-repo session graded a fired rule by copying the injection's
key verbatim (`{"id": "902359124", "signal": "soft"}`); the call reached the daemon and was rejected twice with
"rule\*id and signal (confirm|disconfirm|soft) required" — `id` fell into `\*\**`, `rule_id` defaulted to 0, validation
raised. The session correctly concluded the tool was broken and moved on; the grading signal was silently lost.

The failure is probabilistic: an agent that reads the tool schema sends `rule_id` and succeeds; an agent that follows
the injection and standing instruction sends `id` and fails. Both behaviors were correct per their respective surfaces.
This is the ADR 20260918 defect class exactly — tooling that is not instinctive is a tooling defect, not an agent
discipline failure. It compounds the earlier id-rendering fix (the injection gained ids so grading could key on them) by
making the rendered key name wrong for the tool that consumes it.

The same key exists in `rule_list` output (`id`), so this is not specific to the injection — every surface the agent
sees names the key `id`; only the tool input names it `rule_id`.

## Decision

`rule_feedback` accepts `id` as an alias for `rule_id`, in both layers:

- The `Tools.rule_feedback` handler resolves `rule_id` from `rule_id` or `id` (coercing stringified integers), before
  validation.
- The daemon's `RecordEmittingTools.rule_feedback` wrapper forwards `id` the same way — its `**_` would otherwise
  swallow the alias one layer up.
- The tool definition publishes `id` (integer, documented as the alias for the id rendered in fired-rule injections)
  alongside `rule_id`.

The alias, not a rename, wins: renaming the injection's key to `rule_id` would fix the nudge surface but leave
`rule_list` output (also `id`) misleading, and would churn the injection format agents already grade against. Accepting
the injection's name at the tool boundary fixes every surface at once, keeps `rule_id` working for schema-readers, and
costs nothing else — record-id generation and self-echo idempotency are untouched.

## Alternatives

- **Render `rule_id` in the fired-rules injection** (`frameRules` renaming the key): fixes only the nudge surface;
  `rule_list` still renders `id`, so the mismatch survives one hop away. Rejected — fixes one consumer instead of the
  shared boundary.
- **Rename the tool parameter to `id`**: matches the injection but breaks the published schema contract and every
  existing well-formed caller for cosmetics. Rejected.
- **Re-educate the instruction layer** ("the injection's `id` is called `rule_id` at the tool"): the ADR 20260918 ruling
  — exhortation is the wrong channel; if two correct-sounding paths diverge, the tooling absorbs the difference.
  Rejected.

## Consequences

- Grading from a fired-rule injection or from `rule_list` output works with the key as rendered; the drop path (`id`
  silently swallowed, tool errors on a well-intentioned call) is closed.
- The schema remains permissive at one boundary: `rule_feedback` now accepts both names. This is confined to a tool
  whose arguments are composed by an agent from rendered data — not a wire or storage format, so no vocabulary drift
  enters the sync wire (records still carry the canonical shapes).
- Deploy rides the normal daemon-package rebuild; until a host rebuilds, the failure class persists there unchanged.
