# ADR 20261023: Forward-compatible sync — set aside what can't be applied

- **Status**: Draft
- **Provenance**:
  - Authored: agent
  - Edited: the operator (design directed through plan review)
  - Approved: none

## Context

Adding a record kind to the sync protocol currently forces an ordered rollout: the hub first, then every client, and
only then may any machine write the new kind. Two places in the code break otherwise.

- **The hub marks unknown kinds invalid.** `_append_records` in `hub_server.py` runs `validate_record`, which rejects
  any kind outside `RECORD_KINDS`. The hub keeps the record with an `invalid_reason`, and `SyncClient.pull` skips marked
  records and moves its cursor past them. A record written before the hub learns its kind therefore never reaches
  another machine, even after every machine is upgraded.
- **A client that cannot apply a record stops pulling.** `SyncClient.apply` raises on an unknown kind. `pull` saves its
  cursor only after a whole page applies, and the daemon's sync loop logs the failure and retries, so the client fails
  the same page on every cycle and receives nothing behind it until its code changes. A known kind whose apply raises
  does the same: a `rule` record passes the hub's check on `target`, then `upsert_situational` raises on a grader it
  does not recognize.

The entity directory (PRD 20261023-entity-directory) adds a record kind and so needs one ordered rollout regardless. The
operator's direction: make that deploy the one that removes the ordering for every later kind, rather than shipping this
change on its own first.

## Decision

1. **The hub validates the envelope of every record and the payload only for kinds it knows.** The envelope is the
   record id, kind, machine id, an ISO 8601 timestamp, and a payload object. A record of an unknown kind with a valid
   envelope is logged and served unmarked. The hub is a relay and interprets no record, and every origin validates its
   own records against its own kind list before sending, so the payload check still runs on the machine that built the
   record.
2. **A client sets aside any record it cannot apply instead of raising.** That covers an unknown kind and an apply that
   raises for a known one. The raw record and the reason go in a machine-local `deferred_records` table, a span makes
   the deferral visible, and the cursor moves on. The client retries deferred records at startup and after each pull,
   oldest first, and drops a row once it applies. For the existing kinds whose apply is an upsert where the last apply
   wins (captures, memories, deliberate memories, episodes, and rules), a later record for a row that already has one
   set aside is set aside behind it, and a retry pass that fails on a row's record leaves that row's later records
   waiting. A row's edits therefore land in log order even when one of them is deferred.
3. **Every new record kind must reach the same state whatever order its records are applied in.** A deferred record is
   applied after records the hub logged later, so a kind whose result depends on log order would diverge between a
   machine that deferred and one that did not. The existing upsert kinds get log order per row from decision 2 instead;
   a new kind states order-independence in its own design.

The change ships in the same deploy as the entity directory, ordered once more: the hub, then every client, before any
machine writes an entity. After that deploy no new kind needs an ordered rollout. A client running older code sets the
new records aside and applies them once it is upgraded.

## Alternatives considered

- **Keep the ordered rollout.** No code change, but every new kind repeats the same risk, and the failure is quiet: one
  client that missed the deploy stops receiving everything, and records written too early are lost to every other
  machine for good.
- **Capability negotiation.** Each client reports the kinds it supports, and no machine writes a kind until every
  machine supports it. Correct, but one machine left offline blocks a feature everywhere indefinitely, and it adds a
  registry the hub has to keep.
- **Rewind the cursor after an upgrade.** A client that skipped unknown records remembers the earliest skipped sequence
  number and re-pulls from there once upgraded. Precise about ordering, but it replays and re-embeds every record since
  that point, including every captured turn, to recover a handful.

## Consequences

- One new machine-local table, `deferred_records`, carrying `created_at`/`updated_at` per the schema convention. It is
  never synced.
- A record that can never apply, such as a malformed known-kind record, stays deferred and visible rather than wedging
  the client. Nothing retires it automatically.
- A row whose first deferred record never applies stops updating on that machine until its code is upgraded: every later
  edit of the row waits behind it, visible in `deferred_records`. Other rows keep applying.
- `validate_record` gains a mode that skips payload checks for unknown kinds; the hub uses it, origins do not.
- Extending a known kind's vocabulary still needs the hub upgraded first. The hub checks a known kind's payload, so a
  new value such as another `FORGET_TABLES` entry is refused by a hub that predates it. Only a new kind skips the
  ordered rollout.
- **Not solved here: older clients drop fields they don't know.** A client on older code applies a record of a known
  kind and discards payload fields it has no column for. If it then edits that row and sends it again, the re-sent
  record lacks the field. An upsert built the way `upsert_capture` is, which fills every column from the payload with a
  default for a missing key, then overwrites the field with that default on every machine. Adding a field to an existing
  kind is therefore still order-dependent. Nothing in the entity directory adds one; the next change that does has to
  solve this or roll out in order.
