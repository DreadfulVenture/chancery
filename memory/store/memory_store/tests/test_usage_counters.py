"""Usage counters (PRD 20261104, pull-based recall): stamping is the read
handlers' job and nobody else's. Every agent-initiated read (recall, get,
list, find_conversations, find_duplicates, kb) bumps count and last-used on
the rows it returns; no automatic path — the prompt-time scorer, session
open, tool-recall, tool-moment — can reach a stamp at all, because stamps
originate from Tools read handlers, never from the shared query helpers."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.server.daemon import DaemonState, RecordEmittingTools, drain_captures  # noqa: F401
from memory_store.nudge import pool_query
from memory_store.recall import explicit_recall
from memory_store.store import EMBEDDING_DIM, Store
from memory_store.sync import SyncClient
from memory_store.tools import Tools


def counters(store: Store) -> dict:
    return {r["row_id"]: dict(r) for r in store.conn.execute("SELECT * FROM usage_counters")}


def seed(store: Store) -> None:
    store.upsert_capture(
        {
            "id": "del1",
            "content": "gateway unit ownership belongs to the service",
            "source": "fact",
            "repo": "example",
            "origin": "deliberate",
            "app": "opencode",
        }
    )
    store.upsert_capture(
        {
            "id": "raw1",
            "content": "[USER] gateway ownership was discussed with the service team",
            "source": "cursor:example:ses_a",
            "session_id": "ses_a",
            "repo": "example",
            "origin": "capture",
            "app": "opencode",
        }
    )
    store.upsert_episodic(
        {
            "id": "e1",
            "content": "Session covered gateway unit ownership and the drop-in policy",
            "source": "hub",
            "summary_of": "ses_a",
        }
    )


def seed_kb(store: Store, project: str = "example") -> None:
    store.upsert_kb(
        {
            "id": "kb1",
            "project": project,
            "doc": "gateway unit ownership belongs to the service",
            "inputs": ["del1"],
            "build_seq": 1,
            "created_at": "2026-11-06T00:00:00Z",
        }
    )


class AgentReadsStamp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "u.db")
        seed(self.store)
        self.tools = Tools(self.store, "testbox")

    def tearDown(self):
        self.store.close()

    def test_recall_stamps_the_rows_it_returns(self):
        result = self.tools.memory_recall("gateway ownership", limit=12)
        returned = {r["id"]: r["tier"] for r in result["results"]}
        stamped = counters(self.store)
        self.assertEqual({rid: row["tier"] for rid, row in stamped.items()}, returned)
        self.assertTrue(returned, "seed must guarantee at least one hit")
        for row in stamped.values():
            self.assertEqual(row["count"], 1)
            self.assertTrue(row["last_used_at"], "last-used must be stamped too")

    def test_recall_counts_accumulate_per_call(self):
        self.tools.memory_recall("gateway ownership", limit=12)
        self.tools.memory_recall("gateway ownership", limit=12)
        for row in counters(self.store).values():
            self.assertEqual(row["count"], 2)

    def test_one_call_counts_one_read_even_when_a_row_is_returned_twice(self):
        self.store.stamp_usage([("del1", "working"), ("del1", "working")])
        self.store.stamp_usage([("del1", "working")])
        self.assertEqual(counters(self.store)["del1"]["count"], 2)

    def test_get_stamps_only_on_a_hit(self):
        self.tools.memory_get("del1")
        self.assertEqual(set(counters(self.store)), {"del1"})
        self.tools.memory_get("entirely-absent-id")
        self.assertEqual(set(counters(self.store)), {"del1"}, "a miss stamps nothing")

    def test_list_stamps_the_listed_rows(self):
        result = self.tools.memory_list()
        listed = {r["id"]: r["tier"] for r in result["rows"]}
        self.assertEqual({rid: row["tier"] for rid, row in counters(self.store).items()}, listed)
        self.assertIn("del1", listed)

    def test_find_conversations_stamps_the_best_matching_turn(self):
        result = self.tools.memory_find_conversations("gateway ownership")
        self.assertEqual(result["count"], 1)
        stamped = counters(self.store)
        # The pointer is surface; the row read is the best turn behind it.
        self.assertEqual(set(stamped), {"raw1"})
        self.assertEqual(stamped["raw1"]["tier"], "working")

    def test_kb_read_stamps_the_doc(self):
        seed_kb(self.store)
        result = self.tools.knowledge_read(project="example")
        self.assertEqual([d["id"] for d in result["docs"]], ["kb1"])
        stamped = counters(self.store)
        self.assertEqual(stamped["kb1"]["tier"], "kb")

    def test_kb_fetch_of_deferred_facts_stamps_each_fact_once(self):
        self.store.upsert_capture(
            {
                "id": "del2",
                "content": "the drop-in policy lives with the unit",
                "source": "fact",
                "repo": "example",
                "origin": "deliberate",
                "app": "opencode",
            }
        )
        self.store.session_facts_defer("conv-1", "cursor", "example", ["del1", "del2"])
        result = self.tools.knowledge_read(conversation_id="conv-1")
        self.assertEqual([f["id"] for f in result["facts"]], ["del1", "del2"])
        stamped = counters(self.store)
        self.assertEqual(set(stamped), {"del1", "del2"})
        for row in stamped.values():
            self.assertEqual(row["tier"], "working")
            self.assertEqual(row["count"], 1)

    def test_row_payloads_are_unchanged_by_stamping(self):
        """A regression that moved counters onto the memory tables would
        leak telemetry through SELECT * (memory_get) and the wire payloads;
        the side-table shape keeps row payloads byte-identical."""
        before = self.tools.memory_get("del1")["record"]
        self.tools.memory_get("del1")  # stamp happens
        self.tools.memory_recall("gateway", limit=12)
        after = self.tools.memory_get("del1")["record"]
        self.assertEqual(after, before)
        self.assertNotIn("count", after)
        self.assertNotIn("last_used_at", after)


class DuplicateReadsStamp(unittest.TestCase):
    """find_duplicates is the store-tending surface; the pair/cluster names
    on screen are what the agent read. Vec-stub pattern
    (StoredVectorTests): embed stubbed, vec tables seeded by hand."""

    VOCAB = ["gateway", "listening", "zebra", "quux"]

    def _vec(self, text):
        low = text.lower()
        return [float(low.count(w)) for w in self.VOCAB] + [0.0] * (EMBEDDING_DIM - 4)

    def setUp(self):
        try:
            import sqlite_vec  # noqa: F401
        except ImportError:
            self.skipTest("sqlite_vec unavailable in this environment")
        self._embeddings_disabled = os.environ.pop("MEMORY_DISABLE_EMBEDDINGS", None)
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "u.db")
        if not self.store.vec_available:
            self.skipTest("vec extension failed to load")
        seed(self.store)
        self.store.upsert_capture(
            {
                "id": "del2",
                "content": "gateway unit ownership belongs to the service, verbatim-ish",
                "source": "fact",
                "repo": "example",
                "origin": "deliberate",
                "app": "opencode",
            }
        )
        with mock.patch.object(
            self.store,
            "embed",
            side_effect=lambda texts, origin=None: [self._vec(t) for t in texts],
        ):
            for row in self.store.conn.execute(
                "SELECT rowid, id, content FROM working_memory"
            ).fetchall():
                self.store._vec_delete("vec_working", row["rowid"])
                self.store._vec_insert("vec_working", row["rowid"], self._vec(row["content"]))
        self.tools = Tools(self.store, "testbox")

    def tearDown(self):
        self.store.close()
        if self._embeddings_disabled is not None:
            os.environ["MEMORY_DISABLE_EMBEDDINGS"] = self._embeddings_disabled

    def test_pair_members_stamp(self):
        result = self.tools.memory_find_duplicates()
        names = set()
        for pair in result["pairs"]:
            names.update((pair["a"], pair["b"]))
        self.assertEqual(set(counters(self.store)), names)
        self.assertTrue(names, "seed must produce at least one pair")


class MachinePathsNeverStamp(unittest.TestCase):
    """The daemon's own read paths share this suite's store with seeded
    telemetry bait: after every machine-side read, the counter table must
    still be empty."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="counters-neg-")
        self.queue_dir = os.path.join(self.tmp, "queue")
        os.makedirs(self.queue_dir)
        self.store = Store(os.path.join(self.tmp, "memory.db"))
        seed(self.store)
        seed_kb(self.store)
        self.store.vec_available = False
        self.sync = SyncClient(
            self.store, "http://hub.invalid", "test-machine", queue_dir=self.queue_dir
        )
        self.tools = RecordEmittingTools(
            self.store, "test-machine", self.sync, os.path.join(self.tmp, "floor.md")
        )
        self.state = DaemonState(self.store, self.tools, self.sync)

    def tearDown(self):
        self.store.close()

    def test_every_machine_path_leaves_no_stamp(self):
        # Pool/rule scoring embeds when vectors are missing; a stub keeps
        # it hermetic (the vec leg is off, so scoring degrades to lexical).
        with mock.patch.object(
            self.store,
            "embed",
            side_effect=lambda texts, origin=None: [[1.0, 0.0] for _ in texts],
        ):
            self.state.session_open({"prompt": "gateway ownership", "workspace": "example"})
            self.state.tool_recall({"command": "git push origin main", "delivery": "before"})
            self.state.tool_moment(
                {
                    "event": {"kind": "command", "command": "git push origin main"},
                    "conversation_id": "c1",
                    "workspace": "example",
                    "app": "opencode",
                }
            )
            self.state.tool_moment(
                {
                    "event": {"kind": "command", "command": "git push origin main"},
                    "conversation_id": "c1",
                    "workspace": "example",
                    "app": "opencode",
                }
            )
            raw_recall = explicit_recall(self.store, "gateway", limit=5)
            pointer_pool = pool_query(self.store, "gateway")
            self.assertTrue(raw_recall or pointer_pool is not None)
            drain_captures(self.store, self.sync)
        self.assertEqual(counters(self.store), {})
