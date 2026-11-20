"""Client-side consolidation ownership, triggers, and retry tests."""

from __future__ import annotations

import tempfile
import unittest

from pathlib import Path

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.consolidation.client_consolidation import ClientConsolidator
from memory_store.consolidation.consolidation import consolidate_group
from memory_store.store import Store
from memory_store.sync import SyncClient


def summarize(lines, source):
    return f"Summary of {len(lines)} turns."


class ClientConsolidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "memory.db")
        self.store.vec_available = False
        self.sync = SyncClient(self.store, "http://hub.invalid", "host-a", queue_dir=self.tmp)
        self.store.upsert_capture(
            {
                "id": "c1",
                "content": "[USER] consolidate on the origin host",
                "session_id": "session-a",
                "kind": "speech",
                "captured_by": "host-a",
            }
        )
        self.client = ClientConsolidator(
            self.store,
            self.sync,
            "host-a",
            "rev:test",
            idle_secs=0,
            consolidate=lambda *args, **kwargs: consolidate_group(
                *args, summarizer=summarize, **kwargs
            ),
        )

    def tearDown(self):
        self.store.close()

    def test_force_consolidates_owned_session_and_emits_record(self):
        self.client.force("session-a")
        result = self.client.tick()
        self.assertEqual(result["summarized"], 1)
        self.assertEqual(
            self.store.conn.execute(
                "SELECT consolidator_version FROM working_memory WHERE id = 'c1'"
            ).fetchone()["consolidator_version"],
            "rev:test",
        )
        self.assertTrue((Path(self.tmp) / "outbound.jsonl").exists())

    def test_failure_records_exponential_backoff(self):
        client = ClientConsolidator(
            self.store,
            self.sync,
            "host-a",
            "rev:test",
            idle_secs=0,
            consolidate=lambda *args, **kwargs: {"status": "released"},
        )
        result = client.tick()
        self.assertEqual(result["released"], 1)
        state = self.store.conn.execute(
            "SELECT consecutive_failures, next_retry_at FROM consolidation_state "
            "WHERE session_id = 'session-a'"
        ).fetchone()
        self.assertEqual(state["consecutive_failures"], 1)
        self.assertTrue(state["next_retry_at"])

    def test_backoff_blocks_retry_until_window_passes(self):
        client = ClientConsolidator(
            self.store,
            self.sync,
            "host-a",
            "rev:test",
            idle_secs=0,
            consolidate=lambda *args, **kwargs: {"status": "released"},
        )
        client.tick()
        retry = client.tick()
        self.assertEqual(retry["skipped"], 1)
        self.assertEqual(retry["released"], 0)


class PerSessionIdleTests(unittest.TestCase):
    """The idle trigger is per-SESSION: interleaved captures from one session
    must never starve another's summary (the live bug: a machine-global clock
    plus seven concurrent sessions silenced the client all day)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "memory.db")
        self.store.vec_available = False
        self.sync = SyncClient(self.store, "http://hub.invalid", "host-a", queue_dir=self.tmp)

    def tearDown(self):
        self.store.close()

    def _capture(self, row_id, session_id, age_secs):
        import time

        self.store.upsert_capture(
            {
                "id": row_id,
                "content": f"[USER] turn {row_id}",
                "session_id": session_id,
                "kind": "speech",
                "captured_by": "host-a",
                "timestamp": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - age_secs)
                ),
            }
        )

    def test_quiet_session_eligible_while_other_active(self):
        # session-a quiet for 20 minutes; session-b captured 1 minute ago.
        self._capture("a1", "session-a", age_secs=1200)
        self._capture("b1", "session-b", age_secs=60)
        client = ClientConsolidator(
            self.store,
            self.sync,
            "host-a",
            "rev:test",
            idle_secs=600,
            consolidate=lambda *args, **kwargs: consolidate_group(
                *args, summarizer=summarize, **kwargs
            ),
        )
        result = client.tick()
        self.assertEqual(result["summarized"], 1)
        # session-a consolidated; session-b untouched.
        self.assertIsNotNone(
            self.store.conn.execute(
                "SELECT consolidated_at FROM working_memory WHERE id = 'a1'"
            ).fetchone()["consolidated_at"]
        )
        self.assertIsNone(
            self.store.conn.execute(
                "SELECT consolidated_at FROM working_memory WHERE id = 'b1'"
            ).fetchone()["consolidated_at"]
        )

    def test_active_session_not_consolidated(self):
        self._capture("b1", "session-b", age_secs=60)
        client = ClientConsolidator(
            self.store,
            self.sync,
            "host-a",
            "rev:test",
            idle_secs=600,
            consolidate=lambda *args, **kwargs: consolidate_group(
                *args, summarizer=summarize, **kwargs
            ),
        )
        result = client.tick()
        self.assertEqual(result["summarized"], 0)
        self.assertEqual(result["skipped"], 1)


class ForceOrderingTests(unittest.TestCase):
    """Force is ordering, never filtering. The 2026-10-20 deadlock: 41
    dangling force flags silenced the client for 28 days, because any
    force=1 row suppressed the normal pass forever while the forced pass
    could only reach sessions inside the oldest-200 window — which
    compacted sessions, once a backlog exists, no longer are."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "memory.db")
        self.store.vec_available = False
        self.sync = SyncClient(self.store, "http://hub.invalid", "host-a", queue_dir=self.tmp)
        self.order: list[str] = []

        def recorder(store, session_id, row_ids, **kwargs):
            self.order.append(session_id)
            return consolidate_group(store, session_id, row_ids, summarizer=summarize, **kwargs)

        self.client = ClientConsolidator(
            self.store,
            self.sync,
            "host-a",
            "rev:test",
            idle_secs=600,
            consolidate=recorder,
        )

    def tearDown(self):
        self.store.close()

    def _capture(self, row_id, session_id, age_secs):
        import time

        self.store.upsert_capture(
            {
                "id": row_id,
                "content": f"[USER] turn {row_id}",
                "session_id": session_id,
                "kind": "speech",
                "captured_by": "host-a",
                "timestamp": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - age_secs)
                ),
            }
        )

    def _forced(self, session_id):
        row = self.store.conn.execute(
            "SELECT force FROM consolidation_state WHERE session_id = ?", (session_id,)
        ).fetchone()
        return bool(row and row["force"])

    def test_dangling_force_never_starves_the_normal_pass(self):
        # The live shape: 200 older filler rows fill the oldest-200 window,
        # the forced session's newer rows sit outside it, backlog present.
        for i in range(200):
            self._capture(f"f{i:03d}", "filler", age_secs=100000 + i)
        self._capture("d1", "dead", age_secs=50000)
        self.client.force("dead")
        first = self.client.tick()
        # The normal pass ran despite the force row: filler summarized.
        self.assertEqual(self.order, ["filler"])
        self.assertEqual(first["summarized"], 1)
        self.assertIsNotNone(
            self.store.conn.execute(
                "SELECT consolidated_at FROM working_memory WHERE id = 'f000'"
            ).fetchone()["consolidated_at"]
        )
        # The dangle cleared: dead had no groupable rows this tick.
        self.assertFalse(self._forced("dead"))
        # Tick after tick, the pass keeps running — the forced session's
        # own rows go once the window reaches them.
        second = self.client.tick()
        self.assertEqual(second["summarized"], 1)
        self.assertIsNotNone(
            self.store.conn.execute(
                "SELECT consolidated_at FROM working_memory WHERE id = 'd1'"
            ).fetchone()["consolidated_at"]
        )

    def test_force_clears_when_nothing_groupable_and_keeps_backoff(self):
        self.client.force("empty")
        with self.store.conn:
            self.store.conn.execute(
                "UPDATE consolidation_state SET consecutive_failures = 2, "
                "next_retry_at = '2030-01-01T00:00:00Z' WHERE session_id = 'empty'"
            )
        result = self.client.tick()
        self.assertEqual(result["summarized"], 0)
        state = self.store.conn.execute(
            "SELECT force, consecutive_failures, next_retry_at FROM consolidation_state "
            "WHERE session_id = 'empty'"
        ).fetchone()
        self.assertEqual(state["force"], 0)
        # The bare clear keeps backoff state: only the flag drops.
        self.assertEqual(state["consecutive_failures"], 2)
        self.assertEqual(state["next_retry_at"], "2030-01-01T00:00:00Z")

    def test_store_clear_force_flags_is_bare_and_locks_itself(self):
        # The flag clear routes through the Store method (review 267,
        # count 2): the lock protocol and its ordering with conn belong to
        # Store, and the clear stays bare — backoff state survives.
        self.client.force("dangling")
        with self.store.conn:
            self.store.conn.execute(
                "UPDATE consolidation_state SET consecutive_failures = 3, "
                "next_retry_at = '2030-01-01T00:00:00Z' WHERE session_id = 'dangling'"
            )
        self.store.clear_force_flags(["dangling", "never_forced"])
        state = self.store.conn.execute(
            "SELECT force, consecutive_failures, next_retry_at FROM consolidation_state "
            "WHERE session_id = 'dangling'"
        ).fetchone()
        self.assertEqual(state["force"], 0)
        self.assertEqual(state["consecutive_failures"], 3)
        self.assertEqual(state["next_retry_at"], "2030-01-01T00:00:00Z")

    def test_forced_session_bypasses_the_idle_gate(self):
        # Force means summarize at the boundary now, not after the idle
        # window: an active (60s-old) session forced by a compaction still
        # consolidates this tick.
        self._capture("a1", "session-a", age_secs=60)
        self.client.force("session-a")
        result = self.client.tick()
        self.assertEqual(result["summarized"], 1)
        self.assertFalse(self._forced("session-a"))

    def test_forced_session_goes_first_without_starving_others(self):
        self._capture("z1", "zession", age_secs=100000)
        self._capture("a1", "asession", age_secs=90000)
        self.client.force("zession")
        result = self.client.tick()
        self.assertEqual(result["summarized"], 2)
        # Forced sorts first: zession before asession, which plain sorting
        # would have reversed.
        self.assertEqual(self.order, ["zession", "asession"])
        self.assertFalse(self._forced("zession"))


class AdoptionTests(unittest.TestCase):
    """The adopting host claims the legacy pool (captured_by empty) so the
    pre-ownership backlog drains client-side once the hub worker is gone."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "memory.db")
        self.store.vec_available = False
        self.sync = SyncClient(self.store, "http://hub.invalid", "host-a", queue_dir=self.tmp)
        # Legacy row: pre-PR capture with no owner.
        self.store.upsert_capture(
            {
                "id": "legacy1",
                "content": "[USER] legacy turn",
                "session_id": "session-old",
                "kind": "speech",
                "captured_by": "",
            }
        )

    def tearDown(self):
        self.store.close()

    def _client(self, adopt):
        return ClientConsolidator(
            self.store,
            self.sync,
            "host-a",
            "rev:test",
            idle_secs=0,
            consolidate=lambda *args, **kwargs: consolidate_group(
                *args, summarizer=summarize, **kwargs
            ),
            adopt_unowned=adopt,
        )

    def test_adopter_consolidates_unowned_rows(self):
        result = self._client(adopt=True).tick()
        self.assertEqual(result["summarized"], 1)
        self.assertEqual(
            self.store.conn.execute(
                "SELECT consolidator_version FROM working_memory WHERE id = 'legacy1'"
            ).fetchone()["consolidator_version"],
            "rev:test",
        )

    def test_non_adopter_ignores_unowned_rows(self):
        result = self._client(adopt=False).tick()
        self.assertEqual(result["groups"], 0)
        self.assertIsNone(
            self.store.conn.execute(
                "SELECT consolidated_at FROM working_memory WHERE id = 'legacy1'"
            ).fetchone()["consolidated_at"]
        )


if __name__ == "__main__":
    unittest.main()
