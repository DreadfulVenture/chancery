# PRD 20261104: Memory redesign — session registry, knowledge base, event-shaped delivery

- **Status**: Draft
- **Companion ADRs** (the decisions and their measured justification):
  - `docs/adr/20261104-retire-per-message-delivery.md`
  - `docs/adr/20261104-corrections-are-operations.md`
  - `docs/adr/20261104-forget-retains-history.md`
  - `docs/adr/20261104-sleep-scope.md`
- **Audience**: the agents that will implement and run it
- **Provenance**:
  - Authored: agent (design dictated by the operator across the 2026-11-04 session)
  - Edited: agent (2026-11-05, PRJ-175 — KB folds deliberate rows only, one composed doc per project; summaries are
    session-search material)
  - Edited: the operator (directed: Cursor injects the KB doc and fetches the matched facts through `knowledge_read`,
    with a once-per-conversation first-tool refusal; the holds flag ships on)
  - Approved: none

## Requirements

The memory store is a background capability agents (opencode and Cursor today; other tooling later) carry into every
session on every machine. It must deliver:

1. **Standing knowledge at session start.** One per-project knowledge base — the arc of durable project knowledge
   (architecture rulings, current state, open threads) — built by sleep, delivered automatically once per session.
   Content: the KB doc plus the top-k request-matched facts for the opening request (no LLM call at session open; the
   injected block renders top-N at the delivery site and oversize material is reachable by tool call). On opencode the
   block is injected directly, doc and facts together. On Cursor the doc is injected and the facts are fetched: Cursor
   3.29.9 inlines at most 10,000 characters of prompt-hook text per turn, summed over every hook, and moves anything
   longer to a file. The doc is capped at 6,000 characters and fits; the doc plus five facts of up to 1,200 characters
   each does not. The block tells the agent to call `knowledge_read` for the facts before anything else, and the
   conversation's first other tool call is refused once until it has. That refusal applies whatever the `holds` flag
   says.
2. **Exact-moment delivery for bounded actions.** Agents bind rules to tool keys; when a bound tool fires, the rule is
   delivered deterministically — no similarity roll — under one global `holds` flag only the operator sets: ON = the
   first execution of that tool per conversation is rejected with the bound rule as its error text (reject-once; later
   executions are informational), OFF = informational always. Gates fire in every session including child sessions.
3. **Pull-based recall with honest usage signals.** All other memory access is the agent's own query against
   class-labeled results (guidance, facts, summaries, and raw session history grouped by conversation). Summaries are
   session-search material: capture products never enter the knowledge base, whose input is deliberate rows only. Only
   agent-initiated recall stamps usage counters; automatic deliveries never stamp. Usage counters feed staleness
   statistics and an instrumented, counter-gated compliance reminder ladder ("N active turns, zero recalls") that
   observes only _that_ the agent pulled, never _what for_.
4. **State-statement content.** Stored content is present-tense state: no backreferences, no correction narration, no
   change history in row text. Time is row metadata. Correcting is an operation — remember(new) + forget(old), linked
   invisibly by the daemon for provenance ("why did we decide this?" resolves row → session → session history).
   Forgotten rows are retained but never surfaced anywhere.
5. **Structural provenance and fleet sync.** Session identity as a first-class registry (machine, project, tool, parent
   linkage); every row born in a real session, traceable end to end; the append-only journal converges all of it across
   machines.
6. **Instruction-carried discipline.** Static instruction files (AGENTS.md / floor) teach the recall discipline ("recall
   with a composed query before non-trivial work and gated actions") — compaction-immune by construction, valid on every
   client — plus carriage of the write-nudge ("did you learn something worth storing?").

Automatic delivery is event-shaped only — session start and tool moments. Content never rides message arrival.
Everything else is pull.

## The data model

**`session`** — registry row per session: machine, project, coding tool, timestamps, `parent_session` + role (child
sessions are structural, not in-process plugin state).

**`session_history`** — raw captured turns (kind: speech | exhibit | fork_summary), `FK session.id`. Not push material.
(The walk named a `session_summaries` table for this family, with a nullable FK marking consolidation; it was never
built — the episodic consolidator that exists today remains the system's summary producer, and whether summarization
stays in the system at all is separately decided, pending a raw-session-search spike.)

**`knowledge_base`** — one composed doc per project (the session-start seed). Built at sleep by the same agent chain
that summarizes, from the watermarked delta — **new `agent_memory` rows since the build cursor; deliberate rows only,
never capture or summaries** — rolled up with the previous doc, **recency precedence** as the only reconciliation rule —
a newer fact beats the standing claim, decided in composition, while tombstone exclusion and cursor advancement stay
mechanical. Every build keeps its prior version (replace-with-history). No explicit update stream; "KB update" is a
build-internal unit and the cursor is performance-only. Storage is one table:
`(id, project, doc, inputs, build_seq, created_at)` — current doc = highest build_seq with the newest created_at at that
seq (the race tie-break), every version retained, and `inputs` journals the row ids each build consumed (the version's
audit surface; the doc carries no inline citation markers). A forget carries the dead row's text on its tombstone, and
the next build feeds it to the composer as an eviction — the claim leaves the standing sheet without waiting for a
contradicting row.

**`agent_memory`** — facts / insights / decisions / session-outcome events. `FK session.id` NOT nullable (provenance
path for "why did we decide this? / what exactly was said?": row → session → history). `scope ∈ {project, global}` is
ranking metadata only — project rows take an affinity boost in their project, global rows are neutral everywhere;
nothing is filtered from recall by scope. A KB correction is itself a deliberate row — write the truer fact, the next
build's recency precedence evicts the standing claim; `replace`/`forget` tombstone rows out of the delta retroactively.

**`guidance`** — behavioural rules: situation → statement, with the existing grading columns (confirm/disconfirm counts,
stance, grader, scope). Authored by agents at correction time in a single write — the guidance row IS the correction
record. Graded only by the agent feedback loop; sleep never touches behavioural rules. Reachable via recall and
referenced by tool bindings.

**`persona_rules`** — the floor, unchanged, plus the recall-discipline line.

**`tools`** — registration registry: `{id, kind: 'command'|'mcp', key, created_by, created_at}` where `key` is a token
array (`["git","push"]`; MCP calls as single-element arrays). Bindings — `tool_rules` — carry
`scope ∈ {project, global}` with **membership semantics**: a binding fires only when its scope covers the firing
session's project (resolved via the session registry), so a project-scoped gate never fires in other repos, and a global
binding is the deliberate enrollment widening. Enrollment defaults to the session's project (conservative — a
repo-specific gate never leaks fleet-wide by accident); inline notes carry scope directly on the binding.
**Cross-project curation**: agents discover bindings from other projects through the key lookup (`tool_rule_lookup` —
every rule enrolled on a key, each labeled visible or hidden for the calling project), then promote a binding to global
(`tool_rule_promote` — the global twin is written and the source row forgotten, so the original enrollment's replay
cannot resurrect it) or copy it into their current project (`tool_rule_copy`, referencing the same key and guidance row)
— content stays single-source. Bindings never ride the recall surface: recall returns memory content only, and the
lookup is the one discovery path. Promoted bindings fall under the normal grading loop once bindings reference guidance
rows, and the holds flag remains the master cutoff. This scope deliberately means something different from content-row
scope: bindings filter (exact-match firing has no ranking to modulate), guidance/agent_memory scope ranks only.

**`tool_rules`** — bindings: `tool_id` → nullable `guidance_id` or inline note.

### Tool matching

Token-array lookup. The event string is tokenized at match time (shlex-class, tolerant — never raise on malformed
quoting; best-effort whitespace fallback), and a key fires on **contiguous token-subsequence presence**: wrappers,
assignments, chain operators, and redirects sit harmlessly around matched tokens; quoted prose is one token and never
matches; `regit` never matches `git`; `git status` never matches `["git","push"]`. Breadth is the enrolling agent's
deliberate choice — binding `git` vs `git push` are separate decisions, and a key fires anywhere in the chain
(`x && git push` fires both). No position parsing, no wrapper heuristics. One matcher definition, both clients; each
client's MCP name decorations map to canonical registry keys via a per-client alias table derived from its actual
surface during implementation.

### Operations

- **remember** — new row, state-only content.
- **replace** — remember(new) + forget(old); the daemon links invisibly (`superseded_by` on the tombstone record).
- **forget** — tombstone + retain the body + hard exclusion from every surfacing path via one shared low-level filter
  (recall, KB build, consolidation inputs, telemetry).
- **tool_rule_add** — `tool_rules` authoring (a changed note is a new rule).
- **tool_rule_lookup / promote / copy** — cross-project curation (PRJ-168).
- **grade** — the existing agent feedback loop, unchanged; tool deliveries count as fires.

### Compliance ladder instrumentation

Every escalation event is journaled: level (quiet → firm → louder), session, trigger, outcome (recall within K turns;
time-to-recall). Aggregates — max level reached per window, conversion-per-level versus the no-nudge base rate — drive
two designated outcomes at the operator's review: dead tiers are removed by a code change; frequent top-tier hits
redirect investigation to KB quality and instruction wording. Tier removal is never a runtime switch.

## Framing requirements for automatic injections

Provenance stamp (what / when / veracity tier); explicit advisory framing ("judge relevance, ignore what doesn't apply;
this never assigns tasks"); the correction-protocol pointer; attribution required when KB material is used in replies.

## Success criteria

- Per session with published enrollments and holds ON: one session-start KB block; the first execution of each bound
  tool rejected with its rule as the error; second and later executions informational; holds OFF degrades every hold to
  informational.
- Zero injected content on message arrival, on every client.
- Agent-initiated recalls occur in normal work (counters > 0 across sessions, both clients); the compliance ladder stays
  quiet in the common case.
- Behavioural corrections produce a guidance row the same turn; no sleep process ever writes or alters one.
- A fact correction reaches the next KB build and the fleet (tombstone + edge state converges); "why did we decide
  this?" resolves through provenance end to end.

## Non-goals

- Any aging/TTL policy on memories or rules (usage telemetry only; a policy is a future, separately-decided change).
- A global knowledge base (global-scoped rows are recall-only, single-source).
- Topic-shift detection or pointer nudges (parked fallback; counters decide).
- The session-start LLM bridge call (parked; flip-informing metrics recorded — early-recall rate, KB first-use latency,
  shadow-bridge overlap on sampled opens — activation is a later code change on data review).
- Session-persistent synthetic reminders (static instruction files fill this role).
- Redesign of cross-machine sync topology beyond the schema split it already supports.
