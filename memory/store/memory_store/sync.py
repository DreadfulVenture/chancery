"""Record-log sync: one protocol, one upsert, full convergence.

Every kind in store.RECORD_KINDS flows through one log; machines pull by
cursor and apply idempotently. Conflict behavior per the sync ADR: LWW for
append-mostly kinds, origin-keyed coexistence for rules (fire-time
suppression on the matcher side handles duplicates), feedback as
accumulative increments, forget with tombstones so a delayed replay of the
original write cannot resurrect a deleted row.
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
from typing import Any

from memory_store import spans
from memory_store.store import Store
from memory_store.store import (
    FEEDBACK_SIGNALS,
    mint_tool_rule_ids,
    normalize_signal,
    parse_legacy_source,
    validate_record,
)


def _normalize_provenance(payload: dict[str, Any], default_app: str, default_origin: str) -> None:
    """Map a wire payload's provenance into columns. Old-shape payloads
    carry only the compound source string (cursor:<repo>:<session> or
    <label>:<repo>) — parse it here, the one place the legacy grammar is
    understood, and write the parsed label back into the source slot
    (leaving the compound string would overwrite a deliberate row's clean
    label on apply). New-shape payloads carry repo/app explicitly and pass
    through unchanged. `default_origin` is capture|consolidated|deliberate:
    the kind of record decides the memory's shape, the payload only
    refines it — a memory record is a deliberate write even when it
    arrives in the old shape."""
    if payload.get("repo") is not None:
        payload.setdefault("app", default_app)
        payload.setdefault("origin", default_origin)
        payload.setdefault("session_id", payload.get("session_id") or "default")
        return
    parsed = parse_legacy_source(payload.get("source"))
    payload["repo"] = parsed["repo"]
    payload["origin"] = default_origin
    payload["app"] = default_app
    payload["source"] = parsed["label"]
    if payload.get("session_id", "default") == "default" and parsed["session_id"] != "default":
        payload["session_id"] = parsed["session_id"]


_ROW_TABLES = {
    "capture": "working_memory",
    "memory": "working_memory",
    "agent_memory": "agent_memory",
    "episodic": "episodic_memory",
}


def _row_key(record: dict[str, Any]) -> str | None:
    """The row a record overwrites, for the kinds whose apply is an upsert
    where the last apply wins; keyed the way apply checks tombstones. The
    other kinds settle the same whatever order their records land in, and
    a forget must never wait behind a stuck edit of the row it deletes."""
    kind = record.get("kind")
    payload = record.get("payload")
    if not isinstance(payload, dict) or payload.get("id") in (None, ""):
        return None
    row_id = payload["id"]
    if kind in _ROW_TABLES:
        return f"{_ROW_TABLES[kind]}:{row_id}"
    if kind == "rule":
        if payload.get("target") == "persona":
            return f"persona_rules:persona:{row_id}"
        return f"situational_rules:situational:{row_id}"
    return None


# Capture rows on the wire share shape with working-memory rows; the apply
# target distinguishes deliberate (kind=speech, non-cursor source) from
# captured (cursor:* source) naturally — both land in working_memory.


class RecordContractError(Exception):
    """A record this host built violates the wire contract.

    Distinct from the transport failures `_emit` swallows: a hub that is
    down must never fail a local write, but a record we cannot legally
    send is a bug in the caller's input, and the caller is an agent that
    can fix it or raise it. This is the one enqueue failure that reaches
    them."""


class SyncClient:
    """Pushes the local outbound queue, pulls by cursor, applies records."""

    def __init__(
        self,
        store: Store,
        hub_url: str,
        machine_id: str,
        api_key: str | None = None,
        queue_dir: str | None = None,
    ):
        self.store = store
        self.hub_url = hub_url.rstrip("/")
        self.machine_id = machine_id
        self.api_key = api_key or ""
        self.queue_dir = queue_dir or os.path.expanduser("~/.local/services/memory/queue")
        os.makedirs(self.queue_dir, exist_ok=True)
        self.cursor_path = os.path.join(self.queue_dir, "pull-cursor")
        # A deployment with no hub is a supported configuration, not a
        # misconfigured one: a single machine keeping its own store has
        # nothing to converge with. Without this the outbound queue accretes
        # a record per captured turn that nothing will ever drain.
        self.enabled = bool(self.hub_url)

    # --- outbound -------------------------------------------------------

    def enqueue(self, kind: str, payload: dict[str, Any], record_id: str | None = None) -> str:
        """Append a record to the outbound JSONL queue (crash-safe: the
        queue drains after the hub acks; lost-in-flight records re-drain).
        occurred_at is stamped here, and the assembled record is validated
        here too — this host is the last point where a contract violation
        still has the agent that caused it in the room. A caller-supplied
        record_id binds the wire record to a local side effect that already
        carries the same id (the feedback tool applies its grading under
        the record_id it will ship, so the hub's relay-back replay is
        deduped by the store instead of doubling the counters). With no hub
        configured the record is dropped rather than queued, but the id is
        still returned so callers binding a local side effect to it behave
        the same either way."""
        record_id = record_id or f"{self.machine_id}-{time.time_ns():x}"
        if not self.enabled:
            return record_id
        record = {
            "record_id": record_id,
            "kind": kind,
            "machine_id": self.machine_id,
            "occurred_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "payload": payload,
        }
        violation = validate_record(record)
        if violation:
            raise RecordContractError(f"{kind} record rejected before send: {violation}")
        with open(os.path.join(self.queue_dir, "outbound.jsonl"), "a", encoding="utf-8") as queue:
            queue.write(json.dumps(record) + "\n")
        return record_id

    def push(self) -> dict:
        """Drain the outbound queue to the hub in batches. Renames the file
        first so concurrent enqueues continue into a fresh file. On any
        failure the unacked records go back on the queue — the hub dedupes
        by record_id, so already-acked batches re-draining are harmless;
        stranding them in an orphaned .processing file (the pre-restore
        behavior, seven batches deep on one client by 2026-09-19) lost them
        from the queue permanently.

        A record the hub rejected and kept is delivered as far as this
        queue is concerned: it is logged there, marked with the reason,
        and re-sending it would only earn the same rejection. Draining it
        is what stops one bad record holding back every record queued
        behind it."""
        if not self.enabled:
            return {"pushed": 0}
        path = os.path.join(self.queue_dir, "outbound.jsonl")
        self._sweep_orphaned_pushes(path)
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            return {"pushed": 0}
        processing = f"{path}.{time.time_ns()}.processing"
        os.rename(path, processing)
        with open(processing, encoding="utf-8") as queue:
            records = []
            for line in queue:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    # A corrupt line is already off the live queue; dropping
                    # it here beats poisoning every future push. Enqueue
                    # writes are append-only whole lines, so this is
                    # crash-torn-tail territory, not a normal shape.
                    print("sync queue: skipping unreadable record line", flush=True)
        pushed = 0
        rejected: list[dict] = []
        try:
            for start in range(0, len(records), 100):
                batch = records[start : start + 100]
                self._normalize_batch(batch)
                request = urllib.request.Request(
                    f"{self.hub_url}/records",
                    data=json.dumps({"records": batch}).encode(),
                    headers=self._headers(),
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=30) as response:
                    result = json.loads(response.read())
                # The hub acks invalid records with a 200 plus a per-record
                # rejection list, each entry indexed within THIS batch.
                batch_rejected = result.get("rejected") or []
                if any(not entry.get("kept") for entry in batch_rejected):
                    # A hub that does not say it kept the record is one that
                    # dropped it (every hub before the invalid_reason column).
                    # Draining against it would destroy the record, so keep
                    # the old behavior: raise, and let `_restore_unacked` put
                    # the batch back for a hub that can hold it.
                    raise RuntimeError(f"hub rejected records: {batch_rejected}")
                for entry in batch_rejected:
                    index = entry.get("index")
                    rejected.append(
                        dict(entry, index=start + index if isinstance(index, int) else None)
                    )
                if batch_rejected:
                    print(
                        f"sync push: hub kept {len(batch_rejected)} invalid record(s): "
                        + "; ".join(str(entry.get("error")) for entry in batch_rejected),
                        flush=True,
                    )
                # Kept rejections count as delivered: the record is logged at
                # the hub with its reason, so leaving it on the queue would
                # re-send it forever and block everything behind it.
                pushed += len(batch)
            os.unlink(processing)
        except BaseException:
            self._restore_unacked(processing, records[pushed:])
            raise
        if rejected:
            # The aggregate signal that a contract mismatch is eating
            # records. It was unreachable until the kept rejections stopped
            # raising, which is the state the 2026-09-19 drift lived in.
            with spans.span("sync.rejected", count=len(rejected)) as node:
                node.set(
                    kinds=sorted(
                        {
                            records[r["index"]]["kind"]
                            for r in rejected
                            if isinstance(r.get("index"), int)
                            and r["index"] < len(records)
                            and isinstance(records[r["index"]], dict)
                            and records[r["index"]].get("kind")
                        }
                    )
                )
        return {"pushed": pushed, "rejected": len(rejected)}

    def _normalize_batch(self, batch: list) -> None:
        """Upgrade payload shapes to the current wire contract in place,
        before POSTing. Records stranded in the queue from older client
        versions (the 2026-09-19 feedback vocabulary drift) re-drain valid
        instead of re-failing every cycle; the hub dedupes by record_id, so
        a re-pushed record is a no-op, never a duplicate. This repairs old
        queue entries only — records built by this version are validated in
        `enqueue` and never reach the queue malformed.

        A signal that cannot be upgraded passes through untouched: a soft
        with no polarity has no direction to recover, and inventing one
        here would write the grading nobody gave. The hub rejects it
        per-record without blocking the batch's valid records."""
        for record in batch:
            if record.get("kind") != "feedback":
                continue
            payload = record.get("payload") or {}
            signal = payload.get("signal")
            if signal in FEEDBACK_SIGNALS:
                continue
            try:
                payload["signal"] = normalize_signal(signal, payload.get("polarity", ""))
            except ValueError:
                pass

    def _sweep_orphaned_pushes(self, path: str) -> None:
        """Return .processing files stranded by crashed pushes to the live
        queue. A push that died between rename and unlink (daemon kill,
        hard crash mid-POST) used to strand its batch forever; the records
        re-drain idempotently. Runs before every push; the daemon's sync
        timer is single-threaded, so a live push is never swept."""
        import glob

        for orphan in sorted(glob.glob(glob.escape(path) + ".*.processing")):
            try:
                with open(orphan, encoding="utf-8") as orphan_file:
                    data = orphan_file.read()
                if data.strip():
                    with open(path, "a", encoding="utf-8") as queue:
                        queue.write(data if data.endswith("\n") else data + "\n")
                os.unlink(orphan)
                print(
                    f"sync queue: swept orphaned push batch {os.path.basename(orphan)}", flush=True
                )
            except OSError as error:
                print(f"sync queue: orphan sweep deferred: {error!r}", flush=True)

    def _restore_unacked(self, processing: str, records: list) -> None:
        """Put unacked records back on the live queue and remove the
        processing file. Best-effort: a failed append leaves the file for
        the next cycle's sweep; the hub's record_id dedupe makes a
        re-pushed record a no-op, never a duplicate."""
        try:
            if records:
                with open(
                    os.path.join(self.queue_dir, "outbound.jsonl"),
                    "a",
                    encoding="utf-8",
                ) as queue:
                    for record in records:
                        queue.write(json.dumps(record) + "\n")
            os.unlink(processing)
        except OSError as error:
            print(f"sync queue: restore deferred: {error!r}", flush=True)

    # --- inbound ----------------------------------------------------------

    def pull(self, limit: int = 100) -> dict:
        """Pull records past the cursor and apply until drained.

        A record the hub marked invalid is counted and stepped over, never
        applied: it failed the contract on the way in, so applying it is
        how a known-bad record becomes a row nobody can distinguish from a
        good one.

        A record this machine cannot apply — a kind it does not know, or
        an apply that raises — is set aside and the cursor moves on (ADR
        20261023-forward-compatible-sync). Raising here instead fails the
        same page on every cycle, and nothing behind it arrives until this
        machine's code changes. A later record for a row that already has
        one set aside is set aside behind it, so the row's edits still
        land in log order. Deferred records are retried once the log is
        drained."""
        if not self.enabled:
            return {"applied": 0, "by_kind": {}}
        cursor = self._load_cursor()
        applied = 0
        skipped = 0
        deferred_kinds: list[str] = []
        by_kind: dict[str, int] = {}
        while True:
            result = self._request_records(cursor, limit)
            records = result.get("records", [])
            for record in records:
                cursor = record["seq"]
                reason = record.get("invalid_reason")
                if reason:
                    skipped += 1
                    print(
                        f"sync pull: skipping invalid record {record.get('record_id')!r} "
                        f"({record.get('kind')}): {reason}",
                        flush=True,
                    )
                    continue
                row_key = _row_key(record)
                if row_key and self.store.has_deferred_row(row_key):
                    self.store.defer_record(
                        record, "waiting behind an earlier record for the same row", row_key
                    )
                    deferred_kinds.append(str(record.get("kind")))
                    continue
                try:
                    self.apply(record)
                except Exception as error:
                    self.store.defer_record(record, repr(error)[:500], row_key)
                    deferred_kinds.append(str(record.get("kind")))
                    print(
                        f"sync pull: deferring record {record.get('record_id')!r} "
                        f"({record.get('kind')}): {error!r}",
                        flush=True,
                    )
                    continue
                kind = record["kind"]
                by_kind[kind] = by_kind.get(kind, 0) + 1
                applied += 1
            self._save_cursor(cursor)
            if not result.get("has_more"):
                break
        if skipped:
            with spans.span("sync.invalid", count=skipped):
                pass
        if deferred_kinds:
            with spans.span(
                "sync.deferred", count=len(deferred_kinds), kinds=sorted(set(deferred_kinds))
            ):
                pass
        retried = self.retry_deferred()
        for kind, count in retried["by_kind"].items():
            by_kind[kind] = by_kind.get(kind, 0) + count
        return {
            "applied": applied + retried["applied"],
            "by_kind": by_kind,
            "skipped": skipped,
            "deferred": retried["deferred"],
        }

    def retry_deferred(self) -> dict:
        """Re-apply set-aside records oldest first; drop each one that
        applies. One that fails again stays, with its reason and attempt
        count updated, so a record that can never apply is visible rather
        than silently gone. Nothing retires it automatically.

        Records the calling pull just deferred are retried too, which is
        the point rather than waste: a record that needs a row from later
        in the same page — an alias removal ahead of the alias — applies on
        this pass instead of waiting for the next cycle.

        A row's records apply in log order or not at all: once one fails,
        the later records for the same row wait, because for those kinds
        the last apply wins and an older edit would land on top."""
        applied = 0
        by_kind: dict[str, int] = {}
        remaining = 0
        blocked: set[str] = set()
        for row in self.store.deferred_records():
            record = row["record"]
            row_key = row["row_key"]
            if row_key in blocked:
                remaining += 1
                continue
            try:
                self.apply(record)
            except Exception as error:
                self.store.defer_record(record, repr(error)[:500], row_key)
                if row_key:
                    blocked.add(row_key)
                remaining += 1
                continue
            self.store.drop_deferred(row["record_id"])
            kind = record["kind"]
            by_kind[kind] = by_kind.get(kind, 0) + 1
            applied += 1
        if remaining:
            with spans.span("sync.deferred_pending", count=remaining):
                pass
        return {"applied": applied, "by_kind": by_kind, "deferred": remaining}

    def _request_records(self, cursor: int, limit: int) -> dict:
        request = urllib.request.Request(
            f"{self.hub_url}/records?cursor={cursor}&limit={limit}",
            headers=self._headers(),
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _load_cursor(self) -> int:
        if os.path.exists(self.cursor_path):
            with open(self.cursor_path, encoding="utf-8") as cursor_file:
                return int(cursor_file.read().strip() or "0")
        return 0

    def _save_cursor(self, cursor: int) -> None:
        with open(self.cursor_path, "w", encoding="utf-8") as cursor_file:
            cursor_file.write(str(cursor))

    # --- apply (idempotent upsert; tombstones guard resurrects) -----------

    def apply(self, record: dict[str, Any]) -> None:
        kind = record["kind"]
        payload = dict(record["payload"])
        if kind in ("capture", "memory"):
            table, row_id = "working_memory", payload["id"]
            if self.store.is_tombstoned(table, row_id):
                return  # deleted locally: delayed replay does not resurrect
            # force: a metadata-only edit (importance, label, veracity)
            # carries a full payload whose content matches the local row, and
            # the same-content guard would swallow it — re-labeling must
            # converge like content does, and a full-payload upsert of a
            # genuine replay writes identical values either way. A memory
            # record normalizes as deliberate even in the old shape, so the
            # forced rewrite re-lands the same origin and label it arrived
            # with; only captures default to the capture origin.
            default_origin = "deliberate" if kind == "memory" else "capture"
            _normalize_provenance(payload, default_app="opencode", default_origin=default_origin)
            self.store.upsert_capture(payload, force=True)
            if kind == "capture":
                self.store.record_capture_turn(payload)
        elif kind == "session":
            # The registry mirrors every capture record's apply, so this
            # kind alone carries the child registrations no turn record
            # ever names.
            conversation_id = payload.get("conversation_id")
            if not conversation_id:
                raise ValueError("session payload must carry conversation_id")
            parent = payload.get("parent_conversation_id") or None
            self.store.get_or_create_session(
                machine=payload.get("machine") or "",
                tool=payload.get("tool") or "",
                client_conversation_id=conversation_id,
                project=payload.get("project") or "",
                parent_conversation_id=parent,
                initiator=payload.get("initiator") or "",
            )
        elif kind == "agent_memory":
            # Deliberate rows carry their session as a resolution triple,
            # never a session id: each machine names the same conversation
            # with its own registry row, settled by get_or_create_session
            # (created if it does not exist yet — the FK is not nullable).
            # Tombstone guard before the resolve: a forgotten row must stay
            # forgotten across a delayed replay of its record.
            row_id = payload["id"]
            if self.store.is_tombstoned("agent_memory", row_id):
                return
            session = payload.get("session") or {}
            session_id = self.store.get_or_create_session(
                machine=session.get("machine") or "",
                tool=session.get("tool") or "",
                client_conversation_id=session.get("conversation_id") or "",
                project=session.get("project") or "",
            )
            # force: a metadata-only edit (importance, label, veracity)
            # carries a full payload whose content matches the local row; the
            # same-content guard would swallow it. Re-labeling converges like
            # content does, and a replayed record writes identical values
            # without re-embedding (content is unchanged).
            self.store.upsert_agent({**payload, "session_id": session_id}, force=True)
        elif kind == "knowledge_base":
            # KB versions are composed artifacts, not per-machine state:
            # a seq race is two distinct versions, and the standing-winner
            # rule in kb_current (highest seq, newest created_at) resolves
            # the read identically on every machine. A replayed identical
            # id re-inserts nothing.
            self.store.upsert_kb(payload)
        elif kind == "tool_rule":
            # Enrollment is content-addressed (tool_key_id / tool_rule_id):
            # every machine re-mints the ids from the payload and the pair
            # converges on the same rows; a replayed record re-inserts
            # nothing. The ids are re-minted here first so the tombstone
            # guard guards exactly the row bind_tool would write: a
            # promoted binding's forget record tombstones the source
            # rule's id (PRJ-168), and the original enrollment record —
            # still in every machine's record log — must replay as a
            # no-op instead of resurrecting it.
            _tool_id, rule_id = mint_tool_rule_ids(payload["tool"], payload["rule"])
            if self.store.is_tombstoned("tool_rules", rule_id):
                return
            self.store.bind_tool(payload["tool"], payload["rule"])
        elif kind == "episodic":
            row_id = payload["id"]
            if self.store.is_tombstoned("episodic_memory", row_id):
                return
            _normalize_provenance(
                payload, default_app="memory-store", default_origin="consolidated"
            )
            self.store.upsert_episodic(payload)
        elif kind == "rule":
            target = payload.pop("target", None)
            if target == "persona":
                row_id = f"persona:{payload['id']}"
                if self.store.is_tombstoned("persona_rules", row_id):
                    payload["id"] = int(payload["id"])
                    payload.pop("_row_key", None)
                    return
                payload["id"] = int(payload["id"])
                self.store.upsert_persona(payload)
            else:
                row_id = f"situational:{payload['id']}"
                if self.store.is_tombstoned("situational_rules", row_id):
                    payload["id"] = int(payload["id"])
                    return
                payload["id"] = int(payload["id"])
                self.store.upsert_situational(payload)
        elif kind == "feedback":
            self.store.apply_feedback(
                int(payload["rule_id"]),
                payload["rule_kind"],
                normalize_signal(payload["signal"], payload.get("polarity", "")),
                float(payload.get("delta", 1.0)),
                payload.get("origin_machine"),
                record_id=record["record_id"],
            )
        elif kind == "forget":
            if payload["table"] == "entities":
                # An entry is forgotten by a row, not a delete: a restore
                # has to be able to bring it back, and a tombstone would
                # refuse the records that carry it.
                self.store.forget_entity(
                    payload["id"],
                    forget_id=record["record_id"],
                    created_at=record["occurred_at"],
                    session=payload["session"],
                )
            else:
                # Forget ordering: tombstone FIRST so a delayed replay of the
                # original write is refused, then delete.
                self.store.forget(payload["table"], payload["id"])
        elif kind == "entity":
            self.store.apply_entity(payload)
        else:
            raise ValueError(f"unknown record kind {kind!r}")

    def run_cycle(self) -> dict:
        """One push + pull cycle. Sync failures raise; the caller (loop) logs
        and retries — partial progress (cursor) is durable."""
        result = self.push()
        result.update(self.pull())
        return result
