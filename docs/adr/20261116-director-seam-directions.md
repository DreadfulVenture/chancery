# ADR 20261116: Director module directions — down stays prompt, up is pull, peer is deferred pull chat

- **Status**: Draft
- **Provenance**:
  - Authored: agent (GLM 5.3 Flash via OpenCode), 2026-11-17, from the 2026-11-16 design discussion
  - Edited: (none)
  - Approved: none — the UP slice was approved for execution by the operator, 2026-11-17; the peer direction stays
    plan-only

## Context

The director module (`plugin/director.ts`, PRJ-317) lets director sessions dispatch and steer worker sessions in-process
over the host session API. Three directions of traffic meet there: down (coordinator to worker), up (worker result back
to coordinator), and peer (coordinator to coordinator). The up direction shipped as push: each turn end was mailed to
the director's session as a synthetic message, full text inside a `<system-reminder>` envelope.

Two facts made push the wrong shape for up:

**The provider makes wrapped user turns carry no worker-visible user text.** The live host's provider,
cursor-opencode-provider 0.8.7 (`dist/language-model.js`), classifies a user message whose parts are all
`<system-reminder>` blocks as a host note that contributes nothing to the user turn: `hostTailNote` returns `{}` for it
(`:7030`), and `liveUserTurn` — which collects only messages where `!hostTailNote(message)` — falls back to `"."` when
none survive (`:7553-7561`). Every push mail therefore reached the model as the literal text `"."`. A
`<system-update>`-wrapped wake is not lost, but it does not ride as the user turn either: the same wake delivers it
through the turn-boundary collection (`prepareUserTurnHostNotes`, `:~4005-4009`) as a one-shot reminder (`:1901`) that
`admitContextEpoch` combines into a mid-conversation message (`dist/context/epoch.js:136` and `:168-177`), rewrapped as
a `<system_reminder>` system note — system authority, which plugin-authored content must never carry. Wrapped forms thus
either do not ride as the user turn or deliver as system-authority notes; the plain-text notice needs neither path: it
is the live user turn itself, and its fixed words are the plugin's, never worker prose.

**Push made the compaction bound fight itself.** Compaction keeps a synthetic message verbatim in a director's
checkpoint (opencode `compaction.ts`, `messageToText`) and cannot cut the recent block at one, while an old tool result
is cut to 1,250 characters. Full-text push mail put the unbounded-content class — worker prose — into the synthetic
class, so a director's checkpoint grew with every worker turn and compaction could not help.

The standing ruling that worker content reaches a model only as a tool result, plus these two facts, decide the
direction. The operator approved the report-pull slice (up only) for execution on 2026-11-17; the live host runs
OpenCode v2.3.0.

## Decision

**Down stays `session.prompt`.** Dispatch and steering keep their transport: in-process enqueues on the host session
API, no subprocess, no stdout stream. The single-delivery work (PRJ-346) stands as shipped: one deliverer per worker
turn, delivery claims keyed on worker session plus terminal event id, subagent children excluded.

**Up is pull.** A worker turn end files one stored report and sends one fixed wake notice.

- The report row lives in `ctx.storage` — the plugin-scoped view of the host's kv table (SQLite:
  `packages/core/src/kv/sql.ts`; surface: `packages/core/src/plugin/host.ts:498` and `:663-690`; promise-adapted at
  `packages/plugin/src/promise/adapter.ts:508-512`) — so a plugin reload or a host restart loses nothing. Rows are keyed
  `report/<director>/<worker>/<terminal event id>`: a scan of one director's prefix is exactly that director's mail, the
  key carries the dedupe identity, and unread flags ride the row. Read rows are pruned after a week on the next store
  for the same director; unread rows carry no expiry — pending mail is never aged out — but a director's rows are capped
  at one hundred, oldest evicted first, so a director that never pulls cannot grow the store without bound. When a scan
  hits its page cap (10,000 rows), `report_read` says so in its output (`truncated: true`) rather than only in the log,
  because the truncated walk undercounts.
- The wake notice is a synthetic whose text is fixed apart from the worker session id and the cumulative unread count —
  never any text the worker wrote. It rides as plain text: the host passes a synthetic's text through as the user turn's
  content verbatim (`packages/core/src/session/runner/to-llm-message.ts:274-275`), plain text is a real user turn to the
  provider, and the description and metadata stay out of the prompt — that pair (description plus `metadata.source`) is
  what renders the notice as a "◈ Notice" row naming the module, the same shape the host's own shell-error synthetics
  use (`packages/core/src/session/session.ts:202-206`).
- The director calls `report_read` for the bodies. It returns only the reports addressed to the calling session, oldest
  first, under numeric budgets (`limit` 1–20, `maxChars` 200–100000, defaults 5 and 4000), marks what it returned read,
  and states the count still unread. Bodies keep the cap rules: a long text is cut to its head with the last STATUS line
  and any BLOCKED paragraph kept verbatim, and the cut count is stated in UTF-16 code units. Worker text enters the
  model here and only here — as a tool result, which compaction may cut to 1,250 characters later. That is the
  compaction size bound working for the director instead of against it: the fixed notice is the only module content in
  the synthetic class, and its size is bounded per terminal event regardless of what the worker wrote.
- Failure, interrupt, and shutdown reports file through the same pull path with their own kinds. A shutdown interrupt
  (any interrupt with no recorded reason) files an interrupted report — not a failure verdict — that says the host may
  resume the turn, that a worker staying busy across a restart may never report, and that `director_worker_status`
  should be checked before re-dispatching.
- One stored report and at most one wake notice per terminal event across overlapping activations, by the delivery
  claim. A failed notice send keeps its claim: the row is stored, and the claim is what keeps a sibling activation from
  overwriting the stored row with its own buffer's text, so the stored report keeps the first claimant's full text. The
  stranded report rides the next terminal event's coalesced unread count. A failed store releases the claim and wakes
  nobody — a notice without a pullable report would lie — logging the `opencode session export` pointer as the recovery
  path. A `report_read` that cannot mark a returned report read still delivers its body and leaves the row unread, so no
  row becomes unreadable without having been delivered; it is returned again by the next call.
- `director_worker_status` gains unread counts (from the queried worker, and in total for the caller), so a director can
  discover stranded reports without a wake. `mailEnvelope` stays exported with byte-identical output for the
  forgejo-watcher package, which copies the file verbatim; the module's own wake no longer rides it.

**Peer is pull chat, untrusted, deferred.** Coordinator-to-coordinator chat (the thatch `src/chat.ts` shape) stays
plan-only until a separate ruling. It is untrusted traffic: peer messages are content another agent wrote, so they
arrive only through a reader tool as tool results, never injected as waking prompt text, and the peer notice stays as
fixed as the up-direction wake. The peer design must still settle, before any build: chat size limits; the leftover
director-output growth posture (accepted, with manual recovery — session export, fresh session — as the recovery path);
whether one `chat_read` serves both mail and chat or chat gets its own reader; automatic fallback reports when a lane's
reports go unread; and a peer loop guard with a 30 messages-per-pair-per-hour ceiling.

**The `director_steer` restriction is deferred.** Restricting steering to a director's own stamped workers (a director
reads the stamp before steering) is the shape to adopt if steering abuse is observed. The trigger is observed abuse, not
foresight: a cross-director steering incident, or a pattern of sessions steering workers they did not dispatch. Until
then the tool keeps its current posture — a stamped session steers fine from anywhere; its mail flows to the director
its stamp names.

## Consequences

- A director's checkpoint no longer grows with worker prose: the synthetic class carries only fixed notices, and bodies
  enter as cuttable tool results.
- A wake can no longer be silently swallowed by the provider: plain text is the live user turn.
- Reports survive reloads and restarts where the push mail's claim ledger did not even try to hold bodies.
- A report a director never pulls sits unread and counted, not lost — up to the hundred-row cap, past which the oldest
  rows go; the export pointer is the fallback of last resort, and `director_worker_status` surfaces the count.
- The unread count in each wake coalesces burst traffic; the fixed notice bounds each terminal event's cost to about two
  hundred characters.
- The kv namespace is per plugin id, not per location, so every activation of the module shares one report namespace —
  the activation at the worker's location files the row, and the director's own activation pulls it. No cross-host
  delivery is attempted, matching the module's single-host posture.
