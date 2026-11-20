# ADR 20260911: Non-speech content in user-channel turns is classified at capture, never attributed as speech

- **Status**: Draft
- **Provenance**:
  - Authored: agent
  - Edited: (none)
  - Approved: none

## Context

The capture hook labels every user-channel turn as the operator's speech, under a personal speaker label and author id.
The live store shows three verified classes of user-channel content that are not speech:

- **Conversation-fork summaries** — the voice/capture tool's `<chat-history-summary>` wrappers, pasted as the first user
  turn of each forked session. 14 rows in one worktree's captures, 22k–46k chars each, containing _both_ speakers' prior
  turns inside a row attributed to the operator.
- **Pasted artifacts** — logs, command output, file contents. Usually fenced (16 of 19 large pastes in the sampled
  worktree), sometimes not (2 boot logs, 1 review attachment, unfenced).
- **Tool-inserted prompts** — 21 voice/capture-tool title-generation template rows captured under the same personal
  speaker label; the template speaks in nobody's voice.

Verified consequences, all observed in the live store or package source:

- Consolidation attributes artifact text to speakers — a boot log becomes "the operator said
  `[ OK ] Listening on Journal Sockets`".
- The lexical scorer credits a full-query-substring match at 1.0 (`_lexical_relevance` in `beam.py`), so a 40k document
  containing most of a session's sentences outscores every short genuine turn — a keyword shotgun.
- Fork summaries feed summary-of-summary compounding into episodic memory.
- Recall echoes the session back into itself. The work deployment hit this symptom class and fixed one instance
  (`7a7c960`, stop recall quoting the conversation back at itself).

## Decision

1. Every captured turn carries a `kind`: `speech` | `exhibit` | `fork_summary`. The set is extensible as new non-speech
   shapes are recognized.
2. Kind is resolved **mechanically at capture**, where the bytes arrive: the stable fork marker literal →
   `fork_summary`; a CommonMark run-length fence scanner (not naive backtick counting — it must handle nested fences)
   with a per-block size floor → `exhibit`; everything else → `speech`. Size thresholds trigger classification effort;
   they never classify by themselves (pasted logs are legitimate large turns).
3. **Speech is the default for unclassifiable residue.** The rationale is structural, not statistical:
   artifact-as-speech corrupts one consolidation summary (recoverable); speech-as-exhibit loses the human's words from
   the durable record (irrecoverable). The asymmetry holds at any paste frequency. Deliberately not justified by current
   corpus frequency — the sample is one user, one fortnight, one environment, and frequency-based policy was explicitly
   rejected as overfitting.
4. **Consolidation is the corrector.** The sleep prompt gains a rule attributing pasted material as an exhibit, phrased
   at content level so chunking that splits a document from its header does not defeat it. Once capture labels exist,
   the summarizer trusts the label and overrides only where the text clearly contradicts it.
5. Explicit recall sees all kinds, labeled honestly. The automatic nudge pool excludes raw captured turns entirely
   regardless of kind (see the memory PRD).

## Alternatives considered

1. **Status quo** — no classification. The verified consequences above.
2. **Recall-time mitigation only** (sinking large rows in ranking). Fixes nudge noise but not speaker-blending or
   summary compounding; ranking cannot fix attribution.
3. **LLM classification at capture.** Rejected: judgment at ingest where mechanical signals exist violates the
   binding-time-resolution principle (the `detectRepo` lesson); it adds cost and a failure path to the hot capture path.
4. **Size threshold as the classifier.** Refuted: legitimate large pastes exist; size flags for classification, never
   decides.

## Consequences

- The fence scanner must be CommonMark run-length aware. Content after an unmatched fence opener classifies as `exhibit`
  (errs toward paste-like, consistent with the speech default's asymmetry in the other direction).
- Historical fork rows are backfillable by marker (14 rows, trivial). Unfenced historical pastes are not mechanically
  backfillable — accepted residue; the consolidation corrector handles them going forward.
- The residue default is monitored, not assumed: capture counts unfenced-large turns per workspace; a rising count means
  the speech default needs revisiting.
- Title-generation leakage is best fixed at the source (the voice/capture tool should not route template prompts through
  the user channel); a template-literal recognizer at capture is the stopgap if a source fix is unavailable.
