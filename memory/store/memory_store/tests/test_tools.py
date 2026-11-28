"""Tests for the tool surface: gate enforcement and budget surfacing,
write-time similarity warning (ADR 20260926-write-dedup), and the dedup
cycle (find_duplicates + verdicts)."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.store import EMBEDDING_DIM, Store
from memory_store.tools import MAX_MEMORY_CHARS, TOOL_DEFINITIONS, ToolError, Tools


def stub_repo(name):
    """Patch detect_repo to a fixed name so tests don't touch the filesystem."""
    return mock.patch("memory_store.tools.detect_repo", return_value=name)


class RememberTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.tools = Tools(Store(Path(self.tmp) / "t.db"), "testbox")

    def tearDown(self):
        self.tools.store.close()

    def test_remember_compound_source(self):
        with stub_repo("example"):
            result = self.tools.memory_remember(
                app="test",
                content="deploy-dev enforces pr-<number> branch names",
                source="convention",
                cwd="/tmp/opencode/some-worktree",
            )
        self.assertEqual(result["source"], "convention")
        self.assertEqual(result["repo"], "example")

    def test_remember_past_the_injection_budget_says_so(self):
        # Consolidating duplicates is what pushes rows over, and the loss
        # happens on every later recall rather than on this call.
        result = self.tools.memory_remember(app="test", content="x" * 1500, source="insight")
        self.assertEqual(result["over_budget"], {"chars": 1500, "budget": MAX_MEMORY_CHARS})
        self.assertIn("drop the middle", result["hint"])

    def test_remember_within_budget_is_silent(self):
        result = self.tools.memory_remember(app="test", content="x" * 900, source="insight")
        self.assertNotIn("over_budget", result)
        self.assertNotIn("hint", result)

    def test_remember_rejects_unknown_label(self):
        with self.assertRaises(ToolError):
            self.tools.memory_remember(app="test", content="x", source="vibes")

    def test_a_remembered_row_moves_the_deliberate_watermark(self):
        """deliberate_writes counts rows newer than a watermark, and counts
        them of timestamp. An unstamped row is invisible there, so a writer
        keyed on the watermark would not see the row it asked for."""
        self.tools.memory_remember(app="test", content="an earlier finding", source="insight")
        baseline = self.tools.store.deliberate_writes()["watermark"]
        self.assertTrue(baseline, "a stored row has to move the watermark off empty")
        self.tools.memory_remember(app="test", content="a durable finding", source="insight")
        after = self.tools.store.deliberate_writes(baseline)
        self.assertEqual(after["count"], 1)
        self.assertGreater(after["watermark"], baseline)

    def test_forget_tombstoned_then_get_reports_tombstone(self):
        with stub_repo("example"):
            created = self.tools.memory_remember(app="test", content="temp fact", source="fact")
        self.tools.memory_forget(table="working_memory", id=created["id"])
        row = self.tools.store.conn.execute(
            "SELECT 1 FROM working_memory WHERE id = ?", (created["id"],)
        ).fetchone()
        self.assertIsNone(row)
        result = self.tools.memory_get(id=created["id"])
        self.assertFalse(result["found"])
        self.assertTrue(result["tombstoned"])

    def test_forget_reaches_memory_tables_only(self):
        """Each other domain removes its own rows (ADR
        20261110-commands-grouped-by-domain); the refusal points there."""
        for table, owner in (
            ("tool_rules", "tool_rule_remove"),
            ("situational_rules", "rule_forget"),
            ("persona_rules", "persona_update"),
        ):
            with self.subTest(table=table), self.assertRaisesRegex(ToolError, owner):
                self.tools.memory_forget(table=table, id="1")
            self.assertFalse(self.tools.store.is_tombstoned(table, "1"))
        with self.assertRaisesRegex(ToolError, "unsupported table"):
            self.tools.memory_forget(table="session", id="1")

    def test_forget_schema_lists_the_memory_tables(self):
        schema = next(d for d in TOOL_DEFINITIONS if d["name"] == "memory_forget")
        self.assertEqual(
            schema["input_schema"]["properties"]["table"]["enum"],
            ["working_memory", "agent_memory", "episodic_memory"],
        )


class SimilarityWarningTests(unittest.TestCase):
    """Write-time similarity warning (ADR 20260926-write-dedup): warn-only,
    thatch-mirror. Stub vector space encodes marker words.

    Vector = counts over a fixed vocabulary padded to EMBEDDING_DIM so
    cosine is predictable: [deploy, commit, gateway, zebra]. The real vec0
    tables hold the pool (StoredVectorTests pattern): writes take the
    no-vec path (vec_available=False during the upsert), then the tables
    are seeded with stub-space vectors by hand and vec_available is flipped
    on for the scoring path."""

    VOCAB = ["deploy", "commit", "gateway", "zebra"]

    def _vec(self, text):
        low = text.lower()
        return [float(low.count(w)) for w in self.VOCAB] + [0.0] * (EMBEDDING_DIM - 4)

    def setUp(self):
        try:
            import sqlite_vec  # noqa: F401
        except ImportError:
            self.skipTest("sqlite_vec unavailable in this environment")
        # StoredVectorTests pattern: every embed below is stubbed, so this
        # suite needs vec0 but never the model. MEMORY_DISABLE_EMBEDDINGS
        # turns off both, so a hermetic run would skip the whole suite.
        self._embeddings_disabled = os.environ.pop("MEMORY_DISABLE_EMBEDDINGS", None)
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "t.db")
        if not self.store.vec_available:
            self.skipTest("vec extension failed to load")
        self.tools = Tools(self.store, "testbox")
        with mock.patch.object(
            self.store,
            "embed",
            side_effect=lambda texts, origin=None: [self._vec(t) for t in texts],
        ):
            with stub_repo("example"):
                self.first = self.tools.memory_remember(
                    app="test",
                    content="never deploy without the deploy word from the operator",
                    source="correction",
                )
            for row in self.store.conn.execute(
                "SELECT rowid, content FROM working_memory"
            ).fetchall():
                self.store._vec_delete("vec_working", row["rowid"])
                self.store._vec_insert("vec_working", row["rowid"], self._vec(row["content"]))

    def tearDown(self):
        self.store.close()
        if self._embeddings_disabled is not None:
            os.environ["MEMORY_DISABLE_EMBEDDINGS"] = self._embeddings_disabled

    def _remember(self, content, **kwargs):
        with mock.patch.object(
            self.store,
            "embed",
            side_effect=lambda texts, origin=None: [self._vec(t) for t in texts],
        ):
            with stub_repo("example"):
                return self.tools.memory_remember(app="test", content=content, **kwargs)

    def test_warn_only_write_always_succeeds(self):
        result = self._remember(
            "never deploy without the deploy word from the operator, verbatim repeat",
            source="correction",
        )
        self.assertEqual(result["status"], "ok")
        self.assertNotEqual(result["id"], self.first["id"])
        self.assertTrue(result["similar_to"])
        self.assertEqual(result["similar_to"][0]["id"], self.first["id"])
        self.assertIn("hint", result)

    def test_fresh_content_gets_no_warning(self):
        result = self._remember("zebra photography is a hobby", source="fact")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["similar_to"], [])
        self.assertNotIn("hint", result)

    def test_self_exclusion(self):
        # The exact same content re-remembered: similar_to must list the
        # OLD row, never the new one itself.
        result = self._remember("never deploy without the deploy word from the operator")
        for hit in result["similar_to"]:
            self.assertNotEqual(hit["id"], result["id"])

    def test_top_three_cap(self):
        for _ in range(4):
            self._remember(
                "never deploy without the deploy word from the operator, copy "
                + str(len(self.VOCAB)),
                source="correction",
            )
        result = self._remember(
            "never deploy without the deploy word from the operator, one more copy",
            source="correction",
        )
        self.assertEqual(len(result["similar_to"]), 3)

    def test_scores_sorted_strongest_first(self):
        result = self._remember(
            "never deploy without the deploy word from the operator, sorted check",
            source="correction",
        )
        scores = [hit["score"] for hit in result["similar_to"]]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_hermetic_mode_returns_empty_without_exception(self):
        # Hermetic shape check: a store with vec off (as under
        # MEMORY_DISABLE_EMBEDDINGS) must return [] and not raise.
        tmp2 = tempfile.mkdtemp()
        with mock.patch.dict("os.environ", {"MEMORY_DISABLE_EMBEDDINGS": "1"}):
            hermetic = Store(Path(tmp2) / "h.db")
        try:
            tools = Tools(hermetic, "testbox")
            result = tools.memory_remember(app="test", content="anything at all", source="fact")
            self.assertEqual(result["similar_to"], [])
        finally:
            hermetic.close()

    def test_regression_twelfth_duplicate_sees_the_cluster(self):
        # The ADR's regression anchor: the twelfth write of one boundary
        # sees previous writes flagged. (Top-3 of the whole cluster.)
        for i in range(11):
            self._remember(
                f"never deploy without the deploy word from the operator, take {i}",
                source="correction",
            )
        result = self._remember(
            "never deploy without the deploy word from the operator, final form",
            source="correction",
        )
        self.assertEqual(len(result["similar_to"]), 3)
        self.assertGreater(result["similar_to"][0]["score"], 0.85)

    def test_remember_check_hits_the_write_embed_via_cache(self):
        # The remember-check embed is a sha256 cache hit against the vector
        # the upsert just stored. Observable at the embedder boundary (below
        # store.embed's cache) — mocking store.embed would bypass the cache
        # (CachedEmbedTests pattern from test_nudge.py: real store.embed,
        # counting model underneath). The store-wide contract is pinned in
        # test_nudge; this pins the warning path's economics specifically:
        # one write, then the remember-check costs zero model inference.

        content = "never deploy without the deploy word from the operator"
        calls: list[str] = []

        class CountingEmbedder:
            def embed(self, texts, origin=None):
                lists = list(texts)
                calls.extend(lists)
                # Real fastembed yields numpy-like vectors (store.embed calls
                # .tolist()); returning plain lists mimics them closely
                # enough here, but store.embed calls .tolist() on each —
                # so wrap in a type that carries one.
                return [_ListVector(self._vec(t)) for t in lists]

        class _ListVector(list):
            def tolist(self):
                return list(self)

        embedder = CountingEmbedder()
        embedder._vec = self._vec

        with (
            mock.patch("fastembed.TextEmbedding", return_value=embedder),
            stub_repo("example"),
        ):
            self.tools.memory_remember(app="test", content=content, source="correction")
        # Up to this point: upsert-capture + remember-check + pool — all
        # through the real store.embed with its cache. Distinct contents
        # infer once each; identical content must not reappear.
        self.assertEqual(calls.count(content), 1)
        # The second remember-check with identical content must be served
        # from the cache: no new model call for that text.
        self.tools.memory_remember(
            app="test", content=content + " verbatim repeat", source="correction"
        )
        # The new content differs, so it embeds once (upsert + check share
        # the cache); the OLD content is only ever seen if pool fallback
        # runs — the stored vector already exists, so it must not.
        self.assertEqual(calls.count(content), 1)


class DedupCycleTests(unittest.TestCase):
    """find_duplicates + verdicts (ADR 20260926-write-dedup companion).

    Same seeding pattern as SimilarityWarningTests: writes take the no-vec
    path, then vec0 tables are seeded with stub vectors and flipped on."""

    VOCAB = ["deploy", "commit", "gateway", "zebra"]

    def _vec(self, text):
        low = text.lower()
        return [float(low.count(w)) for w in self.VOCAB] + [0.0] * (EMBEDDING_DIM - 4)

    def setUp(self):
        try:
            import sqlite_vec  # noqa: F401
        except ImportError:
            self.skipTest("sqlite_vec unavailable in this environment")
        # StoredVectorTests pattern: every embed below is stubbed, so this
        # suite needs vec0 but never the model. MEMORY_DISABLE_EMBEDDINGS
        # turns off both, so a hermetic run would skip the whole suite.
        self._embeddings_disabled = os.environ.pop("MEMORY_DISABLE_EMBEDDINGS", None)
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "t.db")
        if not self.store.vec_available:
            self.skipTest("vec extension failed to load")
        self.tools = Tools(self.store, "testbox")

    def tearDown(self):
        self.store.close()
        if self._embeddings_disabled is not None:
            os.environ["MEMORY_DISABLE_EMBEDDINGS"] = self._embeddings_disabled

    def _stub_embed(self):
        """Every write in this suite goes through here: an unstubbed one
        builds the real model, which downloads on a cold cache."""
        return mock.patch.object(
            self.store,
            "embed",
            side_effect=lambda texts, origin=None: [self._vec(t) for t in texts],
        )

    def _remember(self, content, source="correction"):
        with self._stub_embed():
            with stub_repo("example"):
                result = self.tools.memory_remember(app="test", content=content, source=source)
        # Seed the new row's vector by hand, replacing whatever the write
        # path stored (full mode embeds for real; the stub space must win).
        with self._stub_embed():
            row = self.store.conn.execute(
                "SELECT rowid FROM agent_memory WHERE id = ?", (result["id"],)
            ).fetchone()
            self.store._vec_delete("vec_agent", row["rowid"])
            self.store._vec_insert("vec_agent", row["rowid"], self._vec(content))
        return result

    def test_pairs_and_clusters(self):
        self._remember("deploy needs the deploy word from the operator, a")
        self._remember("deploy needs the deploy word from the operator, b")
        self._remember("deploy needs the deploy word from the operator, c")
        self._remember("zebra crossing photography", source="fact")
        result = self.tools.memory_find_duplicates()
        pair_ids = {(p["a"], p["b"]) for p in result["pairs"]}
        self.assertTrue(pair_ids)
        cluster = next(iter(result["clusters"]))
        self.assertEqual(len(cluster), 3)
        self.assertEqual(cluster, sorted(cluster))

    def test_clusters_ignore_the_pair_limit(self):
        # Clusters are built from every pair above threshold. Grouping the
        # truncated page instead makes membership depend on where the cut
        # landed: 4 mutual duplicates are 6 pairs, so limit=1 would leave a
        # 2-member component and no cluster at all.
        for tag in "abcd":
            self._remember(f"deploy needs the deploy word from the operator, {tag}")
        result = self.tools.memory_find_duplicates(limit=1)
        self.assertEqual(len(result["pairs"]), 1)
        self.assertEqual([len(c) for c in result["clusters"]], [4])

    def test_verdict_marked_pairs_stop_flagging(self):
        a = self._remember("deploy needs the deploy word, first")
        b = self._remember("deploy needs the deploy word, second")
        self.assertTrue(self.tools.memory_find_duplicates()["pairs"])
        self.tools.memory_mark_checked(
            a=a["id"], b=b["id"], verdict="duplicate", grounds="same ruling twice"
        )
        remaining = self.tools.memory_find_duplicates()["pairs"]
        for pair in remaining:
            self.assertNotEqual(
                tuple(sorted((pair["a"], pair["b"]))),
                tuple(sorted((a["id"], b["id"]))),
            )

    def test_verdicts_clear_on_member_update(self):
        a = self._remember("deploy needs the deploy word, alpha")
        b = self._remember("deploy needs the deploy word, beta")
        self.tools.memory_mark_checked(a=a["id"], b=b["id"], verdict="supplement")
        with self._stub_embed():
            self.tools.memory_update(id=b["id"], content="zebra photography, unrelated now")
        # The old pair may re-flag only via genuinely new similarity; the
        # verdict row itself must be gone.
        verdicts = self.store.conn.execute("SELECT * FROM dedup_verdicts").fetchall()
        self.assertEqual(len(verdicts), 0)

    def test_verdicts_clear_on_member_forget(self):
        a = self._remember("deploy needs the deploy word, one")
        b = self._remember("deploy needs the deploy word, two")
        self.tools.memory_mark_checked(a=a["id"], b=b["id"], verdict="unrelated")
        self.tools.memory_forget(table="working_memory", id=a["id"])
        verdicts = self.store.conn.execute("SELECT * FROM dedup_verdicts").fetchall()
        self.assertEqual(len(verdicts), 0)

    def test_mark_checked_rejects_bad_verdict_and_missing_rows(self):
        a = self._remember("deploy needs the deploy word, x")
        b = self._remember("deploy needs the deploy word, y")
        with self.assertRaises(ToolError):
            self.tools.memory_mark_checked(a=a["id"], b=b["id"], verdict="same")
        with self.assertRaises(ToolError):
            self.tools.memory_mark_checked(a="m_nothere", b=b["id"], verdict="duplicate")
        with self.assertRaises(ToolError):
            self.tools.memory_mark_checked(a=a["id"], b=a["id"], verdict="duplicate")

    def test_hermetic_mode_returns_empty(self):
        # Hermetic shape check: MEMORY_DISABLE_EMBEDDINGS store → [] and
        # no raise.
        tmp2 = tempfile.mkdtemp()
        with mock.patch.dict("os.environ", {"MEMORY_DISABLE_EMBEDDINGS": "1"}):
            hermetic = Store(Path(tmp2) / "h.db")
        try:
            result = Tools(hermetic, "testbox").memory_find_duplicates()
            self.assertEqual(result["pairs"], [])
            self.assertEqual(result["clusters"], [])
        finally:
            hermetic.close()


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.tools = Tools(Store(Path(self.tmp) / "t.db"), "testbox")
        with stub_repo("example"):
            self.created = self.tools.memory_remember(
                app="test",
                content="The operator prefers branches prefixed with operator/",
                source="preference",
                importance=0.7,
                cwd="/tmp/opencode/some-worktree",
            )
        self.setup_session_id = self._row()["session_id"]

    def tearDown(self):
        self.tools.store.close()

    def _row(self):
        return self.tools.store.conn.execute(
            "SELECT * FROM agent_memory WHERE id = ?", (self.created["id"],)
        ).fetchone()

    def test_update_past_the_injection_budget_says_so(self):
        result = self.tools.memory_update(id=self.created["id"], content="x" * 1500)
        self.assertEqual(result["over_budget"], {"chars": 1500, "budget": MAX_MEMORY_CHARS})
        self.assertIn("drop the middle", result["hint"])

    def test_update_within_budget_is_silent(self):
        result = self.tools.memory_update(id=self.created["id"], content="x" * 900)
        self.assertNotIn("over_budget", result)
        self.assertNotIn("hint", result)

    def test_an_episodic_id_is_sent_to_forget_instead(self):
        """Recall hands out both tiers under one correction instruction, so
        this is the caller following it without reading the tier. A summary
        is not edited: the text would stop being what the turns produced."""
        self.tools.store.upsert_episodic(
            {
                "id": "ep1",
                "content": "the user decided to ship it",
                "source": "sleep_consolidation",
                "summary_of": "ses_a",
            }
        )
        with self.assertRaises(ToolError) as refused:
            self.tools.memory_update(id="ep1", content="the agent proposed shipping it")
        self.assertIn("episodic summary", str(refused.exception))
        self.assertIn("memory_forget", str(refused.exception))
        self.assertEqual(
            self.tools.store.conn.execute(
                "SELECT content FROM episodic_memory WHERE id = 'ep1'"
            ).fetchone()["content"],
            "the user decided to ship it",
        )

    def test_an_id_in_neither_tier_still_says_not_found(self):
        with self.assertRaises(ToolError) as refused:
            self.tools.memory_update(id="nope", content="x")
        self.assertIn("no working memory", str(refused.exception))

    def test_content_edit_keeps_the_id(self):
        result = self.tools.memory_update(
            id=self.created["id"],
            content="The operator prefers branches prefixed with operator/, lowercase",
        )
        self.assertEqual(result["id"], self.created["id"])
        self.assertEqual(
            self._row()["content"],
            "The operator prefers branches prefixed with operator/, lowercase",
        )
        self.assertEqual(
            self.tools.store.conn.execute("SELECT COUNT(*) AS n FROM agent_memory").fetchone()["n"],
            1,
        )

    def test_edit_preserves_untouched_provenance(self):
        self.tools.memory_update(id=self.created["id"], content="reworded")
        row = self._row()
        self.assertEqual(row["repo"], "example")
        self.assertEqual(row["session_id"], self.setup_session_id)
        self.assertEqual(row["source"], "preference")
        self.assertEqual(row["importance"], 0.7)

    def test_field_only_edit_is_not_swallowed_as_a_replay(self):
        self.tools.memory_update(id=self.created["id"], importance=0.9, veracity="stated")
        row = self._row()
        self.assertEqual(row["importance"], 0.9)
        self.assertEqual(row["veracity"], "stated")

    def test_relabel(self):
        self.tools.memory_update(id=self.created["id"], source="convention")
        self.assertEqual(self._row()["source"], "convention")

    def test_rejects_unknown_label(self):
        with self.assertRaises(ToolError):
            self.tools.memory_update(id=self.created["id"], source="vibes")

    def test_rejects_empty_content(self):
        with self.assertRaises(ToolError):
            self.tools.memory_update(id=self.created["id"], content="   ")

    def test_rejects_empty_edit(self):
        with self.assertRaises(ToolError):
            self.tools.memory_update(id=self.created["id"])

    def test_rejects_unknown_row(self):
        with self.assertRaises(ToolError):
            self.tools.memory_update(id="mffff000000000000", content="x")


class GetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.tools = Tools(Store(Path(self.tmp) / "t.db"), "testbox")

    def tearDown(self):
        self.tools.store.close()

    def _insert_episodic(self, content):
        self.tools.store.conn.execute(
            """INSERT INTO episodic_memory
                   (id, content, source, timestamp, session_id, importance,
                    veracity, created_at, repo, origin, app)
               VALUES ('ep17d6a30000test00', ?, 'summary',
                       '2026-09-19T00:00:00Z', 'default', 0.6, 'tool',
                       '2026-09-19 00:00:00', 'example', 'consolidated',
                       'memory-store')""",
            (content,),
        )
        self.tools.store.conn.commit()

    def test_get_returns_full_deliberate_row(self):
        with stub_repo("example"):
            created = self.tools.memory_remember(
                app="test",
                content="deploy-dev branch rule",
                source="convention",
                importance=0.8,
                cwd="/tmp/opencode/some-worktree",
            )
        result = self.tools.memory_get(id=created["id"])
        self.assertTrue(result["found"])
        self.assertEqual(result["table"], "agent_memory")
        record = result["record"]
        self.assertEqual(record["content"], "deploy-dev branch rule")
        self.assertEqual(record["source"], "convention")
        self.assertEqual(record["importance"], 0.8)
        self.assertEqual(record["repo"], "example")

    def test_get_routes_episodic_by_prefix(self):
        self._insert_episodic("folder resembles the arc of a session")
        result = self.tools.memory_get(id="ep17d6a30000test00")
        self.assertTrue(result["found"])
        self.assertEqual(result["table"], "episodic_memory")
        self.assertEqual(result["record"]["content"], "folder resembles the arc of a session")

    def test_get_table_override(self):
        with stub_repo("example"):
            created = self.tools.memory_remember(app="test", content="x", source="fact")
        result = self.tools.memory_get(id=created["id"], table="agent_memory")
        self.assertTrue(result["found"])

    def test_get_unknown_id_reports_not_found(self):
        result = self.tools.memory_get(id="mffff000000000000")
        self.assertFalse(result["found"])
        self.assertFalse(result["tombstoned"])

    def test_get_rejects_missing_id_and_bad_table(self):
        with self.assertRaises(ToolError):
            self.tools.memory_get()
        with self.assertRaises(ToolError):
            self.tools.memory_get(id="m1", table="persona_rules")


class PersonaFloorTests(unittest.TestCase):
    STATEMENT = "Answer the question actually asked, first sentence."

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.tools = Tools(Store(Path(self.tmp) / "t.db"), "testbox")
        self.written = self.tools.persona_codify(statement=self.STATEMENT)
        self.rule_id = self.written["id"]

    def tearDown(self):
        self.tools.store.close()

    def _status(self, rule_id):
        return self.tools.store.conn.execute(
            "SELECT status FROM persona_rules WHERE id = ?", (rule_id,)
        ).fetchone()["status"]

    def test_codify_writes_an_active_rule(self):
        self.assertEqual(self.written["status"], "ok")
        self.assertEqual(self._status(self.rule_id), "active")

    def test_codify_requires_a_statement(self):
        with self.assertRaises(ToolError):
            self.tools.persona_codify(statement="   ")

    def test_retire_frees_the_budget(self):
        self.tools.persona_update(rule_id=self.rule_id, status="retired")
        self.assertEqual(self._status(self.rule_id), "retired")
        self.assertEqual(self.tools.store.persona_budget_state()["total"], 0)

    def test_update_rejects_a_status_outside_the_vocabulary(self):
        with self.assertRaises(ValueError):
            self.tools.persona_update(rule_id=self.rule_id, status="proposed_by_someone")

    def test_over_budget_refusal_carries_roster(self):
        big = self.tools.persona_codify(statement="z" * (15000 - len(self.STATEMENT) + 1))
        self.assertEqual(big["status"], "refused")
        self.assertIn("budget_state", big)
        self.assertIn("hint", big)
        self.assertGreater(len(big["budget_state"]["rows"]), 0)

    def test_reword_frees_room_then_the_write_succeeds(self):
        over = self.tools.persona_codify(statement="y" * 15000)
        self.assertEqual(over["status"], "refused")
        # The agent rewords the existing rule down, then retries.
        self.tools.persona_update(rule_id=self.rule_id, statement="Answer first.")
        ok = self.tools.persona_codify(statement="y" * 14000)
        self.assertEqual(ok["status"], "ok")

    def test_an_over_budget_floor_can_still_be_shortened(self):
        # The state a floor imported wholesale arrives in: already over the
        # ceiling, so every write refuses until something gets trimmed.
        self.tools.store.conn.execute(
            "UPDATE persona_rules SET statement = ? WHERE id = ?", ("q" * 15500, self.rule_id)
        )
        self.tools.store.conn.commit()
        self.assertEqual(self.tools.persona_codify(statement="anything")["status"], "refused")
        shorten = self.tools.persona_update(rule_id=self.rule_id, statement="q" * 200)
        self.assertEqual(shorten["status"], "ok")
        self.assertEqual(self.tools.persona_codify(statement="anything")["status"], "ok")


class SituationalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.tools = Tools(Store(Path(self.tmp) / "t.db"), "testbox")

    def tearDown(self):
        self.tools.store.close()

    def test_codify_behavior_vs_prediction(self):
        behavior = self.tools.rule_codify(
            situation="about to commit",
            statement="run checks first",
            grader="agent",
            stance="prescriptive",
        )
        prediction = self.tools.rule_codify(
            situation="reviewing with tech debt",
            statement="flag tech debt before the diff",
            grader="user",
            stance="descriptive",
        )
        rows = {r["id"]: r for r in self.tools.rule_list()["rules"]}
        self.assertEqual(rows[behavior["rule_id"]]["grader"], "agent")
        self.assertEqual(rows[prediction["rule_id"]]["grader"], "user")

    def test_codify_enforces_configured_length_cap(self):
        with mock.patch.dict("os.environ", {"MEMORY_RULE_LENGTH_MAX": "5"}):
            self.tools.rule_codify(
                situation="ab", statement="cde", grader="agent", stance="prescriptive"
            )
            with self.assertRaisesRegex(ToolError, "payload is 6 characters"):
                self.tools.rule_codify(
                    situation="ab", statement="cdef", grader="agent", stance="prescriptive"
                )

    def test_feedback_accumulates(self):
        rule = self.tools.rule_codify(
            situation="s", statement="t", grader="agent", stance="prescriptive"
        )
        self.tools.rule_feedback(rule_id=rule["rule_id"], signal="confirm")
        self.tools.rule_feedback(rule_id=rule["rule_id"], signal="soft", polarity="disconfirm")
        row = self.tools.store.conn.execute(
            "SELECT confirm_count, disconfirm_count FROM situational_rules WHERE id = ?",
            (rule["rule_id"],),
        ).fetchone()
        self.assertEqual(row["confirm_count"], 1.0)
        self.assertEqual(row["disconfirm_count"], 0.25)

    def test_rule_forget_tombstones_the_rule(self):
        rule = self.tools.rule_codify(
            situation="s", statement="t", grader="agent", stance="prescriptive"
        )
        result = self.tools.rule_forget(rule_id=rule["rule_id"])
        self.assertEqual(result["rule_id"], rule["rule_id"])
        self.assertEqual(self.tools.rule_list()["count"], 0)
        self.assertTrue(self.tools.store.is_tombstoned("situational_rules", rule["rule_id"]))
        with self.assertRaisesRegex(ToolError, "no situational rule"):
            self.tools.rule_forget(rule_id=rule["rule_id"])

    def test_rule_forget_accepts_id_alias(self):
        rule = self.tools.rule_codify(
            situation="s", statement="t", grader="agent", stance="prescriptive"
        )
        self.tools.rule_forget(id=rule["rule_id"])
        self.assertEqual(self.tools.rule_list()["count"], 0)

    def test_feedback_accepts_id_alias(self):
        # The agent-facing surfaces (fired-rule injections, rule_list) render
        # the key as `id` (ADR 20260921); the tool accepts that name as an
        # alias so both correct paths converge.
        rule = self.tools.rule_codify(
            situation="s", statement="t", grader="agent", stance="prescriptive"
        )
        self.tools.rule_feedback(id=rule["rule_id"], signal="confirm")
        row = self.tools.store.conn.execute(
            "SELECT confirm_count FROM situational_rules WHERE id = ?",
            (rule["rule_id"],),
        ).fetchone()
        self.assertEqual(row["confirm_count"], 1.0)

    def test_feedback_id_alias_coerces_stringified(self):
        rule = self.tools.rule_codify(
            situation="s", statement="t", grader="agent", stance="prescriptive"
        )
        self.tools.rule_feedback(id=str(rule["rule_id"]), signal="confirm")
        row = self.tools.store.conn.execute(
            "SELECT confirm_count FROM situational_rules WHERE id = ?",
            (rule["rule_id"],),
        ).fetchone()
        self.assertEqual(row["confirm_count"], 1.0)

    def test_feedback_still_requires_an_id(self):
        self.tools.rule_codify(situation="s", statement="t", grader="agent", stance="prescriptive")
        with self.assertRaisesRegex(ToolError, "rule_id and signal"):
            self.tools.rule_feedback(signal="confirm")

    def test_codify_without_grader_is_refused(self):
        """A default grader filed every rule that omitted it as the agent's
        own discipline, including predictions about the user."""
        with self.assertRaisesRegex(ToolError, "grader is required"):
            self.tools.rule_codify(situation="s", statement="t", stance="descriptive")
        self.assertEqual(self.tools.rule_list()["rules"], [])

    def test_codify_without_stance_is_refused(self):
        """A default stance gave a prediction the directive force of a rule
        to follow (ADR 20260918)."""
        with self.assertRaisesRegex(ToolError, "stance is required"):
            self.tools.rule_codify(situation="s", statement="t", grader="user")
        self.assertEqual(self.tools.rule_list()["rules"], [])

    def test_codify_rejects_values_outside_the_enum(self):
        with self.assertRaisesRegex(ToolError, "grader is required"):
            self.tools.rule_codify(
                situation="s", statement="t", grader="nobody", stance="prescriptive"
            )
        with self.assertRaisesRegex(ToolError, "stance is required"):
            self.tools.rule_codify(situation="s", statement="t", grader="agent", stance="rule")

    def test_soft_without_polarity_is_refused(self):
        """Soft has no direction of its own. It defaulted to disconfirm,
        so a caller who said nothing and a caller who meant disconfirm
        produced the same row and nothing recorded which had happened."""
        rule = self.tools.rule_codify(
            situation="s", statement="t", grader="agent", stance="prescriptive"
        )
        with self.assertRaisesRegex(ToolError, "requires the separate polarity argument"):
            self.tools.rule_feedback(rule_id=rule["rule_id"], signal="soft")
        row = self.tools.store.conn.execute(
            "SELECT confirm_count, disconfirm_count FROM situational_rules WHERE id = ?",
            (rule["rule_id"],),
        ).fetchone()
        self.assertEqual((row["confirm_count"], row["disconfirm_count"]), (0.0, 0.0))

    def test_soft_polarity_stated_only_in_grounds_is_refused(self):
        """The mistake the message is written for: the polarity goes in
        prose because the caller does not know it is an argument."""
        rule = self.tools.rule_codify(
            situation="s", statement="t", grader="agent", stance="prescriptive"
        )
        with self.assertRaisesRegex(ToolError, "grounds does not set it"):
            self.tools.rule_feedback(
                rule_id=rule["rule_id"],
                signal="soft",
                grounds="adjacent, polarity positive",
            )

    def test_soft_rejects_a_polarity_outside_the_enum(self):
        rule = self.tools.rule_codify(
            situation="s", statement="t", grader="agent", stance="prescriptive"
        )
        with self.assertRaisesRegex(ToolError, "requires the separate polarity argument"):
            self.tools.rule_feedback(rule_id=rule["rule_id"], signal="soft", polarity="neutral")

    def test_reinforce_floor(self):
        rule = self.tools.persona_codify(statement="s")
        self.tools.persona_reinforce(rule_id=rule["id"])
        row = self.tools.store.conn.execute(
            "SELECT apply_count FROM persona_rules WHERE id = ?", (rule["id"],)
        ).fetchone()
        self.assertEqual(row["apply_count"], 1)


class RecallContractTests(unittest.TestCase):
    """The recall tool contract (ADR 20260926-recall-judged-rows): judged
    rows only, elided at 1200, episodic source_conversation; raw transcript
    reachable via find_conversations → list(session_id) → get."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.tools = Tools(Store(Path(self.tmp) / "t.db"), "testbox")

    def tearDown(self):
        self.tools.store.close()

    def _capture(self, capture_id, content, session):
        self.tools.store.upsert_capture(
            {"id": capture_id, "content": content, "source": f"cursor:example:{session}"}
        )

    def _deliberate(self, content, **kwargs):
        with stub_repo("example"):
            return self.tools.memory_remember(
                app="test", content=content, source="insight", **kwargs
            )

    def test_recall_elides_long_judged_rows(self):
        long_content = "gateway ownership ruling. " + "filler " * 2000
        self._deliberate(long_content)
        result = self.tools.memory_recall(query="gateway ownership", limit=5)
        row = next(r for r in result["results"] if r["tier"] == "working")
        self.assertLessEqual(len(row["content"]), 1200 + len("…[truncated]…"))
        self.assertIn("…[truncated]…", row["content"])
        self.assertTrue(row["truncated"])

    def test_recall_short_rows_verbatim_no_flag(self):
        self._deliberate("gateway ownership settled")
        result = self.tools.memory_recall(query="gateway ownership", limit=5)
        row = next(r for r in result["results"] if r["tier"] == "working")
        self.assertEqual(row["content"], "gateway ownership settled")
        self.assertNotIn("truncated", row)

    def test_recall_results_carry_no_capture_rows(self):
        self._capture("cx1", "[USER] gateway ownership debate", "ses_x")
        self._capture(
            "fx1", "[USER] <chat-history-summary> gateway ownership argued at length", "ses_x"
        )
        result = self.tools.memory_recall(query="gateway ownership", limit=12)
        ids = {r["id"] for r in result["results"]}
        self.assertNotIn("cx1", ids)
        self.assertNotIn("fx1", ids)

    def test_recall_workspace_none_is_honest(self):
        self._deliberate("gateway ownership settled")
        result = self.tools.memory_recall(query="gateway ownership", limit=5)
        self.assertIsNone(result["workspace"])


class FindConversationsTests(unittest.TestCase):
    """Per-session pointer discovery (ADR 20260926-recall-judged-rows):
    one pointer per conversation, matched_count ordering, no content rows."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.tools = Tools(Store(Path(self.tmp) / "t.db"), "testbox")

    def tearDown(self):
        self.tools.store.close()

    def _capture(self, capture_id, content, session):
        self.tools.store.upsert_capture(
            {
                "id": capture_id,
                "content": content,
                "source": f"cursor:example:{session}",
                "session_id": session,
            }
        )

    def test_pointer_shape_and_ordering(self):
        self._capture("c1", "[USER] agenix env empty after edit", "ses_a")
        self._capture("c2", "[AGENT] agenix recovery command found", "ses_a")
        self._capture("c3", "[USER] agenix one more note", "ses_a")
        self._capture("c4", "[USER] agenix brief mention", "ses_b")
        result = self.tools.memory_find_conversations(query="agenix")
        self.assertEqual(result["count"], 2)
        pointers = result["pointers"]
        self.assertEqual(pointers[0]["session_id"], "ses_a")
        self.assertEqual(pointers[0]["matched_count"], 3)
        self.assertEqual(pointers[1]["matched_count"], 1)
        self.assertEqual(pointers[0]["total_count"], 3)
        self.assertIn("preview", pointers[0])
        self.assertEqual(pointers[0]["tier"], "pointer")
        self.assertNotIn("content", pointers[0])

    def test_one_pointer_per_session_regardless_of_match_count(self):
        for n in range(10):
            self._capture(f"c{n}", f"[USER] agenix line {n}", "ses_a")
        result = self.tools.memory_find_conversations(query="agenix")
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["pointers"][0]["matched_count"], 10)

    def test_deliberate_rows_never_surface_as_pointers(self):
        with stub_repo("example"):
            self.tools.memory_remember(
                app="test", content="agenix lesson learned", source="insight"
            )
        result = self.tools.memory_find_conversations(query="agenix")
        self.assertEqual(result["count"], 0)

    def test_preview_is_the_best_matching_turn_not_the_longest(self):
        # The ADR specifies "preview of the best-matching turn". A long turn
        # that mentions the term once must not displace a short turn that is
        # about it.
        self._capture("c1", "[USER] agenix agenix agenix", "ses_a")
        self._capture(
            "c2", "[AGENT] agenix came up once " + "unrelated padding words " * 20, "ses_a"
        )
        pointer = self.tools.memory_find_conversations(query="agenix")["pointers"][0]
        self.assertTrue(pointer["preview"].startswith("[USER] agenix agenix agenix"))

    def test_fork_summary_sessions_surface_as_previews(self):
        long = "[USER] <chat-history-summary> " + "agenix " * 3000
        self._capture("f1", long, "ses_f")
        result = self.tools.memory_find_conversations(query="agenix")
        pointer = result["pointers"][0]
        self.assertEqual(pointer["session_id"], "ses_f")
        self.assertLessEqual(len(pointer["preview"]), 120)

    def test_forgotten_rows_drop_the_pointer(self):
        self._capture("c1", "[USER] agenix env empty after edit", "ses_a")
        self.assertTrue(self.tools.memory_find_conversations(query="agenix")["pointers"])
        self.tools.memory_forget(table="working_memory", id="c1")
        result = self.tools.memory_find_conversations(query="agenix")
        self.assertEqual(result["count"], 0)

    def test_empty_result_is_silence(self):
        self._capture("c1", "[USER] unrelated topic entirely", "ses_a")
        result = self.tools.memory_find_conversations(query="agenix")
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["pointers"], [])


class ListTests(unittest.TestCase):
    """memory_list: judged-tier default view, session drill-down (with
    deliberate rows), episodic reverse mode, metadata-only shape."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.tools = Tools(Store(Path(self.tmp) / "t.db"), "testbox")

    def tearDown(self):
        self.tools.store.close()

    def _capture(self, capture_id, content, session, kind="speech"):
        self.tools.store.upsert_capture(
            {
                "id": capture_id,
                "content": content,
                "source": f"cursor:example:{session}",
                "session_id": session,
                "kind": kind,
            }
        )

    def _deliberate(self, content, **kwargs):
        with stub_repo("example"):
            return self.tools.memory_remember(
                app="test", content=content, source="insight", **kwargs
            )

    def test_default_view_excludes_captures(self):
        self._capture("c1", "[USER] capture turn", "ses_a")
        deliberate = self._deliberate("deliberate memory")
        result = self.tools.memory_list()
        ids = {r["id"] for r in result["rows"]}
        self.assertEqual(ids, {deliberate["id"]})

    def test_explicit_origin_reaches_the_capture_tier(self):
        # The default view's deliberate-only clause must not AND with an
        # origin the caller named: that contradicts itself and returns [].
        self._capture("c1", "[USER] capture turn", "ses_a")
        self._deliberate("deliberate memory")
        ids = {r["id"] for r in self.tools.memory_list(origin="capture")["rows"]}
        self.assertEqual(ids, {"c1"})

    def test_session_mode_returns_conversation_chronologically(self):
        self._capture("c1", "[USER] first turn", "ses_a")
        self._capture("c2", "[AGENT] second turn", "ses_a")
        deliberate = self._deliberate("note written during the session", conversation_id="ses_a")
        self._capture("c3", "[USER] third turn", "ses_a")
        # The working drill is the conversation's captured turns; the
        # deliberate note lives in agent_memory under the same
        # conversation, reached through the provenance drill.
        result = self.tools.memory_list(session_id="ses_a")
        ids = [r["id"] for r in result["rows"]]
        self.assertEqual(len(ids), 3)
        self.assertIn("c1", ids)
        self.assertIn("c3", ids)
        agent_rows = self.tools.memory_list(table="agent_memory", session_id="ses_a")["rows"]
        self.assertEqual([r["id"] for r in agent_rows], [deliberate["id"]])

    def test_session_mode_excludes_other_sessions(self):
        self._capture("c1", "[USER] turn in a", "ses_a")
        self._capture("c2", "[USER] turn in b", "ses_b")
        result = self.tools.memory_list(session_id="ses_a")
        ids = [r["id"] for r in result["rows"]]
        self.assertIn("c1", ids)
        self.assertNotIn("c2", ids)

    def test_episodic_reverse_mode_by_summary_of(self):
        self.tools.store.upsert_episodic(
            {
                "id": "ep1",
                "content": "summary of ses_a",
                "source": "hub",
                "summary_of": "ses_a",
            }
        )
        self.tools.store.upsert_episodic(
            {
                "id": "ep2",
                "content": "summary of ses_b",
                "source": "hub",
                "summary_of": "ses_b",
            }
        )
        result = self.tools.memory_list(table="episodic_memory", session_id="ses_a")
        ids = [r["id"] for r in result["rows"]]
        self.assertIn("ep1", ids)
        self.assertNotIn("ep2", ids)

    def test_metadata_shape_no_content(self):
        self._deliberate("check before write")
        row = self.tools.memory_list()["rows"][0]
        self.assertNotIn("content", row)
        for field in (
            "id",
            "source",
            "tier",
            "repo",
            "origin",
            "app",
            "kind",
            "timestamp",
            "importance",
            "veracity",
            "length",
            "preview",
        ):
            self.assertIn(field, row)
        self.assertEqual(row["preview"], "check before write")

    def test_limit_respected(self):
        for n in range(4):
            self._deliberate(f"memory number {n}")
        self.assertEqual(len(self.tools.memory_list(limit=2)["rows"]), 2)

    def test_filter_by_repo(self):
        self._deliberate("in-repo memory")
        with stub_repo("example"):
            self._deliberate("example memory", cwd="/tmp/opencode/some-worktree")
        with stub_repo("other"):
            self.tools.memory_remember(
                app="test", content="other-repo memory", source="insight", cwd="/tmp/elsewhere"
            )
        result = self.tools.memory_list(repo="other")
        self.assertEqual([r["repo"] for r in result["rows"]], ["other"])
        self.assertEqual([r["origin"] for r in result["rows"]], ["deliberate"])

    def test_drill_down_end_to_end_reachability(self):
        """The full chain from the ADR: summary → its conversation's turns →
        one turn's full text."""
        self._capture("c1", "[USER] the full agenix lesson text", "ses_a")
        self.tools.store.upsert_episodic(
            {
                "id": "ep1",
                "content": "summary mentioning agenix",
                "source": "hub",
                "summary_of": "ses_a",
            }
        )
        summary = self.tools.memory_get(id="ep1")["record"]
        self.assertEqual(summary["summary_of"], "ses_a")
        turns = self.tools.memory_list(session_id=summary["summary_of"])["rows"]
        self.assertEqual([r["id"] for r in turns], ["c1"])
        full = self.tools.memory_get(id=turns[0]["id"])
        self.assertEqual(full["record"]["content"], "[USER] the full agenix lesson text")


if __name__ == "__main__":
    unittest.main()


class RuleRecallTests(unittest.TestCase):
    """The situation ask + the reconciling write path (PRJ-172)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.tools = Tools(Store(Path(self.tmp) / "t.db"), "testbox")
        with mock.patch.object(self.tools.store, "embed", return_value=[]):
            pass
        self.neighbors = []

    def tearDown(self):
        self.tools.store.close()

    def _with_neighbors(self, list_):
        return mock.patch("memory_store.tools.rule_neighbors", return_value=list_)

    def _with_embed(self):
        return mock.patch.object(self.tools.store, "embed", side_effect=None)

    def test_recall_requires_situation(self):
        with self.assertRaises(ToolError):
            self.tools.rule_recall(situation="  ")

    def test_recall_returns_marked_rules(self):
        rules = [
            {
                "id": 1,
                "situation": "about to commit",
                "statement": "run checks",
                "confidence": 0.5,
                "quiet": False,
                "scope": "",
            }
        ]
        with mock.patch("memory_store.tools.rule_search", return_value=rules):
            result = self.tools.rule_recall(situation="about to commit", cwd="/tmp/opencode/x")
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["rules"][0]["id"], 1)

    def test_write_when_store_finds_no_neighbor(self):
        with self._with_neighbors([]):
            result = self.tools.rule_codify(
                situation="about to commit without an explicit word",
                statement="name the commit in the same instruction",
                grader="agent",
                stance="prescriptive",
            )
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["rule_id"])

    def test_write_refuses_the_near_clone(self):
        with self._with_neighbors(
            [{"id": 7, "situation": "about to commit", "statement": "x", "similarity": 0.97}]
        ):
            result = self.tools.rule_codify(
                situation="about to commit changes now",
                statement="name the commit in the same instruction",
                grader="agent",
                stance="prescriptive",
            )
        self.assertEqual(result["status"], "reconcile")
        self.assertEqual(result["matched"]["id"], 7)
        self.assertIn("rule_feedback", result["guidance"])
        rows = self.tools.store.conn.execute(
            "SELECT COUNT(*) AS n FROM situational_rules"
        ).fetchone()
        self.assertEqual(rows["n"], 0)

    def test_write_names_a_sibling_in_the_response(self):
        with self._with_neighbors(
            [
                {
                    "id": 9,
                    "situation": "about to push",
                    "statement": "x",
                    "similarity": 0.65,
                }
            ]
        ):
            result = self.tools.rule_codify(
                situation="about to commit without an explicit word",
                statement="name the commit in the same instruction",
                grader="agent",
                stance="prescriptive",
            )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["similar"][0]["id"], 9)
        self.assertIn("forget", result["reconcile"])

    def test_write_reports_the_skipped_check_without_embeddings(self):
        with self._with_neighbors([]):
            with mock.patch(
                "memory_store.tools.rule_neighbors", side_effect=RuntimeError("no vec")
            ):
                result = self.tools.rule_codify(
                    situation="about to commit without an explicit word",
                    statement="name the commit",
                    grader="agent",
                    stance="prescriptive",
                )
        self.assertEqual(result["status"], "ok")
        self.assertIn("reconcile_skipped", result)

    def test_amend_updates_in_place(self):
        with mock.patch("memory_store.tools.rule_neighbors", return_value=[]):
            first = self.tools.rule_codify(
                situation="about to commit",
                statement="run checks",
                grader="agent",
                stance="prescriptive",
            )
        result = self.tools.rule_codify(
            situation="about to commit",
            statement="run the checks before committing",
            grader="agent",
            stance="prescriptive",
            id=first["rule_id"],
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["updated"], first["rule_id"])
        row = self.tools.store.conn.execute(
            "SELECT statement FROM situational_rules WHERE id = ?", (first["rule_id"],)
        ).fetchone()
        self.assertEqual(row["statement"], "run the checks before committing")

    def test_amend_on_a_missing_rule_is_rejected(self):
        with self.assertRaises(ToolError):
            self.tools.rule_codify(
                situation="x", statement="y", grader="agent", stance="prescriptive", id=12345
            )
