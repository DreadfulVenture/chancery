"""Tests for the lifted explicit-recall scorer."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.recall import (
    explicit_recall,
    fts_query_terms,
    lexical_relevance,
    recall_tokens,
)
from memory_store.store import Store


class TokenizerTests(unittest.TestCase):
    def test_stopwords_excluded(self):
        toks = recall_tokens("what is the gateway unit ownership decision")
        self.assertNotIn("what", toks)
        self.assertNotIn("the", toks)
        self.assertIn("gateway", toks)

    def test_snake_case_paths_stay_tokenized(self):
        toks = recall_tokens("nix/hosts/hub gateway")
        self.assertIn("nix/hosts/hub", toks)
        self.assertIn("gateway", toks)

    def test_fts_terms_quoted(self):
        terms = fts_query_terms('the "gateway" unit')
        self.assertTrue(all(t.startswith('"') and t.endswith('"') for t in terms))
        self.assertNotIn('"the"', terms)


class LexicalRelevanceTests(unittest.TestCase):
    def test_no_overlap_is_zero(self):
        self.assertEqual(
            lexical_relevance(recall_tokens("zebra"), "unrelated content entirely"), 0.0
        )

    def test_exact_token_match(self):
        score = lexical_relevance(
            recall_tokens("gateway ownership"), "the gateway unit is owned by a client host"
        )
        self.assertGreater(score, 0)

    def test_full_query_substring_scores_highest(self):
        score = lexical_relevance(
            recall_tokens("gateway ownership"), "we discussed gateway ownership yesterday"
        )
        self.assertGreater(score, 0.9)

    def test_snake_case_content_expands(self):
        score = lexical_relevance(
            recall_tokens("telemetry latency"),
            "the telemetry_api_latency_ms metric is exported",
        )
        self.assertGreater(score, 0)


class ExplicitRecallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "r.db")
        self.store.upsert_capture(
            {
                "id": "c1",
                "content": "[USER] the gateway unit ownership decision",
                "source": "cursor:example:ses_a",
                "session_id": "ses_a",
            }
        )
        self.store.upsert_capture(
            {
                "id": "c2",
                "content": "[AGENT] more about gateway ownership later",
                "source": "cursor:example:ses_a",
                "session_id": "ses_a",
            }
        )
        self.store.upsert_capture(
            {
                "id": "c3",
                "content": "[USER] unrelated deployment question",
                "source": "cursor:example:ses_b",
                "session_id": "ses_b",
            }
        )
        self.store.upsert_capture(
            {
                "id": "c4",
                "content": "[USER] another gateway ownership angle in the transcript",
                "source": "cursor:example:ses_a",
                "session_id": "ses_a",
            }
        )
        self.store.upsert_capture(
            {
                "id": "f1",
                "content": "[USER] <chat-history-summary> gateway ownership was debated at length. "
                + "filler " * 2000,
                "source": "cursor:example:ses_a",
                "session_id": "ses_a",
                "kind": "fork_summary",
            }
        )
        self.store.upsert_episodic(
            {
                "id": "e1",
                "content": "Session covered gateway unit ownership and drop-ins",
                "source": "hub",
                "summary_of": "ses_a",
            }
        )

    def tearDown(self):
        self.store.close()

    def test_recall_finds_matching_rows(self):
        results = explicit_recall(self.store, "gateway ownership", limit=5)
        self.assertGreater(len(results), 0)
        sources = [r["content"] for r in results]
        self.assertTrue(any("gateway" in c for c in sources))

    def test_recall_returns_judged_rows_only(self):
        """Raw captures — speech and fork summaries alike — are never
        content results (ADR 20260926-recall-judged-rows)."""
        results = explicit_recall(self.store, "gateway ownership", limit=12)
        ids = [r["id"] for r in results]
        for capture_id in ("c1", "c2", "c3", "c4", "f1"):
            self.assertNotIn(capture_id, ids)
        self.assertIn("e1", ids)

    def test_episodic_rows_carry_source_conversation(self):
        results = explicit_recall(self.store, "gateway ownership", limit=5)
        e1 = next(r for r in results if r["id"] == "e1")
        self.assertEqual(e1["source_conversation"]["session_id"], "ses_a")
        self.assertEqual(e1["source_conversation"]["capture_count"], 4)

    def test_conversation_grouping_removed(self):
        """Deliberate rows all return: the grouping block existed to stop
        one session's raw turns flooding results, and with captures excluded
        from recall it is gone — a session's deliberate rows are never
        dropped for sharing a session id."""
        for n in range(4):
            self.store.upsert_capture(
                {
                    "id": f"d{n}",
                    "content": f"deliberate note about gateway ownership {n}",
                    "kind": "speech",
                    "source": "insight",
                    "origin": "deliberate",
                    "session_id": "default",
                }
            )
        results = explicit_recall(self.store, "gateway ownership", limit=12)
        ids = [r["id"] for r in results]
        for n in range(4):
            self.assertIn(f"d{n}", ids)

    def test_empty_query_returns_nothing(self):
        self.assertEqual(explicit_recall(self.store, "the of and", limit=5), [])

    def test_workspace_scoped_recall_over_episodic_rows(self):
        """Regression: the episodic leg fetched rows without the `repo`
        column while the workspace boost reads `row["repo"]` — every
        workspace-scoped recall touching an episodic FTS hit crashed with
        IndexError ("No item with that key"). The working leg always
        selected repo, which is why only scoped recalls died."""
        results = explicit_recall(self.store, "gateway ownership", limit=5, workspace="example")
        episodic = [r for r in results if r["tier"] == "episodic"]
        self.assertTrue(episodic, "episodic hit must recall under a workspace")

    def test_workspace_boost_prefers_same_repo(self):
        results = explicit_recall(self.store, "gateway ownership", limit=5, workspace="example")
        for row in results:
            self.assertIn("score", row)


class SingleEpisodicVecTests(unittest.TestCase):
    """The vec0 single-rowid knn regression: `rowid IN (?)` with one
    placeholder is rejected by vec0 ("A LIMIT or 'k = ?' constraint is
    required") — recall hard-failed whenever FTS returned exactly one
    episodic hit on a vec-capable store. The padded form must succeed.
    Skipped where sqlite_vec is unavailable (bare devshell python3);
    runs against the real extension under the daemon's venv."""

    def test_single_episodic_hit_recalls(self):
        try:
            import sqlite_vec  # noqa: F401
        except ImportError:
            self.skipTest("sqlite_vec unavailable in this environment")

        from unittest import mock

        from memory_store.store import EMBEDDING_DIM

        tmp = tempfile.mkdtemp()
        store = Store(Path(tmp) / "one.db")
        try:
            # Also skips under MEMORY_DISABLE_EMBEDDINGS=1, which is the
            # legitimate way to run this suite hermetically.
            if not store.vec_available:
                self.skipTest("vec unavailable (embeddings disabled or extension missing)")
            with mock.patch.object(Store, "embed", return_value=[[0.1] * EMBEDDING_DIM]):
                store.upsert_episodic(
                    {"id": "e1", "content": "gateway unit ownership decision", "source": "hub"}
                )
                # The query FTS-matches exactly one episodic row, producing
                # the degenerate single-rowid IN list.
                results = explicit_recall(store, "gateway ownership", limit=5)
            self.assertIn(
                "e1",
                [r["id"] for r in results if r["tier"] == "episodic"],
                "the single episodic row must recall cleanly",
            )
        finally:
            store.close()


class AgentMemoryRecallTests(unittest.TestCase):
    """The deliberate home's leg: agent_memory rows recall with the exact
    result contract, the registry join rendering the drill key the pointer
    surfaces carry."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "r.db")
        session = self.store.get_or_create_session("hal", "opencode", "ses_gw", project="example")
        self.store.upsert_agent(
            {
                "id": "m1",
                "session_id": session,
                "content": "the gateway unit ownership decision",
                "source": "insight",
                "timestamp": "2026-11-04T00:00:00Z",
                "importance": 0.7,
                "veracity": "verified",
                "author_id": "hal",
                "author_type": "human",
                "kind": "speech",
                "repo": "example",
                "app": "opencode",
            }
        )
        # The captured turn the provenance chain reaches, mirrored under
        # the same registry row the agent write resolved.
        self.store.upsert_capture(
            {
                "id": "c1",
                "content": "[USER] what owns the gateway?",
                "source": "cursor:example:ses_gw",
                "session_id": "ses_gw",
                "captured_by": "hal",
            }
        )
        self.store.record_capture_turn(
            {
                "id": "c1",
                "content": "[USER] what owns the gateway?",
                "timestamp": "2026-11-04T00:00:00Z",
                "session_id": "ses_gw",
                "kind": "speech",
                "repo": "example",
                "origin": "capture",
                "app": "opencode",
                "captured_by": "hal",
                "author_type": "human",
            }
        )

    def tearDown(self):
        self.store.close()

    def test_agent_rows_recall_with_the_contract_shape(self):
        results = explicit_recall(self.store, "gateway ownership", limit=5)
        hit = next(r for r in results if r["id"] == "m1")
        self.assertEqual(
            sorted(hit),
            sorted(
                (
                    "id",
                    "content",
                    "source",
                    "timestamp",
                    "session_id",
                    "tier",
                    "kind",
                    "author_id",
                    "author_type",
                    "veracity",
                    "importance",
                    "score",
                    "lexical",
                )
            ),
        )
        self.assertEqual(hit["tier"], "working")
        self.assertEqual(hit["session_id"], "ses_gw")
        self.assertEqual(hit["source"], "insight")
        self.assertEqual(hit["veracity"], "verified")
        self.assertEqual(hit["kind"], "speech")

    def test_the_provenance_chain_walks_to_captured_turns(self):
        agent_row = self.store.agent_row("m1")
        chain = self.store.conn.execute(
            """SELECT s.client_conversation_id AS conversation,
                      (SELECT COUNT(*) FROM session_history h WHERE h.session_id = s.id) AS turns
               FROM session s WHERE s.id = ?""",
            (agent_row["session_id"],),
        ).fetchone()
        self.assertEqual(chain["conversation"], "ses_gw")
        self.assertEqual(chain["turns"], 1)


if __name__ == "__main__":
    unittest.main()
