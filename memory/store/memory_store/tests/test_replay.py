"""Replay suite: synthetic production-scale fixture, failure-class assertions.

The fixture deterministically expands to 4.5k working rows and 490 episodic
rows. It retains the failure-class structure without carrying real captures or
query strings. The four nudge failure classes from the audit must stay dead:

1. Self-echo (session's own turns recalled back as memory)
2. In-flight fragments (agent transitional prose as candidates)
3. Fork-summary keyword shotgun (huge documents dominating FTS)
4. Repeats (same memory injected repeatedly)

Embedding-dependent scoring runs with a stub embedder (deterministic
vocab-count vectors) so the suite is fast and offline; the assertions are
about pool composition and penalty behavior, not model quality.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.capture import classify_capture
from memory_store.nudge import pool_query
from memory_store.store import Store

FIXTURE = Path(__file__).parent / "fixtures" / "session_replay.json"


def load_fixture():
    with open(FIXTURE, encoding="utf-8") as f:
        fixture = json.load(f)

    working = list(fixture["seed_working"])
    for index in range(len(working), fixture["working_count"]):
        working.append(
            {
                "id": f"working-{index:04d}",
                "content": f"[USER] Synthetic captured turn {index:04d}.",
                "source": "cursor:sample-repo:replay-session",
                "timestamp": f"2026-01-01T00:00:{index % 60:02d}Z",
                "importance": 0.5,
                "veracity": "unknown",
                "author_id": None,
                "author_type": None,
            }
        )

    episodic = [
        {
            "id": f"ep-{index:04d}",
            "content": f"Synthetic consolidated memory {index:04d}.",
            "source": "consolidated",
            "timestamp": f"2026-01-02T00:00:{index % 60:02d}Z",
            "importance": 0.5,
            "veracity": "unknown",
        }
        for index in range(fixture["episodic_count"])
    ]
    return {"working": working, "episodic": episodic}


def build_store_from_fixture(tmpdir):
    """Fixture rows into a fresh store, exactly as capture/apply would."""
    store = Store(Path(tmpdir) / "replay.db")
    data = load_fixture()
    for row in data["working"]:
        store.upsert_capture({**row, "kind": classify_capture(row["content"])})
    for row in data["episodic"]:
        store.upsert_episodic(row)
    return store, data


class FixtureIntegrityTests(unittest.TestCase):
    """The fixture itself demonstrates the classification findings."""

    def test_fixture_loads(self):
        data = load_fixture()
        self.assertGreater(len(data["working"]), 1000)
        self.assertGreater(len(data["episodic"]), 100)

    def test_fork_rows_classify(self):
        data = load_fixture()
        forks = [r for r in data["working"] if "<chat-history-summary>" in r["content"]]
        self.assertGreater(len(forks), 5)  # the known fork rows exist
        for row in forks:
            self.assertEqual(classify_capture(row["content"]), "fork_summary")

    def test_title_gen_rows_present(self):
        data = load_fixture()
        # Capture rows carry the [USER] speaker label the hook prepends.
        leaked = [
            r
            for r in data["working"]
            if "Generate a title and a git branch name for a coding agent" in r["content"][:100]
        ]
        self.assertGreater(len(leaked), 5)  # the known leakage exists
        for row in leaked:
            self.assertEqual(classify_capture(row["content"]), "exhibit")


class FailureClassTests(unittest.TestCase):
    """The four audited failure classes must die in the new design."""

    @classmethod
    def setUpClass(cls):
        import tempfile

        cls.tmp = tempfile.mkdtemp()
        cls.store, cls.data = build_store_from_fixture(cls.tmp)

    @classmethod
    def tearDownClass(cls):
        cls.store.close()

    def test_class_one_self_echo_pool_exclusion(self):
        """Captured turns (session's own prose) are never nudge candidates."""
        pool = pool_query(self.store)
        pool_sources = {r["source"] for r in pool if r.get("source")}
        cursor_sources = [s for s in pool_sources if s.startswith("cursor:")]
        self.assertEqual(cursor_sources, [])

    def test_class_two_fragments_never_candidates(self):
        """Agent transitional prose exists in the fixture as captured turns;
        none may appear
        in the nudge pool."""
        pool = pool_query(self.store)
        fragment_markers = [r for r in pool if "closest analog" in r["content"]]
        self.assertEqual(fragment_markers, [])

    def test_class_three_fork_rows_not_in_pool(self):
        """Fork summaries are excluded by kind at apply-time classification;
        no row classified fork_summary may appear in the nudge pool. (A
        deliberate memory that *quotes* a fork summary in its content is a
        legitimate pool row — the restriction is by kind, not content.)"""
        pool = pool_query(self.store)
        fork_kind_rows = [r for r in pool if r.get("kind") == "fork_summary"]
        self.assertEqual(fork_kind_rows, [])

    def test_class_four_repeats_never_re_fired(self):
        """Semantic debounce: after injection, the same content is filtered
        (verified in test_nudge with the stub scorer); here we assert the pool
        has no duplicate ids that would allow double-injection of one row."""
        pool = pool_query(self.store)
        ids = [r["id"] for r in pool]
        self.assertEqual(len(ids), len(set(ids)))


if __name__ == "__main__":
    unittest.main()
