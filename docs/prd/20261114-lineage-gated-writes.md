# PRD 20261114: Lineage-gated memory writes; the daemon decides attribution

- **Status**: Draft
- **Audience**: the agents that will implement it; the operator
- **Provenance**:
  - Authored: agent (design decided with the operator across the 2026-11-14 session: webhook review bot first,
    nested-agent sessions the general shape)
  - Edited: none
  - Approved: none

## Problem

New clients break the store's implicit trust model. A review bot (OpenCode on a PR webhook) and nested-agent sessions
(OpenCode agents driving OpenCode agents) both mean conversations where either no human is present at all, or the human
sits at the root of a chain while other agents do the work. Today the store:

1. Accepts writes from any client — nothing distinguishes "may read" from "may write".
2. Lets the model declare `author_id`/`author_type` on `memory_remember` — a write can claim human voice. Recall frames
   every row with its speaker, so the framing is the trust signal, and it is forgeable.
3. Consolidates every captured conversation regardless of client — machine distillations of machine conversations
   (webhook text no human wrote, stamped `author_type: "human"` by the drain) enter episodic memory.
4. Feeds the standing KB doc from `agent_memory` unfiltered — a poisoned fact is composed into the doc injected at every
   future session start.

The attack vector is not hypothetical: the bot reads untrusted PR text, so prompt injection is the normal case, and
memory is the persistence that outlives the session.

## Requirements

1. **Reading is open.** Recall, session search, `knowledge_read`, the session-start block, the floor, rule and persona
   delivery — open to every client. One carve-out, decided in the Design section: a caller with no human in its line
   gets provenance pointers (session ids) redacted from read results, so it cannot learn a parent id to claim.
2. **Writing is gated by lineage.** A conversation may write only if its line traces back to a human-started session.
   Lineage is the trust key — not which binary connected, not which deployment — because one deployment hosts both
   trusted and untrusted conversations.
3. **The daemon decides attribution.** Model-declared authorship is discarded on every write, the same way `app` and
   `conversation_id` already are (the connection decides, never the payload). Attribution is a function of where the
   conversation sits, stamped by the daemon.
4. **Unattended learning is cut off at the root.** Conversations with no human in their line are still recorded for
   lookup, but are never consolidated into episodic memory and never feed the KB.
5. **Unanchored agents keep observational value.** A review bot that finds documentation or observes behavior stores
   stamped observations that recall surfaces — they just never become standing background truth without a human voice
   adopting them.
6. **Enforcement lives in the daemon.** Client-side permission config is advisory; the daemon's refusal is the
   guarantee. The boundary this buys: the model's own tool-call channel (its arguments) cannot move the decision. A
   same-user process that forges registrations or calls the daemon directly is a stronger adversary — closing that is
   daemon authentication, filed separately (PRJ-268).

## Design

### Session registration and lineage

- The client declares the **initiator** on the connection: the plugin and the hook put it in the MCP URL beside `app`,
  the deployment owns that URL, and the daemon strips any `initiator` that arrives in a tool call's arguments — a
  model-supplied lineage is a forged pointer, the same way a model-supplied `app` is. Per session, the registration line
  and the `/session-open` body carry the same declaration; the drain resolves turn-registered sessions from the capture
  payload.
- The registry stores the initiator on the session row. **Anchored to a human** = walking `parent_conversation_id` links
  reaches a human-initiated root. The pointer plumbing already exists (capture registration carries
  `parent_conversation_id`), and a link that arrives after the row was created backfills.
- Fail closed: rows that predate the column are backfilled `human` once (every client then was human-driven); every row
  created afterwards with no stated initiator resolves `agent`. A parent id with no row is a placeholder that resolves
  `agent` until a real registration names it, so a forged `MEMORY_PARENT_CONVERSATION_ID` buys nothing.
- Driven `opencode run` processes hand the parent pointer over through the environment, read by the inner plugin once at
  session open. Residual forgery: a same-user process can set that variable, forge a registration line, or call the
  daemon directly — that is the daemon-authentication boundary (PRJ-268), not something the gate argues with.

### Permission classes

| Lineage                                          | Writes                                           | Attribution           |
| ------------------------------------------------ | ------------------------------------------------ | --------------------- |
| Depth 0 — the session the human types in         | Full write surface                               | Human voice, as today |
| Depth ≥ 1 — driven, under a human root           | Full write surface                               | Agent chain           |
| No human at the root (webhook bot, bare scripts) | `memory_remember` only, observation-class labels | Agent chain           |

Refused for every non-human-anchored conversation: `memory_update`, `memory_forget`, `memory_mark_checked`,
`persona_codify`, `persona_update`, `persona_reinforce`, `rule_codify`, `rule_forget`, `rule_feedback`, `tool_rule_add`,
`tool_rule_remove` — everything that steers future behavior, mutates human rows by id, or skews the graded rules. A
write with no conversation at all (bare scripts) is unanchored and refused, except for the observation grant above.

The refusal is a `ToolError` at the daemon's tool-call gate (where the calling client is already resolved) stating the
policy, so the calling agent learns why instead of guessing.

### Attribution rules

- The daemon strips `author_id`/`author_type` from write arguments on all clients and stamps them itself.
- Depth-0 conversations: captured user-role turns are `human`; deliberate writes attribute as they do today.
- Depth ≥ 1: captured user-role turns are the driving agent talking — `author_type: "agent"`. Deliberate writes are
  agent-attributed regardless of content.
- Unanchored: captures and observations are agent-attributed.
- Within a depth-0 conversation nothing changes; the drain's existing human/assistant stamping stays.

### Unattended learning

- Consolidation's group query excludes unanchored conversations (rows resolve their conversation's class through the
  session registry). Their turns stay in session search.
- The KB delta scan excludes agent-attributed `agent_memory` rows — driven sessions' rows included. That is a real
  behavior change for pre-lineage subagent usage: knowledge a driven agent found stops reaching the standing doc until a
  human-anchored session adopts it (quotes the finding and writes its own row). Adoption is the existing correction
  flow; the cost is deliberate, so agent-chain work cannot compose the doc unreviewed.

### The trust boundary, stated

The gate closes the model's tool-call channel: nothing in a tool call's arguments moves the lineage decision, the
attribution, or the refusal. It does not close same-user processes — the capture queue is a file, the daemon takes
unauthenticated HTTP on loopback, and the token to change either is a fork away. Closing that is daemon authentication
(PRJ-268); until it lands, the gate's guarantee is "a model that stays inside its tools is gated".

### What stays

The `app` label on connections stays exactly as it is — it is provenance only, and the policy no longer needs it.

## Alternatives considered

1. **Per-app policy (key writes off the connection's client name).** Rejected: wrong key. The plugin stamps every
   OpenCode session `app=opencode`, and one deployment hosts both trusted and untrusted conversations. Identity of the
   binary does not answer "was a human driving".
2. **Refuse all unanchored writes.** Superseded: simplest line, but it discards a review bot's genuine findings —
   documentation locations, observed behavior. Observations-with-stamp keep the value at no added risk.
3. **Quarantine tier for unanchored writes (pending, human promotes).** Rejected: new state, a review surface, and a
   promotion path with no demand beyond what observation-stamping already covers.
4. **Client-side enforcement (OpenCode permission rules in the bot's config).** Rejected as the guarantee: client config
   is advisory and sits inside the compromised process's own deployment. The daemon is the single gatekeeper.

## Out of scope

Bot deployment and webhook wiring; the skills the bot carries. The `app` knob from earlier discussion is dropped — the
policy keys on lineage, not client names.
