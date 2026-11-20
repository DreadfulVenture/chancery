# ADR 20260918: Memory tooling ergonomics — non-instinctive use is a design defect

- **Status**: Draft
- **Provenance**:
  - Authored: agent, 2026-09-18
  - Edited: agent, 2026-10-05 (decision 1 amended at the operator's direction: the repo/scope override is removed)
  - Approved: (none)

## Context

The memory store replaced mnemosyne and went live. In the first working sessions on it, the authoring agent misused its
own tooling in three distinct ways, all reproduced live:

1. **Fabricated provenance.** MCP tool calls carry no session context — one daemon serves every session, and the wire
   delivers only method + arguments. With no context channel, the tools resolved repo/scope from the daemon's own
   working directory, stamping real writes with a wrong repo (`insight:example-repo` instead of `insight:example`) and
   rules with a wrong scope. A claim the caller could not make was made anyway.
2. **Un-grounded feedback.** `rule_feedback` trained the classifier on signal alone; the _reason_ for a signal went
   unrecorded. A wrong-reason disconfirm ("good rule, stale metadata") became indistinguishable from a legitimate one
   the moment it landed.
3. **Teaching embedded in data.** The injected fired-rules block carried its own directive text ("they carry decision
   weight… report disconfirming feedback") while the standing instruction layer mentioned grading once in passing.
   Rendered rules showed bare confidence with the evidence count discarded at the export boundary, and stance
   (prescriptive/descriptive) was never rendered — so a prediction about the user's tendencies arrived with the same
   directive force as an agent-discipline rule.

Each failure was initially framed as agent sloppiness. The operator's reframe, adopted here as the decision: **if the
memory tooling is not instinctive to the agent, that is a defect in the tooling — never a discipline failure to be
exhorted away.** The fix channel is code and instruction design: make the correct path the mechanical default, and make
deviation visible in the same turn.

## Decision

1. **Session context is injected, never fabricated.** The client — the only layer that knows the process's project root
   — injects `cwd` into memory tool calls before they reach the wire: opencode through `tool.execute.before`, Cursor
   through a `preToolUse` hook that rewrites the MCP arguments. Tools resolve repo/scope from `cwd` and from nothing
   else; **absent context produces a bare label, an empty scope, no workspace boost — never a guessed value.** Results
   echo the stamp used so a bare or wrong stamp is visible in-turn. The MCP roots back-channel was evaluated and
   rejected (deprecated, SEP-2577); the client hook is the channel. _(Amended below: the agent-supplied repo/scope
   override this clause originally allowed is removed.)_
2. **Feedback carries grounds.** `rule_feedback` takes `grounds` (one line, why); it is recorded in the log as audit
   data and never interpreted. Feedback without grounds is a trained classifier with no evidence trail. "Right content,
   wrong metadata" is a replace (confirm if relevant, codify the corrected rule, disconfirm the old with grounds:
   superseded) — never a bare disconfirm.
3. **Layer separation, per thatch.** Standing instructions (`opencode/instructions/memory.md`) carry the entire
   behavioral contract: when to write, the before-responding sweep, codify discipline (rules encode discipline, not
   shortcuts), and the full grading semantics. The injection is pure framed data: evidence-calibrated lines
   (`[conf C, N tests] When <situation>: <verb> <statement>`) with the verb keyed to evidence count and stance —
   `consider`/`do` prescriptive, `you may prefer`/`you tend to` descriptive. No directive text in the injection; the
   standing layer governs what fired rules mean.

## Consequences

- Mis-stamped writes surface immediately via the echoed stamp rather than being discovered in an audit.
- The grading loop becomes auditable: every trained signal carries its reason.
- Rendered rules are interpretable at a glance — confidence plus sample size plus stance-appropriate verb, instead of an
  unanchored decimal.
- The instruction layer is now the single teaching surface; changes to grading semantics land there, not scattered
  across per-fire directive text.
- If a client's injection channel is ever withdrawn, session context falls back to bare (honest) until a replacement
  exists. There is no agent-supplied fallback behind it; see the amendment.

## Amendment: the agent-supplied repo/scope override is removed

Decision 1 let an explicit `repo` or `scope` beat the injected directory. That path skipped `detect_repo`, so the one
field in a write that was meant to be mechanical became whatever the agent believed — and the belief was wrong: memory
`m18da70919ae88138` is filed under `system` while the other rows from that repo carry the work deployment's repo stamp.
A repo-weighted recall reads those as two projects, which is the fragmentation the resolution chain exists to prevent.

`memory_remember` loses `repo`, `rule_codify` loses `scope`, and `cwd` is the only provenance input. It cannot carry the
same defect, because a directory is resolved through `detect_repo` rather than read as a name. Clients overwrite a `cwd`
that arrives in the arguments instead of deferring to it: a memory belongs to the project of the window it was learned
in, and which window that is, is the thing the agent cannot observe. The agent supplies `cwd` only when a result echoes
an empty stamp, which is what a saved multi-root workspace reporting no roots produces.

The standing rule is the scope axis in `docs/prd/20260911-curated-rules-tiers.md`: metadata resolved mechanically at
tool-binding time, because "environmental metadata must never depend on the agent remembering to supply it."
