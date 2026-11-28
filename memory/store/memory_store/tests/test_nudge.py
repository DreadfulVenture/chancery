"""Tests for the nudge scorer: pool restriction, penalty, framing.

Embedding-dependent tests use a stub embedder so they run without the model.
"""

from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.nudge import length_penalty, nudge_score, pool_query
from memory_store.store import Store


def cosine_of(a, b):
    import math

    dot = sum(x * y for x, y in zip(a, b, strict=True))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(x * x for x in b)))


class StubEmbedTests(unittest.TestCase):
    """Deterministic stub embeddings: a row's vector encodes marker words.

    Vector = counts over a fixed 4-word vocabulary so similarity is
    predictable: [gateway, ownership, docker, zebra]."""

    VOCAB = ["gateway", "ownership", "docker", "zebra"]

    def _vec(self, text):
        low = text.lower()
        return [float(low.count(w)) for w in self.VOCAB]

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "n.db")
        # Pure stub space: vec0 storage is disabled for the store so the
        # pool is scored entirely from the patched embedder (the hermetic
        # MEMORY_DISABLE_EMBEDDINGS=1 run gets the same shape for free).
        self.store.vec_available = False
        self.store.upsert_capture(
            {
                "id": "raw1",
                "content": "[USER] gateway ownership was discussed",
                "source": "",
                "kind": "speech",
                "session_id": "ses_a",
                "repo": "example",
                "origin": "capture",
                "app": "opencode",
            }
        )
        self.store.upsert_capture(
            {
                "id": "raw2",
                "content": "[USER] <chat-history-summary> gateway ownership",
                "source": "",
                "kind": "fork_summary",
                "session_id": "ses_b",
                "repo": "example",
                "origin": "capture",
                "app": "opencode",
            }
        )
        self.store.upsert_capture(
            {
                "id": "del1",
                "content": "gateway unit ownership belongs to the service",
                "source": "fact",
                "repo": "example",
                "origin": "deliberate",
                "app": "opencode",
            }
        )
        self.store.upsert_capture(
            {
                "id": "del2",
                "content": "docker compose is used for deployments",
                "source": "convention",
                "repo": "example",
                "origin": "deliberate",
                "app": "opencode",
            }
        )
        self.store.upsert_episodic(
            {
                "id": "e1",
                "content": "session covered gateway ownership",
                "source": "hub",
                "repo": "example",
                "origin": "consolidated",
                "app": "memory-store",
            }
        )

    def tearDown(self):
        self.store.close()

    def _nudge(self, prompt, **kwargs):
        with mock.patch.object(
            self.store,
            "embed",
            side_effect=lambda texts, origin=None: [self._vec(t) for t in texts],
        ):
            return nudge_score(self.store, prompt, **kwargs)

    def test_pool_excludes_captured_turns(self):
        pool = pool_query(self.store)
        ids = {r["id"] for r in pool}
        self.assertNotIn("raw1", ids)
        self.assertNotIn("raw2", ids)
        self.assertIn("del1", ids)
        self.assertIn("e1", ids)

    def test_repo_column_drives_workspace_match(self):
        # The provenance column replaced the compound source string: the
        # repo boost keys on the repo column, no string parse.
        pool = pool_query(self.store, workspace="example")
        compound = [r for r in pool if r["id"] == "del2"]
        self.assertEqual(len(compound), 1)
        self.assertTrue(compound[0]["workspace_match"])

    def test_nudge_returns_matching_deliberate_not_captures(self):
        results = self._nudge("who owns the gateway unit?", limit=3, score_threshold=0.1)
        ids = {r["id"] for r in results}
        self.assertNotIn("raw1", ids)
        self.assertNotIn("raw2", ids)
        self.assertTrue(ids & {"del1", "e1"})

    def test_framing_data_present(self):
        results = self._nudge("gateway ownership", limit=3, score_threshold=0.1)
        for r in results:
            for field in (
                "author_id",
                "author_type",
                "created_at",
                "veracity",
                "timestamp",
                "tier",
            ):
                self.assertIn(field, r)
            self.assertTrue(r["created_at"])


class AgentPoolTests(unittest.TestCase):
    """The nudge pool's agent branch: agent_memory rows enter the pool in
    the working tier, key their vectors through vec_agent, and a twin id
    in both homes serves once."""

    VOCAB = ["deploy", "commit", "gateway", "zebra"]

    def _vec(self, text):
        low = text.lower()
        return [float(low.count(w)) for w in self.VOCAB]

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "t.db")
        # Pure stub space (StubEmbedTests' pattern): vec0 storage is off so
        # a seed-time real model embed cannot mix with the 4-dim stub the
        # patched embedder returns.
        self.store.vec_available = False
        self.store.get_or_create_session("hal", "opencode", "ses_gw", project="example")
        self.store.upsert_agent(
            {
                "id": "del1",
                "session_id": self.store.conn.execute(
                    "SELECT id FROM session WHERE client_conversation_id = 'ses_gw'"
                ).fetchone()[0],
                "content": "gateway unit ownership belongs to the agent home",
                "importance": 0.9,
                "repo": "example",
                "app": "opencode",
            }
        )

    def tearDown(self):
        self.store.close()

    def _nudge(self, prompt, **kwargs):
        with mock.patch.object(
            self.store,
            "embed",
            side_effect=lambda texts, origin=None: [self._vec(t) for t in texts],
        ):
            return nudge_score(self.store, prompt, **kwargs)

    def test_the_agent_home_serves_once_per_id(self):
        pool = pool_query(self.store)
        entries = [r for r in pool if r["id"] == "del1"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["vec_table"], "vec_agent")
        self.assertEqual(entries[0]["origin"], "deliberate")

    def test_agent_rows_score_from_their_home(self):
        results = self._nudge("who owns the gateway unit?", limit=3, score_threshold=0.1)
        self.assertIn("del1", [r["id"] for r in results])

    def test_workspace_match_reaches_agent_rows(self):
        pool = pool_query(self.store, workspace="example")
        entry = next(r for r in pool if r["id"] == "del1")
        self.assertTrue(entry["workspace_match"])


class StoredVectorTests(unittest.TestCase):
    """The pool scores from stored vec0 vectors; the stub embedder must only
    see the prompt (+ debounce misses), never the recomputed pool."""

    VOCAB = ["gateway", "ownership", "docker", "zebra"]

    def _vec(self, text):
        from memory_store.store import EMBEDDING_DIM

        low = text.lower()
        return [float(low.count(w)) for w in self.VOCAB] + [0.0] * (EMBEDDING_DIM - 4)

    def setUp(self):
        try:
            import sqlite_vec  # noqa: F401
        except ImportError:
            self.skipTest("sqlite_vec unavailable in this environment")
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "n.db")
        if not self.store.vec_available:
            self.skipTest("vec unavailable (embeddings disabled or extension missing)")
        # Writes take the no-vec path so the store holds no real-model
        # vectors; the vec0 tables are then seeded with expected stub-space
        # vectors by hand below.
        self.store.vec_available = False
        self.store.upsert_capture(
            {
                "id": "del1",
                "content": "gateway unit ownership belongs to a client host",
                "source": "fact",
                "repo": "example",
                "origin": "deliberate",
                "app": "opencode",
            }
        )
        self.store.upsert_episodic(
            {
                "id": "e1",
                "content": "session covered gateway ownership",
                "source": "hub",
                "repo": "example",
                "origin": "consolidated",
                "app": "memory-store",
            }
        )
        # Vector-store embeds that already happened (via patched embed) must
        # satisfy the pool entirely at scoring time.
        self.store.vec_available = True
        with mock.patch.object(
            self.store,
            "embed",
            side_effect=lambda texts, origin=None: [self._vec(t) for t in texts],
        ):
            for row in self.store.conn.execute(
                "SELECT rowid, content FROM working_memory"
            ).fetchall():
                self.store._vec_insert("vec_working", row["rowid"], self._vec(row["content"]))
            for row in self.store.conn.execute(
                "SELECT rowid, content FROM episodic_memory"
            ).fetchall():
                self.store._vec_insert("vec_episodes", row["rowid"], self._vec(row["content"]))

    def tearDown(self):
        self.store.close()

    def test_pool_scoring_never_reembeds_pool(self):
        calls: list[list[str]] = []

        def recording_embed(texts, origin=None):
            calls.append(list(texts))
            return [self._vec(t) for t in texts]

        with mock.patch.object(self.store, "embed", side_effect=recording_embed):
            results = nudge_score(self.store, "gateway ownership", score_threshold=0.1)
        # The prompt is the only thing that crosses the embedder: every
        # pool row came from the stored vec0 tables.
        embedded = [t for call in calls for t in call]
        self.assertEqual(embedded, ["gateway ownership"])
        self.assertTrue(results)


class CachedEmbedTests(unittest.TestCase):
    """store.embed serves identical texts (repeated prompts, upserts) from
    the sha256 cache — one inference per unique content, ever."""

    def setUp(self):
        try:
            import fastembed  # noqa: F401
        except ImportError:
            self.skipTest("fastembed unavailable")
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "n.db")
        if not self.store.vec_available:
            self.skipTest("vec unavailable (embeddings disabled or extension missing)")

    def tearDown(self):
        self.store.close()

    def test_cache_memoizes_and_chunks(self):
        from fastembed import TextEmbedding

        counts = {"batches": [], "texts": 0}
        embed = self.store.embed

        class CountingEmbedder:
            def __init__(self, embedder):
                self.embedder = embedder

            def embed(self, texts, origin=None):
                lists = list(texts)
                counts["batches"].append(len(lists))
                counts["texts"] += len(lists)
                return list(self.embedder.embed(lists))

        def make(_model, threads=None):
            self.assertLessEqual(threads, 16)
            return CountingEmbedder(TextEmbedding("BAAI/bge-small-en-v1.5"))

        with (
            mock.patch("memory_store.store.EMBED_BATCH_CHUNK", 4),
            mock.patch("fastembed.TextEmbedding", side_effect=make),
        ):
            one = embed(["alpha", "beta", "gamma", "delta"])
            again = embed(["alpha", "beta"])
            third = embed(["beta", "alpha"])
            # Identical content embeds exactly once (cache hits on repeat);
            # no batch crosses the chunk cap (a ≥64-batch wedges the KleidiAI
            # SME kernel — that is the bug the cap exists for).
            self.assertEqual(counts["texts"], 4)
            self.assertTrue(all(size <= 4 for size in counts["batches"]))
            self.assertEqual(again[0], one[0])
            self.assertEqual(third[1], one[0])


class LengthPenaltyTests(unittest.TestCase):
    def test_prose_untaxed(self):
        self.assertEqual(length_penalty(700), 1.0)
        self.assertEqual(length_penalty(2000), 1.0)

    def test_documents_sink_softly(self):
        mid = length_penalty(5000)
        huge = length_penalty(43000)
        self.assertLess(mid, 1.0)
        self.assertLess(huge, mid)
        self.assertGreaterEqual(huge, 0.2)

    def test_floor_respected(self):
        self.assertGreaterEqual(length_penalty(500000), 0.2)


class ParityTests(unittest.TestCase):
    """The vectorized (numpy) path must reproduce the Python-loop reference:
    same similarities, same scoring, same ordering."""

    COUNT = 40
    _LCG_A = 6364136223846793005
    _LCG_C = 1442695040888963407

    def _seeded_vec(self, seed: int, dim: int) -> list[float]:
        """Deterministic pseudo-random vector in the store's real dimension."""
        values, state = [], seed
        for _ in range(dim):
            state = (state * self._LCG_A + self._LCG_C) % (1 << 64)
            values.append((state >> 11) / float(1 << 53) - 0.5)
        return values

    def setUp(self):
        try:
            import sqlite_vec  # noqa: F401
        except ImportError:
            self.skipTest("sqlite_vec unavailable in this environment")
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "n.db")
        if not self.store.vec_available:
            self.skipTest("vec unavailable (embeddings disabled or extension missing)")

        from memory_store.store import EMBEDDING_DIM

        self.dim = EMBEDDING_DIM

        # Writes take the no-vec path so no real-model embed fires; the vec0
        # tables are then hand-seeded with the stub vectors (the pattern the
        # StoredVectorTests use).
        self.store.vec_available = False
        self.contents: dict[str, str] = {}
        for i in range(self.COUNT):
            row_id = f"row{i}"
            if i % 2:
                self.store.upsert_episodic(
                    {
                        "id": row_id,
                        "content": f"consolidated summary number {i}",
                        "source": "hub",
                        "repo": "example" if i % 4 == 1 else "actions",
                        "origin": "consolidated",
                        "app": "memory-store",
                    }
                )
            else:
                self.store.upsert_capture(
                    {
                        "id": row_id,
                        "content": f"deliberate decision number {i}",
                        "source": "rule" if i % 8 == 0 else "fact",
                        "repo": "example" if i % 4 == 0 else "actions",
                        "origin": "deliberate",
                        "app": "opencode",
                    }
                )
            content = (
                f"deliberate decision number {i}"
                if not i % 2
                else f"consolidated summary number {i}"
            )
            self.contents[content] = row_id
        self.vectors: dict[str, list[float]] = {
            content: self._seeded_vec(1000 + i, self.dim)
            for i, (content, _) in enumerate(sorted(self.contents.items()))
        }
        self.store.vec_available = True
        for table, kind in (("vec_working", "working"), ("vec_episodes", "episodic")):
            rows = self.store.conn.execute(
                f"SELECT rowid, content, {'repo' if kind == 'working' else 'id'} AS probe"
                f" FROM {'working_memory' if kind == 'working' else 'episodic_memory'}"
            ).fetchall()
            for row in rows:
                self.store._vec_insert(table, row["rowid"], self.vectors[row["content"]])

    def tearDown(self):
        self.store.close()

    def _reference(self, prompt_vec):
        """Mirror of the pre-change Python loop over the built pool."""
        from memory_store.nudge import length_penalty, pool_query

        def cosine(a, b):
            dot = sum(x * y for x, y in zip(a, b, strict=True))
            na = math.sqrt(sum(x * x for x in a))
            nb = math.sqrt(sum(x * x for x in b))
            return dot / (na * nb) if na and nb else 0.0

        pool = pool_query(self.store)
        scored = []
        for row in pool:
            vec = self.vectors.get(row["content"])
            if vec is None:
                continue
            score = cosine(prompt_vec, vec)
            if row.get("workspace_match"):
                score += 0.15
            if row.get("source") == "rule":
                score += 0.10
            score *= length_penalty(len(row["content"]))
            if row["tier"] == "episodic":
                score *= 0.85
            if score >= 0.1:
                scored.append((row["id"], score))
        scored.sort(key=lambda p: p[1], reverse=True)
        return scored

    def _nudge_with(self, module_numpy, prompt, prompt_vec):
        from memory_store import nudge as nudge_module

        def embed(texts, origin=None):
            return [prompt_vec if t == prompt else self.vectors[t] for t in texts]

        with (
            mock.patch.object(self.store, "embed", side_effect=embed),
            mock.patch.object(nudge_module, "numpy", module_numpy),
        ):
            return nudge_score(self.store, prompt, score_threshold=0.1)

    def _assert_matches(self, result, reference):
        ids = [r["id"] for r in result]
        self.assertTrue(ids)
        self.assertEqual(ids, [row_id for row_id, _ in reference])
        for row, (_, ref_score) in zip(result, reference, strict=True):
            self.assertAlmostEqual(row["score"], round(ref_score, 4), places=3)

    def test_vectorized_matches_loop_and_reference(self):
        prompt = "a probe prompt unlike anything stored"
        prompt_vec = self._seeded_vec(777, self.dim)
        reference = self._reference(prompt_vec)

        def embed(texts, origin=None):
            return [prompt_vec if t == prompt else self.vectors[t] for t in texts]

        with mock.patch.object(self.store, "embed", side_effect=embed):
            fast = nudge_score(  # module numpy untouched: vectorized path
                self.store, prompt, score_threshold=0.1
            )
        loop = self._nudge_with(None, prompt, prompt_vec)

        for result in (fast, loop):
            self._assert_matches(result, reference)


if __name__ == "__main__":
    unittest.main()
