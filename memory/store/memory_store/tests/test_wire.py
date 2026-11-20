"""Wire-path regression tests: the mutations run through RecordEmittingTools
(the daemon's actual tool surface) against a stub sync client, so the emit
path — where wire-shaped rows are enqueued — is exercised by make test-memory
and wrong-table SELECTs or unstamped rows cannot land again."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store import capture
from memory_store import tools as tools_module
from memory_store.server.daemon import RecordEmittingTools
from memory_store.recall import explicit_recall
from memory_store.store import UNRECORDED_CONVERSATION, Store
from memory_store.sync import RecordContractError
from memory_store.tools import ToolError


class StubSync:
    """Records enqueued kinds/payloads; never touches the network. The
    stub record_id rides its own list so tests can assert the emitter's
    apply-and-ship id binding."""

    def __init__(self):
        self.records: list = []
        self.record_ids: list = []

    def enqueue(self, kind, payload, record_id=None):
        self.records.append((kind, payload))
        self.record_ids.append(record_id)
        return record_id or "stub-record-id"


class PersonaWireTests(unittest.TestCase):
    """The persona floor path through the emitting wrappers: the write
    succeeds AND the post-write SELECT (the wire emit) does not crash on
    wrong-table columns (the no-such-column: grader regression)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.sync = StubSync()
        self.tools = RecordEmittingTools(
            Store(self.tmp / "t.db"), "testbox", self.sync, str(self.tmp / "floor.md")
        )

    def tearDown(self):
        self.tools.store.close()

    def test_codify_writes_active_and_emits_rule_record(self):
        result = self.tools.persona_codify(
            statement="Answer the question actually asked, first sentence.",
        )
        row = self.tools.store.conn.execute(
            "SELECT status FROM persona_rules WHERE id = ?", (result["id"],)
        ).fetchone()
        self.assertEqual(row["status"], "active")
        kinds = [kind for kind, _ in self.sync.records]
        self.assertEqual(kinds, ["rule"])
        payload = self.sync.records[0][1]
        self.assertEqual(payload["target"], "persona")
        self.assertEqual(payload["status"], "active")
        self.assertNotIn("grader", payload)
        self.assertEqual(
            payload["statement"],
            "Answer the question actually asked, first sentence.",
        )

    def test_refused_write_emits_nothing(self):
        self.tools.persona_codify(statement="z" * 15000)
        self.sync.records.clear()
        result = self.tools.persona_codify(statement="one more rule")
        self.assertEqual(result["status"], "refused")
        self.assertEqual(self.sync.records, [])

    def test_update_emits_record(self):
        rule = self.tools.persona_codify(statement="s")
        self.sync.records.clear()
        self.tools.persona_update(rule_id=rule["id"], statement="new words")
        payload = self.sync.records[0][1]
        self.assertEqual(payload["statement"], "new words")

    def test_update_missing_raises(self):
        with self.assertRaises(ToolError):
            self.tools.persona_update(rule_id=99999, statement="x")


class RepoPatchMixin:
    """Patch detect_repo in BOTH namespaces the tools reach it through —
    tools' direct import (memory_remember) and capture's own reference
    (resolve_workspace, used by rule_codify/memory_recall) — and clear the
    resolution memo around the patch window."""

    def patched_repo(self, name="example"):
        capture._repo_cache.clear()
        patchers = [
            mock.patch.object(tools_module, "detect_repo", return_value=name),
            mock.patch.object(capture, "detect_repo", return_value=name),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(capture._repo_cache.clear)


class ScopeTests(RepoPatchMixin, unittest.TestCase):
    """Binding-time scope: the directory is the only source, and a name the
    model supplies is not one. detect_repo is patched to a fixed name and the
    memo is cleared per test so tests stay isolated."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.sync = StubSync()
        self.tools = RecordEmittingTools(
            Store(self.tmp / "t.db"), "testbox", self.sync, str(self.tmp / "floor.md")
        )

    def tearDown(self):
        self.tools.store.close()
        capture._repo_cache.clear()

    def test_codify_stamps_workspace_from_cwd(self):
        # The plugin injects cwd; the tool resolves repo from it. (The old
        # premise — omitted scope resolves from the daemon's cwd — is the
        # fabrication bug this suite now forbids.)
        self.patched_repo()
        result = self.tools.rule_codify(
            situation="about to commit",
            statement="run checks first",
            cwd="/tmp/opencode/some-worktree",
            grader="agent",
            stance="prescriptive",
        )
        row = self.tools.store.conn.execute(
            "SELECT scope FROM situational_rules WHERE id = ?", (result["rule_id"],)
        ).fetchone()
        self.assertEqual(row["scope"], "example")
        self.assertEqual(result["scope"], "example")

    def test_codify_ignores_a_named_scope(self):
        # `scope` is off the signature, and **_ absorbs one that still
        # arrives rather than raising, so the cwd has to win anyway.
        self.patched_repo()
        result = self.tools.rule_codify(
            situation="s",
            statement="st",
            scope="global",
            cwd="/tmp/opencode/some-worktree",
            grader="agent",
            stance="prescriptive",
        )
        row = self.tools.store.conn.execute(
            "SELECT scope FROM situational_rules WHERE id = ?", (result["rule_id"],)
        ).fetchone()
        self.assertEqual(row["scope"], "example")

    def test_workspace_memoized_per_cwd(self):
        # Same cwd resolves once (one detect_repo call); the memo serves
        # repeats. A different cwd resolves its own entry.
        with mock.patch.object(capture, "detect_repo", return_value="example") as detector:
            first = capture.resolve_workspace("/tmp/opencode/memo-probe")
            second = capture.resolve_workspace("/tmp/opencode/memo-probe")
            third = capture.resolve_workspace("/tmp/other/probe")
            self.assertEqual(first, "example")
            self.assertEqual(second, "example")
            self.assertEqual(third, "example")
            self.assertEqual(detector.call_count, 2)

    def test_recall_scope_boost(self):
        # Repo-stamped row + matching workspace must outrank an
        # otherwise-equal row from another workspace.
        self.tools.store.upsert_capture(
            {
                "id": "in1",
                "content": "mcp stack test memory",
                "kind": "speech",
                "source": "preference",
                "repo": "example",
                "origin": "deliberate",
            }
        )
        self.tools.store.upsert_capture(
            {
                "id": "out1",
                "content": "mcp stack test memory other",
                "kind": "speech",
                "source": "preference",
                "repo": "other",
                "origin": "deliberate",
            }
        )
        results = explicit_recall(
            self.tools.store,
            "mcp stack test",
            limit=5,
            workspace="example",
        )
        ids = [r["id"] for r in results]
        self.assertIn("in1", ids)
        in_score = next(r["score"] for r in results if r["id"] == "in1")
        out_score = next(r["score"] for r in results if r["id"] == "out1")
        self.assertGreater(in_score, out_score)


class SessionContextTests(RepoPatchMixin, unittest.TestCase):
    """Session context (cwd) resolution: injected by the plugin, overridden
    by the agent, or absent — and NEVER fabricated. No cwd -> bare label,
    empty scope, no workspace boost."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.sync = StubSync()
        self.tools = RecordEmittingTools(
            Store(self.tmp / "t.db"), "testbox", self.sync, str(self.tmp / "floor.md")
        )

    def tearDown(self):
        self.tools.store.close()
        capture._repo_cache.clear()

    def test_remember_stamps_repo_from_cwd(self):
        self.patched_repo()
        result = self.tools.memory_remember(
            app="test",
            content="the wire contract requires occurred_at",
            source="convention",
            cwd="/tmp/opencode/some-worktree",
        )
        self.assertEqual(result["source"], "convention")
        self.assertEqual(result["repo"], "example")
        # The deliberate home carries repo/app; origin is the tier, and the
        # write anchors to the provenance-unrecorded placeholder session
        # (no conversation id arrived with the call).
        row = self.tools.store.conn.execute(
            """SELECT a.repo, a.app, s.machine, s.tool,
                      s.client_conversation_id AS conversation
               FROM agent_memory a JOIN session s ON a.session_id = s.id
               WHERE a.id = ?""",
            (result["id"],),
        ).fetchone()
        self.assertEqual(row["repo"], "example")
        self.assertEqual(row["app"], "test")
        self.assertEqual(row["conversation"], UNRECORDED_CONVERSATION)

    def test_remember_bare_when_no_context(self):
        # The fabrication regression: no cwd, no repo -> bare label, never
        # a daemon-cwd-derived wrong repo. The session anchor is the
        # placeholder, never a fabricated conversation.
        result = self.tools.memory_remember(
            app="test", content="no context write", source="insight"
        )
        self.assertEqual(result["source"], "insight")
        row = self.tools.store.conn.execute(
            "SELECT source FROM agent_memory WHERE id = ?", (result["id"],)
        ).fetchone()
        self.assertEqual(row["source"], "insight")

    def test_remember_binds_the_injected_conversation(self):
        # The plugin injects conversation_id with the same execute.before
        # hook that injects cwd; the write links the conversation's
        # registry row (created if it did not exist yet) — provenance as
        # structure, the write's session resolvable for the walk.
        self.patched_repo()
        result = self.tools.memory_remember(
            app="opencode",
            content="linked write",
            source="fact",
            cwd="/tmp/opencode/some-worktree",
            conversation_id="ses-live-1",
        )
        row = self.tools.store.conn.execute(
            """SELECT s.machine, s.tool, s.project,
                      s.client_conversation_id AS conversation
               FROM agent_memory a JOIN session s ON a.session_id = s.id
               WHERE a.id = ?""",
            (result["id"],),
        ).fetchone()
        self.assertEqual(row["machine"], "testbox")
        self.assertEqual(row["tool"], "opencode")
        self.assertEqual(row["project"], "example")
        self.assertEqual(row["conversation"], "ses-live-1")

    def test_remember_ignores_a_named_repo(self):
        # `repo` is off the signature, and **_ absorbs one that still
        # arrives rather than raising, so the cwd has to win anyway.
        self.patched_repo()
        result = self.tools.memory_remember(
            app="test",
            content="named repo write",
            source="fact",
            repo="llm-proxy",
            cwd="/tmp/opencode/some-worktree",
        )
        self.assertEqual(result["source"], "fact")
        self.assertEqual(result["repo"], "example")

    def test_remember_resolves_the_directory_it_was_given(self):
        # The other tests stub detect_repo to a fixed name, which would pass
        # even if the stamp ignored cwd entirely. Mapping the path to its own
        # basename is what shows the directory reaching the resolver.
        with mock.patch.object(tools_module, "detect_repo", side_effect=lambda cwd: Path(cwd).name):
            result = self.tools.memory_remember(
                app="test",
                content="filed against another checkout",
                source="fact",
                cwd="/tmp/checkouts/llm-proxy",
            )
        self.assertEqual(result["repo"], "llm-proxy")

    def test_codify_scope_from_cwd(self):
        self.patched_repo()
        result = self.tools.rule_codify(
            situation="about to commit",
            statement="run checks first",
            cwd="/tmp/opencode/some-worktree",
            grader="agent",
            stance="prescriptive",
        )
        self.assertEqual(result["scope"], "example")

    def test_codify_empty_scope_when_no_context(self):
        # Never 'global' by default — that claim is a judgment, not a
        # fallback.
        result = self.tools.rule_codify(
            situation="s", statement="st", grader="agent", stance="prescriptive"
        )
        self.assertEqual(result["scope"], "")
        row = self.tools.store.conn.execute(
            "SELECT scope FROM situational_rules WHERE id = ?",
            (result["rule_id"],),
        ).fetchone()
        self.assertEqual(row["scope"], "")

    def test_recall_echoes_workspace(self):
        self.patched_repo()
        result = self.tools.memory_recall(query="wire contract", cwd="/tmp/opencode/some-worktree")
        self.assertEqual(result["workspace"], "example")
        self.assertIn("results", result)

    def test_recall_workspace_none_when_no_context(self):
        result = self.tools.memory_recall(query="wire contract")
        self.assertIsNone(result["workspace"])


class GroundsTests(unittest.TestCase):
    """Feedback grounds: recorded, never interpreted — the audit trail for
    every trained signal."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.sync = StubSync()
        self.tools = RecordEmittingTools(
            Store(self.tmp / "t.db"), "testbox", self.sync, str(self.tmp / "floor.md")
        )

    def tearDown(self):
        self.tools.store.close()

    def test_feedback_records_grounds(self):
        rule = self.tools.rule_codify(
            situation="s", statement="st", grader="agent", stance="prescriptive"
        )
        self.tools.rule_feedback(
            rule_id=rule["rule_id"],
            signal="disconfirm",
            grounds="fired on a planning turn; rule is about committing",
        )
        row = self.tools.store.conn.execute(
            "SELECT grounds, signal FROM feedback_log WHERE rule_id = ?",
            (rule["rule_id"],),
        ).fetchone()
        self.assertEqual(row["grounds"], "fired on a planning turn; rule is about committing")
        # The store logs the canonical vocabulary: disconfirm normalizes
        # to refute (the hub's validator accepts exactly the canonical four).
        self.assertEqual(row["signal"], "refute")

    def test_feedback_wire_signal_is_canonical(self):
        # The sync record must carry the canonical wire vocabulary — the
        # agent-facing shorthand (soft + polarity) never rides the wire —
        # and the EFFECTIVE delta, not the raw param: the emitter's
        # delta=1.0 for soft gradings made receiving machines weight them
        # at full strength (2026-09-19). Field-complete: every wire field
        # asserted, derived from one real tool call.
        rule = self.tools.rule_codify(
            situation="s", statement="st", grader="agent", stance="prescriptive"
        )
        expecteds = [
            ({"signal": "disconfirm"}, ("refute", 1.0)),
            ({"signal": "soft", "polarity": "disconfirm"}, ("soft_refute", 0.25)),
            ({"signal": "soft", "polarity": "confirm"}, ("soft_confirm", 0.25)),
            ({"signal": "confirm"}, ("confirm", 1.0)),
        ]
        for kwargs, _ in expecteds:
            self.tools.rule_feedback(rule_id=rule["rule_id"], **kwargs)
        feedback = [
            (payload, rid)
            for (kind, payload), rid in zip(self.sync.records, self.sync.record_ids, strict=True)
            if kind == "feedback"
        ]
        self.assertEqual(
            [(p["signal"], p["delta"]) for p, _ in feedback],
            [expected for _, expected in expecteds],
        )
        # The emit carries the record_id the local apply was bound to
        # (the self-echo dedupe key), never None:
        self.assertTrue(all(rid for _, rid in feedback))

    def test_feedback_without_grounds_persists_null(self):
        rule = self.tools.rule_codify(
            situation="s", statement="st", grader="agent", stance="prescriptive"
        )
        self.tools.rule_feedback(rule_id=rule["rule_id"], signal="confirm")
        row = self.tools.store.conn.execute(
            "SELECT grounds FROM feedback_log WHERE rule_id = ?",
            (rule["rule_id"],),
        ).fetchone()
        self.assertIsNone(row["grounds"])

    def test_emit_raises_a_contract_violation_and_swallows_transport(self):
        """`_emit` exists so a dead hub cannot fail a local write. A record
        this host cannot legally send is a different thing: the input that
        built it was wrong, and the agent that supplied it is still in the
        turn."""
        self.tools.memory_remember(content="a durable fact", source="fact", app="test")

        with mock.patch.object(self.sync, "enqueue", side_effect=OSError("hub is down")):
            self.tools.memory_remember(content="another durable fact", source="fact", app="test")

        violation = RecordContractError("memory record rejected before send: no content")
        with mock.patch.object(self.sync, "enqueue", side_effect=violation):
            with self.assertRaises(RecordContractError):
                self.tools.memory_remember(
                    content="a third durable fact", source="fact", app="test"
                )

    def test_daemon_override_does_not_reintroduce_the_polarity_default(self):
        """The default was re-supplied at every layer, so removing it in
        one place changed nothing. The override forwards polarity to the
        base, and forwarding its own default is how the base guard stayed
        unreachable."""
        rule = self.tools.rule_codify(
            situation="s", statement="st", grader="agent", stance="prescriptive"
        )
        with self.assertRaisesRegex(ToolError, "requires the separate polarity argument"):
            self.tools.rule_feedback(rule_id=rule["rule_id"], signal="soft")
        self.assertEqual([kind for kind, _ in self.sync.records if kind == "feedback"], [])


class EvidenceExportTests(unittest.TestCase):
    """match_rules exports the evidence count alongside confidence — the
    renderer needs both (confidence alone is uninterpretable without the
    sample size)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.store = Store(self.tmp / "t.db")

    def tearDown(self):
        self.store.close()
        capture._repo_cache.clear()

    def test_match_payload_carries_evidence_count(self):
        self.store.upsert_situational(
            {
                "id": 1,
                "situation": "about to commit code",
                "statement": "run checks first",
                "status": "active",
                "grader": "agent",
                "stance": "prescriptive",
            }
        )
        self.store.apply_feedback(1, "situational", "confirm", 1.0, "test")
        self.store.apply_feedback(1, "situational", "disconfirm", 1.0, "test")
        with mock.patch.object(Store, "embed", return_value=[[0.1] * 8]):
            from memory_store.curated import match_rules

            matched = match_rules(self.store, "about to commit code", threshold=0.0)
        self.assertTrue(matched)
        rule = matched[0]
        self.assertEqual(rule["evidence_count"], 2)
        self.assertIn("confidence", rule)
        self.assertIn("stance", rule)


if __name__ == "__main__":
    unittest.main()
