# ADR 20260919: Capture is 1:1 — no speculative size or count limits on the capture/sync path

- **Status**: Draft
- **Provenance**:
  - Authored: agent
  - Edited: the operator
  - Approved: none

## Context

Three live failures in one day (2026-09-19), each the same shape: a limit that exists on one endpoint but not its peer,
written in different commits, with no shared contract test.

1. **Vocabulary** — the client emitted agent-facing feedback signals; the hub validated the canonical set. Every
   feedback record was rejected for days (fixed in the signal-vocabulary and self-echo fixes).
2. **Delta** — the emitter shipped the raw delta param; receiving machines weighted soft gradings at full strength
   (fixed alongside).
3. **Size** — the drain dropped any turn over 512KB at ingest; the hub rejected payloads over 64KB, request bodies over
   4MB, and batches over 100 records. The size class froze a client host's sync for ~3.5 hours: two 81KB capture records
   were rejected at the hub, the 213-record queue blocked behind them, and the pull cursor stalled at 13:21 — diagnosed
   during post-merge verification of the self-echo fix.

Sizing review of the size class found no threat model behind the numbers:

- Every sender holds the API key; `do_POST` authenticates **before** reading a single body byte, so an unauthenticated
  flood costs header parses only (with Traefik in front). The caps defended against nothing adversarial.
- The realistic "attacker" is our own malfunctioning client — the failure class that actually occurred this week was
  client-side (the 8.6GB embed wedge), not hostile traffic.
- The 4MB body cap sat **below** the legitimate worst case the client itself could produce (a batch of fat captures),
  making it an operating limit waiting to freeze sync one layer up, not a tripwire.
- The hub's hidden 100k-character content caps and 256-char id caps were of the same class: policy invented mid-wire,
  unreconciled with the producer, untested.

The operator's ruling on the plan review: "Our capture should be reliable and 1:1 — if we get something to capture, we
capture it. We store it, we push it around. If that becomes a problem at some point we'll look at it. You did some
bullshit defensive engineering and got bit. Undo it."

## Decision

1. **Capture is 1:1.** Whatever OpenCode provides as a turn is captured, stored, and relayed verbatim — drain → local
   store → hub record log → pull → apply, byte-for-byte. No drop, no truncation, no quarantine.
2. **No size or count limits exist on the capture/sync path.** The 512KB drain drop, the hub's 64KB payload cap, 4MB
   body cap, 100-record batch cap, and the hidden content/id length caps are all removed. The ingest edge is bounded
   only by whatever OpenCode actually gives us.
3. **The hub validates identity and contract, never volume**: bearer auth, exact wire shape, kind/table vocabularies,
   and field presence. Validation failures are loud (per-record rejection list, push raises, queue restores) — a real
   contract bug should freeze a record, never be silently absorbed, and never be manufactured by an invented limit.
4. **Problems are fixed when they exist, with evidence.** If capture volume ever becomes a real problem, the fix is
   designed against measured data then — not pre-engineered as speculative plumbing that itself becomes the failure
   mode.

This generalizes the input-classification ADR's principle from classification to transport: size flags for
classification but never decides — and now, size is never a policy at all in the middle of the wire.

## Alternatives considered

1. **Drop oversized turns at the drain** (status quo pre-fix): silent 1:1 violation at ingest; content irrecoverably
   lost.
2. **Truncate to a size bound**: capture no longer matches the conversation; divergence baked into the durable record.
3. **Tripwire caps sized above legitimate traffic** (e.g. body cap at 64MB): still a mid-wire freeze point still sized
   by speculation; rejected with the rest.
4. **Rejection quarantine** (divert rejected records to a side file): machinery to survive a rejection class that should
   not exist; with the limits gone, rejections mean real contract bugs, which must be loud, not shelved.

## Consequences

- The two stranded 81KB records drain normally on deploy; no data repair needed.
- Very large turns flow through consolidation and embedding, which already bound their own work (chunked summarization,
  fastembed truncation) — the pipeline handles size where it processes it, not by refusing it at the door.
- The 1:1 contract is pinned by a producer-derived end-to-end test (a turn just over 4MiB through drain → real hub
  handler → pull, byte-for-byte); any reintroduced mid-wire limit turns this test red.
- The bounded-resource risk this accepts is bounded by the sender population: machines we own, on a LAN, behind auth.
  Revisit only on evidence.
