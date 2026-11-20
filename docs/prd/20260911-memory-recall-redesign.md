# PRD 20260911: Memory and recall redesign

- **Status**: Draft
- **Companion ADRs**: `docs/adr/20260911-non-speech-input-classification.md` (input classification),
  `docs/adr/20260911-remove-aaak-fallback.md` (consolidation fallback), `docs/adr/20260911-no-aging-curated-rules.md`
  (adjacent, curated side)
- **Audience**: the agents that will implement and run it
- **Provenance**:
  - Authored: agent
  - Edited: (none)
  - Approved: none

## Problem

Automatic recall quality is the binding constraint on the memory system. In a session that was maximally
memory-relevant, roughly a quarter of injected recalls earned their slot; the rest were self-echo, in-flight fragments,
keyword noise, and repetition. The store works; the **per-turn editorial policy of what deserves attention** is what is
missing. This PRD specifies the recall experience first and the store changes that serve it second.

## Recall channels

Two channels with opposite economics, made explicit in the design:

- **Automatic nudge** (plugin injects a recall block per turn) — expensive channel. Costs attention on every fire,
  biases via its framing, cannot be corrected by the agent when it fires wrong. Wants a high precision bar.
- **Explicit recall** (agent calls the tool with a chosen query) — cheap, reliable, already institutionalized where it
  matters. A miss costs a second query, not a polluted turn. Wants recall-bias.

Every rule below is stated for the channel it applies to.

## Automatic nudge requirements

1. **Judgment-provenance pool only.** Nudge candidates are content with provenance of judgment: deliberate writes
   (corrections, preferences, facts) and consolidated episodic summaries. Raw captured turns are never nudge candidates
   — the class that produced self-echo, in-flight fragments, and the fork-summary keyword shotgun dies here, and the
   `<chat-history-summary>` session-chaining leak dies with it without needing the session-identity filter to guess what
   is in the agent's context.
2. **Honest framing.** The nudge header states speaker, veracity, and date. "Treat these as established" is replaced
   with what each row actually is: user-stated vs agent-inferred vs machine-summarized. Agent-authored content is
   hypothesis until confirmed.
3. **Semantic debounce.** Suppression is by content overlap against already-injected memories, not by row id —
   near-duplicate rows (deliberate store, captured echo, fork copy) must not re-fire. Explicit recalls count as "brought
   up."
4. **Compaction reset.** Suppression holds while the prior injection is in context; a compaction boundary re-opens
   eligibility. The plugin already tracks compaction boundaries; turn-count is a proxy, "in context" is the honest
   condition.
5. **Length penalty.** Large rows sink in the composite nudge score via a soft multiplicative factor on lexical
   relevance (calibrated ~2–5k chars start, floor ~0.2; env-tunable per the package's weight pattern). Rationale:
   `_lexical_relevance` credits full-query-substring matches at 1.0 and enters the working-memory score twice (linear +
   squared), so big documents dominate matches; a fork summary contains nearly every sentence of a session. The penalty
   is lifted on explicit recall (fire-vs-read split).
6. **Context-containment check.** Injection candidates are checked against the session's accumulated text; exact
   substring for forks (the pasted summary contains recalled rows verbatim), embedding overlap for paraphrase. Suppress
   what is already in context. This generalizes the self-echo filter from session identity to actual content, handling
   forks and manual pastes without knowing about the forking tool.

## Explicit recall requirements

1. Everything remains reachable — all kinds, all tiers, labeled with `resolved_source`-style provenance so the agent
   knows transcript from rule from summary (already implemented in both daemons).
2. Raw turns group by conversation so one long conversation does not flood results.
3. The length penalty does not apply.

## Store changes serving recall

### Input classification (per the ADR)

Capture assigns `kind: speech | exhibit | fork_summary` mechanically. Exhibits consolidate as exhibits ("the boot log
showed..."), never as speaker speech. Fork summaries are excluded from consolidation inputs (no summary-of-summary
compounding).

### Consolidation judgment rule

The sleep prompt gains an exhibit-attribution rule at content level (chunk-safe). Once capture labels exist, the
summarizer trusts them and overrides only on clear contradiction.

### No AAAK fallback

Per `docs/adr/20260911-remove-aaak-fallback.md`: when the LLM chain exhausts (remote down, local down), sleep writes no
summary and **releases the claim** — rows remain working memory and retry next pass.

### Provenance (standing gaps, already diagnosed)

- **Worktree fragmentation**: 51 of 59 conversations on the example deployment are captured under random worktree
  basenames; scoped recall boosts per-worktree, not per-repo. Fix: repo resolved at binding time via the `detectRepo`
  chain (git remote → git-common-dir → basename; worktree-safe). Historical fragmentation is accepted residue (same
  class as the work deployment's `cursor:<role>` hole) unless an LLM-assisted backfill is separately judged worth it.
- **Deliberate-write repo channel**: the remember path has no field to receive workspace; scoping via `source`-string
  abuse is penalized by the exact-match deliberate boost. Fix: binding-time default from the client layer, same
  principle as capture.
- **Label discipline**: the example deployment has 1 `rule`-source row in months vs the work deployment's populated
  situational tier. The boosts exist; the instruction culture does not. Fix is an opencode-side instruction contract,
  not code.

## Non-goals

- No aging, TTL changes, or recall-score redesign beyond the length penalty.
- No change to consolidation grouping (coarse one-summary-per-conversation stands).
- No cross-environment memory sync.
- No new services: all changes land in the existing daemon/hub/plugin surfaces.

## Success signals

- Nudge precision: the failure classes (self-echo, fragments, fork shotgun, repeats) reach zero in normal sessions;
  fires per session drop without losing load-bearing recalls (prior-session investigation continuity, corrections at the
  moment of danger).
- An out-of-LLM window produces zero fabricated summaries and a visible paused alarm.
- Explicit recall still finds everything, labeled.

## Open items

- Penalty curve and threshold constants (env-tunable, calibrate against the live store).
- Whether the context-containment check runs client-side (plugin) or daemon-side.
- Semantic-debounce similarity threshold.
- Title-gen leakage in the voice/capture tool: source fix vs capture-side template recognition.
- Historical fork-row backfill by marker (trivial); unfenced historical pastes accepted.
