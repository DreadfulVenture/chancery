# ADR 20261124: Session origin as a create-time metadata signal — declared is programmatic, absent is human

- **Status**: Draft
- **Provenance**:
  - Authored: agent (design decided with the operator across the 2026-11-24 review-bot re-think)
  - Edited: the operator (supplied the `chancery_origin` key name and §4's downgrade-bias rationale, 2026-11-24)
  - Approved: none

## Problem

Opencode carries no concept of who started a session. `Session.Info` records no user, origin, or initiator field
(verified: the upstream session schema, `packages/schema/src/session.ts` on `dev@fd9137ef`, and the product API
reference); its create surface admits only title, parentID, agent, model, location, metadata, and permissions. A prompt
is a user-role message whatever produced it — TUI keystroke, SDK `session.prompt`, plugin synthetic, or a dispatched
brief — and nothing downstream can distinguish the sources. The facts adjacent to the need are all inert for it:
`parentID` records lineage history, the `agent` field records the persona role, client pairing is a connection fact
stamped on nothing, and the persona axis answers "what runs as," never "what started it."

Consumers that need the human-vs-programmatic distinction — chiefly the memory store's lineage registration
(`docs/prd/20261114-lineage-gated-writes.md`) and any bot behavior keyed on operator speech — resolve the question today
from scattered per-path mechanisms: subagent children ride the host's `parentID` event, driven `opencode run` processes
read an env var the outer side sets, the webhook bot declares a deployment-level initiator, and the director's dispatch
stamps session metadata. The failure this ADR replaces is empirical: dispatched workers covered by none of those
mechanisms registered in the store as top-level human conversations — agent prose stamped human voice, agent finds
eligible to compose the standing knowledge doc unreviewed.

## Decision

One origin signal, on the opencode-native surface, per the operator's ruling of 2026-11-24:

1. **Every programmatic spawn in the operator's tooling declares its origin at create time.** A session created by the
   director's dispatch, the zenigata runtime, or any wrapper carries metadata under the key `chancery_origin`:
   `{ initiator: "human" | "program", parent: <creating session id> }`. The value vocabulary deliberately avoids the
   word "agent": opencode's `agent` field and surrounding vocabulary mean the persona role (build/plan/explore), and
   reusing the word corrupted the design discussion once already. The store's rows keep their own vocabulary; the client
   translates at its one mapping point.
2. **Absence of the record reads as human** — the operator at the TUI. This is explicitly a loose assumption,
   correctable in place (the client API's `PATCH /api/session/{id}` admits metadata, so plugins may stamp human sessions
   later) without redesign. The consumer reads the `chancery_origin` key specifically, so an unrelated metadata stamp
   from some other tool never impersonates human.
3. **Host-provenance carve-out:** a session with a `parentID` is programmatic regardless of a missing record.
   Host-internal subagent spawns inherit the parent's current metadata bag (`session-metadata.ts`: "children and forks
   inherit the parent's current metadata unless the creator supplies its own"), so the naive absence rule would
   misclassify them; `parentID` is the host's own record and settles it. Resolution rule in full: declared →
   programmatic; parented → programmatic; root and undeclared → human.
4. **The signal says nothing about who drives the input.** The operator joining a programmatic session mid-flight still
   reads as program context. Known gap, documented and accepted — and the bias between the two failure directions is
   deliberate, per the operator: an accidental _downgrade_ (operator prose recorded as program voice) is recoverable,
   because the operator knows what they said and corrects it on discovery ("no — I said that"); the reverse error,
   program prose recorded as operator speech, is silently durable — it wears trust forward, and nothing in the machinery
   ever re-checks it. The system therefore fails toward downgrade wherever it must fail.
5. **One consumer maps the signal into the memory registry** — the opencode memory client, which today registers each
   capture's conversation; stamped → agent row with the declared parent (the dispatch-path instance is already built and
   merged as PR #170, PRJ-510); parented → the same; undeclared root → human, as today. The store changes nothing — its
   writes, gates, consolidation, and framing are untouched (standing constraint). Director-worker interaction downlevels
   to agent veracity unconditionally, operator presence notwithstanding.
6. **Declaration is never recovered post-hoc.** A plugin reacting to a bare `session.created` cannot distinguish the
   operator's TUI session from a bare script's `session.create` — both arrive unannotated. Plugins may enforce (warn or
   refuse on undeclared spawns) and witness (stamp `PATCH`ed attestations), but the truth comes only from the creator's
   own create call.
7. **The review bot's instance of the pattern:** no access list, no identity arrays consumed by bot code, no per-item
   marking pipeline — the operator dropped button-gating outright ("I don't care who presses the buttons"). The
   deployment hands the review session an account list _inside its instructions_: accounts on the list are operator
   speech for veracity and corrections; every other account's items are claims to trace against the code. The reviewer
   resolves that list against the author names the forge already carries per thread item; the list itself is a config
   value flowing into the start prompt, not a code surface.

## Alternatives considered

1. **An upstream first-class origin field on `Session.Info`.** Rejected for now: the metadata bag delivers on the
   product's native surfaces (create admits it; `session.get`/`export` read it back; it is durable across restarts) with
   zero upstream dependency. If upstream ships a real field, the one consumer remaps to it and nothing downstream
   changes.
2. **Per-path mechanisms (the status quo).** Rejected: the source of the misclassification this ADR replaces, and each
   new spawn path would invent another stitch.
3. **Plugin post-hoc stamping as the truth source.** Rejected: indistinguishable bare creates (as above), and the record
   is mutable post-create by any same-user process regardless — enforcement and witness only.
4. **The identity machinery previously designed (humans/agents arrays, an access list, per-item marking).** Rejected in
   this re-think: authority rides verified content and authenticated actions; the forge attributes accounts per thread
   item; the store attributes lineage by session; the arrays-and-buttons machinery had one remaining job — letting the
   reviewer weight operator thread prose — and an injected instruction over a plain account list does that job at a
   fraction of the surface.
5. **Store-side vocabulary extension.** Rejected: zero store changes is a standing constraint, and the store's stored
   vocabulary ("agent") is populated and load-bearing across its four consumers.

## Known gaps and boundaries

- Unmarked `opencode run` scripts (CI, cron) read as human — an uplevel risk, accepted in the opposite direction; the
  API/SDK path is how a script declares, and a CLI flag would be an upstream ask. Watch signal if it ever becomes a
  problem: memory content or standing-doc inputs surfacing with human framing from conversations the operator didn't
  start.
- The record is rewriteable post-create by same-user processes — the same trust boundary as `parentID` and the env var
  today; the model's tool-call channel cannot move it, and the same-user adversary is daemon authentication (`PRJ-268`)
  territory.
- The human side of the signal assumes the interactive client (TUI) remains the only human-joining path that creates
  root sessions. The provenance ADR convention applies to follow-on records.
