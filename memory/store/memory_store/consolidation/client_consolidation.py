"""Client-side consolidation scheduling.

Each daemon owns the sessions it captured — and, on the designated adopting
host, the legacy pool of rows that predate per-host ownership (captured_by
empty). Scheduling is per-SESSION idle, not per-daemon: a session is eligible
when its own newest capture is at least the idle window old, so concurrent
sessions on one machine never starve each other's summaries.
"""

from __future__ import annotations

import calendar
import os
import time

from memory_store.consolidation.consolidation import consolidate_group, next_consolidation_group


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _session_idle_secs() -> float:
    return float(os.environ.get("MEMORY_CONSOLIDATION_IDLE_SECS", "600"))


class ClientConsolidator:
    def __init__(
        self,
        store,
        sync,
        machine_id: str,
        version: str,
        idle_secs: float = 600.0,
        consolidate=consolidate_group,
        adopt_unowned: bool = False,
    ):
        self.store = store
        self.sync = sync
        self.machine_id = machine_id
        self.version = version
        self.idle_secs = idle_secs
        self.adopt_unowned = adopt_unowned
        self._consolidate = consolidate
        with self.store._lock, self.store.conn:
            self.store.conn.executescript(
                """CREATE TABLE IF NOT EXISTS consolidation_state (
                       session_id TEXT PRIMARY KEY,
                       next_retry_at TEXT NOT NULL DEFAULT '',
                       consecutive_failures INTEGER NOT NULL DEFAULT 0,
                       force INTEGER NOT NULL DEFAULT 0
                   );"""
            )

    def force(self, session_id: str) -> None:
        if not session_id:
            return
        with self.store._lock, self.store.conn:
            self.store.conn.execute(
                """INSERT INTO consolidation_state (session_id, force)
                   VALUES (?, 1)
                   ON CONFLICT(session_id) DO UPDATE SET force = 1""",
                (session_id,),
            )

    def _eligible(self, session_id: str) -> bool:
        """Retry backoff gate: a session in exponential backoff is skipped
        until its next_retry_at passes."""
        row = self.store.conn.execute(
            "SELECT next_retry_at FROM consolidation_state WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        return row is None or not row["next_retry_at"] or row["next_retry_at"] <= _now()

    def _session_quiet(self, session_id: str) -> bool:
        """Per-session idle: the session's own newest capture is at least the
        idle window old. Interleaved sessions on one machine reset only their
        own clock, never each other's."""
        row = self.store.conn.execute(
            "SELECT MAX(timestamp) AS last FROM working_memory WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None or row["last"] is None:
            return True
        # Captures carry UTC stamps; parse as UTC (calendar.timegm), never
        # mktime (local time) — a local parse shifts the age by the zone
        # offset and the idle check silently never fires.
        age = time.time() - calendar.timegm(time.strptime(row["last"], "%Y-%m-%dT%H:%M:%SZ"))
        return age >= self.idle_secs

    def _failed(self, session_id: str) -> None:
        with self.store._lock, self.store.conn:
            row = self.store.conn.execute(
                "SELECT consecutive_failures FROM consolidation_state WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            failures = (row["consecutive_failures"] if row else 0) + 1
            delay = min(120 * 2 ** (failures - 1), 3600)
            retry_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + delay))
            self.store.conn.execute(
                """INSERT INTO consolidation_state
                   (session_id, next_retry_at, consecutive_failures, force)
                   VALUES (?, ?, ?, 0)
                   ON CONFLICT(session_id) DO UPDATE SET
                     next_retry_at = excluded.next_retry_at,
                     consecutive_failures = excluded.consecutive_failures,
                     force = 0""",
                (session_id, retry_at, failures),
            )

    def _succeeded(self, session_id: str) -> None:
        with self.store._lock, self.store.conn:
            self.store.conn.execute(
                """INSERT INTO consolidation_state (session_id)
                   VALUES (?)
                   ON CONFLICT(session_id) DO UPDATE SET
                     next_retry_at = '', consecutive_failures = 0, force = 0""",
                (session_id,),
            )

    def run_pass(self) -> dict[str, int]:
        groups = next_consolidation_group(self.store, captured_by=self.machine_id)
        if self.adopt_unowned:
            for session_id, row_ids in next_consolidation_group(self.store, captured_by="").items():
                groups.setdefault(session_id, row_ids)
        forced = {
            row["session_id"]
            for row in self.store.conn.execute(
                "SELECT session_id FROM consolidation_state WHERE force = 1"
            ).fetchall()
        }
        # Force is ordering, never filtering: forced sessions sort first and
        # skip the idle gate (a compaction boundary wants its summary now),
        # while the normal pass runs every tick — a forced session parked
        # outside the oldest-200 window must never suppress anyone else's
        # pass. A forced session with nothing groupable this window cannot
        # be honored: drop the flag — bare, so any backoff state survives —
        # so it cannot dangle; the normal pass reaches the rows oldest-first
        # in a later window. The forced read and the groups query are not
        # atomic with the drain thread's force writes, so a force written
        # mid-pass can be cleared by this same tick: benign and self-healing
        # (the next compaction re-forces), only the boundary priority is
        # lost. consolidation_state is local per-host state the sync never
        # ships, so a clear can only ever touch this host's own flags.
        dangling = forced - groups.keys()
        if dangling:
            self.store.clear_force_flags(list(dangling))
        sessions = sorted(groups, key=lambda session: (session not in forced, session))
        result = {"groups": 0, "summarized": 0, "released": 0, "skipped": 0}
        for session_id in sessions:
            if not self._eligible(session_id):
                result["skipped"] += 1
                continue
            if session_id not in forced and not self._session_quiet(session_id):
                result["skipped"] += 1
                continue
            result["groups"] += 1
            outcome = self._consolidate(
                self.store,
                session_id,
                groups[session_id],
                consolidator_version=self.version,
            )
            if outcome["status"] == "ok":
                self.sync.enqueue("episodic", outcome["episodic"])
                self._succeeded(session_id)
                result["summarized"] += 1
            elif outcome["status"] == "released":
                self._failed(session_id)
                result["released"] += 1
        return result

    def tick(self) -> dict[str, int]:
        # No force-only short-circuit: any force=1 row used to suppress the
        # normal pass forever when the forced session sat outside the
        # oldest-200 window (the 2026-10-20 freeze). Force is ordering.
        return self.run_pass()
