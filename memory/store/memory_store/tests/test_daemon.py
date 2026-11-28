"""Daemon integration tests through the DaemonState surface with a stub
embedder: session-open scoring and the lexical fallback, capture-drain
classification, and record emission from tool calls (the single-writer
path)."""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../..")

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.server import daemon  # noqa: E402
from memory_store.server.daemon import DaemonState, RecordEmittingTools, drain_captures  # noqa: E402
from memory_store.store import UNRECORDED_CONVERSATION, Store, tool_key_id, tool_rule_id  # noqa: E402
from memory_store.sync import SyncClient  # noqa: E402
from memory_store.tools import LINEAGE_REDACT_READS, WRITE_TOOLS  # noqa: E402


class SandboxGuardTests(unittest.TestCase):
    """tests/sandbox.py precedes the daemon import in this file; its whole
    point is that the module constants below bound to scratch paths. A
    constant resolving outside the scratch root means a new module-level
    default ignores the environment sandbox and would read or write the
    developer's live tree from a test."""

    def test_daemon_path_constants_live_in_the_scratch_root(self):
        for name in (
            "DATA_DIR",
            "QUEUE_DIR",
            "FLOOR_PATH",
            "CURSOR_HOOKS_PATH",
            "FLOOR_RULE_PATH",
        ):
            value = getattr(daemon, name)
            self.assertTrue(
                value == "" or str(value).startswith(sandbox.ROOT),
                f"daemon.{name} escaped the test sandbox: {value!r}",
            )


def _client_shimmed(state):
    """Stand in for the client layer: the plugin and the hook inject the
    session link and the lineage initiator on every gated call,
    overwriting whatever the model put in (PRD
    20261114-lineage-gated-writes). Writes below flow the way a human
    session's writes actually arrive; the gate's refusals are tested
    explicitly against registered conversations in their own tests."""
    inner_call = state.call_tool

    def call_tool(name, arguments=None, *, app, connection_initiator="human"):
        arguments = dict(arguments or {})
        if name in WRITE_TOOLS or name in LINEAGE_REDACT_READS or name == "knowledge_read":
            arguments.setdefault("conversation_id", "conv-test")
        return inner_call(name, arguments, app=app, connection_initiator=connection_initiator)

    state.call_tool = call_tool
    # The unshimmed entry, for tests that exercise the bare-write path
    # (no client layer at all).
    state.call_tool_unshimmed = inner_call
    return state


class DaemonFixture:
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="daemon-test-")
        self.queue_dir = os.path.join(self.tmp, "queue")
        os.makedirs(self.queue_dir)
        self.store = Store(os.path.join(self.tmp, "memory.db"))
        # Pure stub space: vec0 reads/writes disabled so all embedding flows
        # through the test's stub embedder regardless of run mode (hermetic
        # MEMORY_DISABLE_EMBEDDINGS=1 or the daemon venv).
        self.store.vec_available = False
        self.sync = SyncClient(
            self.store, "http://hub.invalid", "test-machine", queue_dir=self.queue_dir
        )
        self.tools = RecordEmittingTools(
            self.store, "test-machine", self.sync, os.path.join(self.tmp, "floor.md")
        )
        self.state = _client_shimmed(DaemonState(self.store, self.tools, self.sync))


class ForceSpy:
    """Records force() calls — the drain's only consolidator dependency."""

    def __init__(self):
        self.forced: list[str] = []

    def force(self, session_id):
        self.forced.append(session_id)


class ConsolidationTickTests(unittest.TestCase):
    """The consolidation tick's log policy: the result line on an active
    tick, nothing on an all-zero one by default (ruling 2026-11-18) with
    the idle line back under MEMORY_CONSOLIDATION_DEBUG=1, and a per-tick
    backlog warning while consolidation is stalled — the 28-day silent
    freeze must stay impossible to miss."""

    def setUp(self):
        self.fixture = DaemonFixture()
        self.store = self.fixture.store

    def tearDown(self):
        self.store.close()

    def _tick(self, consolidator):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            result = daemon.consolidation_tick(self.store, consolidator)
        return result, out.getvalue()

    @staticmethod
    def _zero_consolidator():
        class Zero:
            def tick(self):
                return {"groups": 0, "summarized": 0, "released": 0, "skipped": 0}

        return Zero()

    def _backlog_rows(self, n, session_id="ses_backlog"):
        for i in range(n):
            self.store.upsert_capture(
                {
                    "id": f"c{i}",
                    "content": f"[USER] backlog turn {i}",
                    "session_id": session_id,
                    "kind": "speech",
                    "captured_by": "local",
                }
            )

    def test_all_zero_tick_is_silent_when_debug_is_off(self):
        with mock.patch.object(daemon, "CONSOLIDATION_DEBUG", False):
            _, printed = self._tick(self._zero_consolidator())
        self.assertEqual(printed, "")

    def test_all_zero_tick_prints_the_idle_line_when_debug_is_on(self):
        with mock.patch.object(daemon, "CONSOLIDATION_DEBUG", True):
            _, printed = self._tick(self._zero_consolidator())
        self.assertIn("client consolidation: idle", printed)

    def test_active_tick_prints_the_result_line_without_idle(self):
        class Active:
            def tick(self):
                return {"groups": 1, "summarized": 1, "released": 0, "skipped": 0}

        _, printed = self._tick(Active())
        self.assertIn("client consolidation: {", printed)
        self.assertNotIn("idle", printed)

    def test_backlog_over_threshold_warns_every_tick(self):
        self._backlog_rows(3)
        with mock.patch.object(daemon, "CONSOLIDATION_BACKLOG_WARN", 2):
            for _ in range(2):
                _, printed = self._tick(self._zero_consolidator())
                self.assertIn("CONSOLIDATION BACKLOG: 3", printed)

    def test_backlog_under_threshold_stays_quiet(self):
        self._backlog_rows(2)
        _, printed = self._tick(self._zero_consolidator())
        self.assertNotIn("CONSOLIDATION BACKLOG", printed)


class DaemonStateTest(unittest.TestCase):
    def setUp(self):
        self.fixture = DaemonFixture()
        self.store = self.fixture.store
        self.state = self.fixture.state
        self.sync = self.fixture.sync
        self.queue_dir = self.fixture.queue_dir

    def tearDown(self):
        self.store.close()

    def _stub_embed(self, texts, origin=None):
        return [[1.0] for _ in texts]

    def test_remember_emits_record(self):
        with mock.patch.object(self.store, "embed", side_effect=self._stub_embed):
            result = self.state.call_tool_unshimmed(
                "memory_remember",
                {"content": "host-a runs the documentation service", "source": "fact"},
                app="test",
            )
        self.assertEqual(result["status"], "ok")
        path = Path(self.queue_dir) / "outbound.jsonl"
        self.assertTrue(path.exists())
        records = [json.loads(line) for line in path.read_text().splitlines()]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["kind"], "agent_memory")
        self.assertEqual(records[0]["machine_id"], "test-machine")
        self.assertEqual(records[0]["payload"]["content"], "host-a runs the documentation service")
        # The session triple rides the payload; a write with no
        # conversation resolves to the placeholder anchor on the real
        # machine. The gate's observation grant applied (no human in any
        # line a bare write could name), so the row is agent-attributed.
        self.assertEqual(records[0]["payload"]["session"]["machine"], "test-machine")
        self.assertEqual(
            records[0]["payload"]["session"]["conversation_id"],
            UNRECORDED_CONVERSATION,
        )
        self.assertEqual(records[0]["payload"]["author_type"], "agent")

    def test_update_routes_the_wire_kind_by_row_presence(self):
        # An agent-row edit rides the agent_memory kind; the same edit on a
        # pre-migration straggler rides memory — one truth, resolved after
        # the write from row presence.
        session = self.store.get_or_create_session("test-machine", "test", "ses_u1")
        self.store.upsert_agent({"id": "mu1", "session_id": session, "content": "agent-home row"})
        self.store.upsert_capture(
            {
                "id": "mu2",
                "content": "straggler row",
                "origin": "deliberate",
                "source": "fact",
                "app": "test",
            }
        )
        with mock.patch.object(self.store, "embed", side_effect=self._stub_embed):
            self.state.call_tool("memory_update", {"id": "mu1", "importance": 0.9}, app="test")
            self.state.call_tool("memory_update", {"id": "mu2", "importance": 0.9}, app="test")
        records = [
            json.loads(line)
            for line in (Path(self.queue_dir) / "outbound.jsonl").read_text().splitlines()
        ]
        kinds = [r["kind"] for r in records]
        self.assertEqual(kinds.count("agent_memory"), 1)
        self.assertEqual(kinds.count("memory"), 1)

    def test_a_deliberate_forget_tombstones_both_homes_and_emits_both(self):
        session = self.store.get_or_create_session("test-machine", "test", "ses_f")
        self.store.upsert_agent({"id": "mf1", "session_id": session, "content": "both homes"})
        self.store.upsert_capture(
            {
                "id": "mf1",
                "content": "both homes",
                "origin": "deliberate",
                "source": "fact",
                "app": "test",
            }
        )
        self.state.call_tool("memory_forget", {"table": "agent_memory", "id": "mf1"}, app="test")
        self.assertIsNone(
            self.store.conn.execute("SELECT 1 FROM agent_memory WHERE id = 'mf1'").fetchone()
        )
        self.assertIsNone(
            self.store.conn.execute("SELECT 1 FROM working_memory WHERE id = 'mf1'").fetchone()
        )
        records = [
            json.loads(line)
            for line in (Path(self.queue_dir) / "outbound.jsonl").read_text().splitlines()
        ]
        forgets = [r for r in records if r["kind"] == "forget"]
        self.assertEqual(
            {r["payload"]["table"] for r in forgets},
            {"agent_memory", "working_memory"},
        )
        self.assertTrue(self.store.is_tombstoned("agent_memory", "mf1"))
        self.assertTrue(self.store.is_tombstoned("working_memory", "mf1"))

    def test_a_capture_forget_does_not_litter_agent_tombstones(self):
        self.store.upsert_capture(
            {
                "id": "cp1",
                "content": "[USER] a captured turn worth deleting",
                "origin": "capture",
                "app": "test",
            }
        )
        self.state.call_tool("memory_forget", {"table": "working_memory", "id": "cp1"}, app="test")
        records = [
            json.loads(line)
            for line in (Path(self.queue_dir) / "outbound.jsonl").read_text().splitlines()
        ]
        forgets = [r for r in records if r["kind"] == "forget"]
        self.assertEqual([r["payload"]["table"] for r in forgets], ["working_memory"])
        self.assertFalse(self.store.is_tombstoned("agent_memory", "cp1"))

    def test_a_forged_homes_argument_is_stripped(self):
        # The internal homes parameter is not a model-facing surface: a
        # value arriving in the arguments is discarded like app.
        with mock.patch.object(
            self.state.tools, "memory_forget", return_value={"status": "ok"}
        ) as handler:
            self.state.call_tool(
                "memory_forget",
                {"table": "working_memory", "id": "m1", "homes": ("agent_memory",)},
                app="test",
            )
        self.assertNotIn("homes", handler.call_args[1])

    def test_a_forged_conversation_id_is_stripped_from_non_binding_tools(self):
        with mock.patch.object(
            self.state.tools, "memory_recall", return_value={"status": "ok"}
        ) as handler:
            self.state.call_tool(
                "memory_recall",
                {"query": "x", "conversation_id": "forged-session"},
                app="test",
            )
        self.assertNotIn("conversation_id", handler.call_args[1])

    def test_remember_carries_the_client_injected_session(self):
        # memory_remember keeps its conversation reference: the plugin layer
        # overwrote the model's value before the call reached the wire, so
        # what sits in the arguments here is the client's, not the model's.
        with mock.patch.object(
            self.state.tools, "memory_remember", return_value={"status": "ok"}
        ) as handler:
            self.state.call_tool(
                "memory_remember",
                {"content": "x", "conversation_id": "ses-live"},
                app="test",
            )
        self.assertEqual(handler.call_args[1].get("conversation_id"), "ses-live")

    def test_codify_and_feedback_emit_records(self):
        self.state.call_tool(
            "rule_codify",
            {
                "situation": "committing",
                "statement": "run pre-commit",
                "grader": "agent",
                "stance": "prescriptive",
            },
            app="test",
        )
        self.state.call_tool("rule_feedback", {"rule_id": 1, "signal": "confirm"}, app="test")
        path = Path(self.queue_dir) / "outbound.jsonl"
        records = [json.loads(line) for line in path.read_text().splitlines()]
        kinds = [r["kind"] for r in records]
        self.assertIn("rule", kinds)
        self.assertIn("feedback", kinds)

    def test_feedback_id_alias_through_daemon(self):
        # The injection renders the key as `id`; the daemon wrapper must
        # forward it, not drop it in **kwargs (ADR 20260921). This is the
        # exact shape the 2026-09-21 private-repo session sent.
        codified = self.state.call_tool(
            "rule_codify",
            {
                "situation": "committing",
                "statement": "run pre-commit",
                "grader": "agent",
                "stance": "prescriptive",
            },
            app="test",
        )
        rule_id = codified["rule_id"]
        result = self.state.call_tool(
            "rule_feedback", {"id": str(rule_id), "signal": "confirm"}, app="test"
        )
        self.assertEqual(result["rule_id"], rule_id)
        row = self.store.conn.execute(
            "SELECT confirm_count FROM situational_rules WHERE id = ?",
            (rule_id,),
        ).fetchone()
        self.assertEqual(row["confirm_count"], 1.0)
        path = Path(self.queue_dir) / "outbound.jsonl"
        records = [json.loads(line) for line in path.read_text().splitlines()]
        feedback = [r for r in records if r["kind"] == "feedback"]
        self.assertEqual(len(feedback), 1)
        self.assertEqual(feedback[0]["payload"]["rule_id"], rule_id)

    def test_drain_classifies_and_enqueues(self):
        capture_path = os.path.join(self.queue_dir, "capture.jsonl")
        turns = [
            {
                "role": "user",
                "app": "test",
                "text": "[USER] we use make targets to deploy",
                "cwd": self.fixture.tmp,
                "conversation_id": "ses_abc12345",
                "ts": 100,
            },
            {
                "role": "user",
                "app": "test",
                "text": "```bash\n" + "x" * 500 + "\n```\n",
                "cwd": self.fixture.tmp,
                "conversation_id": "ses_abc12345",
                "ts": 101,
            },
            {"kind": "compaction", "conversation_id": "ses_abc12345"},
        ]
        with open(capture_path, "w", encoding="utf-8") as queue:
            for turn in turns:
                queue.write(json.dumps(turn) + "\n")
        with mock.patch.object(self.store, "embed", side_effect=self._stub_embed):
            result = drain_captures(self.store, self.sync, self.queue_dir)
        self.assertEqual(result["drained"], 2)
        kinds = {
            row["kind"]
            for row in self.store.conn.execute("SELECT kind FROM working_memory").fetchall()
        }
        self.assertEqual(kinds, {"speech", "exhibit"})
        path = Path(self.queue_dir) / "outbound.jsonl"
        records = [json.loads(line) for line in path.read_text().splitlines()]
        # The first turn registers its fresh session, so the wire opens
        # with the registration record the drain ships to peers.
        self.assertEqual([r["kind"] for r in records], ["session", "capture", "capture"])
        # Exhibit rows ride the record log but never consolidate.
        self.assertEqual(records[2]["payload"]["kind"], "exhibit")

    def test_drain_registers_sessions_and_mirrors_turns(self):
        capture_path = os.path.join(self.queue_dir, "capture.jsonl")
        lines = [
            {
                "role": "user",
                "app": "test",
                "text": "[USER] registry probe turn",
                "cwd": self.fixture.tmp,
                "conversation_id": "ses_reg1",
                "ts": 100,
            },
            {
                "kind": "session",
                "conversation_id": "ses_child",
                "parent_conversation_id": "ses_reg1",
                "cwd": self.fixture.tmp,
                "app": "test",
                "ts": 101,
            },
            {"kind": "compaction", "conversation_id": "ses_reg1"},
        ]
        with open(capture_path, "w", encoding="utf-8") as queue:
            for line in lines:
                queue.write(json.dumps(line) + "\n")
        with mock.patch.object(self.store, "embed", side_effect=self._stub_embed):
            result = drain_captures(self.store, self.sync, self.queue_dir)
        # The turn and the registration drain; the compaction marker counts
        # itself out as before.
        self.assertEqual(result["drained"], 2)
        working = self.store.conn.execute(
            "SELECT id FROM working_memory WHERE content LIKE '%registry probe%'"
        ).fetchone()
        # The mirror shares the working row's id and hangs off a registry
        # row stamped with the drain's provenance.
        mirror = self.store.conn.execute(
            "SELECT s.machine AS machine, s.tool AS tool "
            "FROM session_history h JOIN session s ON s.id = h.session_id "
            "WHERE h.id = ?",
            (working["id"],),
        ).fetchone()
        self.assertEqual(mirror["machine"], "local")
        self.assertEqual(mirror["tool"], "test")
        child = self.store.conn.execute(
            "SELECT id, role, parent_session_id FROM session "
            "WHERE client_conversation_id = 'ses_child'"
        ).fetchone()
        self.assertEqual(child["role"], "subagent")
        self.assertIsNotNone(child["parent_session_id"])
        parent = self.store.conn.execute(
            "SELECT client_conversation_id FROM session WHERE id = ?",
            (child["parent_session_id"],),
        ).fetchone()
        self.assertEqual(parent["client_conversation_id"], "ses_reg1")
        # Nothing registered except the two sessions — the compaction
        # marker stays out, and mirrors exist for turns only.
        got = self.store.conn.execute("SELECT COUNT(*) AS n FROM session").fetchone()["n"]
        self.assertEqual(got, 2)
        got = self.store.conn.execute("SELECT COUNT(*) AS n FROM session_history").fetchone()["n"]
        self.assertEqual(got, 1)
        # Wire: the turn's registration rides first (the row was fresh, so
        # the drain ships it to peers), then the capture, then the child's
        # own registration line.
        path = Path(self.queue_dir) / "outbound.jsonl"
        records = [json.loads(line) for line in path.read_text().splitlines()]
        self.assertEqual([r["kind"] for r in records], ["session", "capture", "session"])
        self.assertEqual(records[0]["payload"]["initiator"], "")
        self.assertEqual(records[2]["payload"]["parent_conversation_id"], "ses_reg1")

    def test_compaction_marker_forces_only_conversations_with_pending_speech(self):
        # The marker for ses_open precedes its turn line in the same batch:
        # the force decision counts rows after the drain, so it still sees
        # them. ses_done has no pending speech — its compaction writes no
        # flag, so flags cannot accumulate on conversations that can never
        # group again.
        capture_path = os.path.join(self.queue_dir, "capture.jsonl")
        lines = [
            {"kind": "compaction", "conversation_id": "ses_done"},
            {"kind": "compaction", "conversation_id": "ses_open"},
            {
                "role": "user",
                "app": "test",
                "text": "[USER] still unconsolidated",
                "cwd": self.fixture.tmp,
                "conversation_id": "ses_open",
                "ts": 100,
            },
        ]
        with open(capture_path, "w", encoding="utf-8") as queue:
            for line in lines:
                queue.write(json.dumps(line) + "\n")
        spy = ForceSpy()
        with mock.patch.object(self.store, "embed", side_effect=self._stub_embed):
            drain_captures(self.store, self.sync, self.queue_dir, consolidator=spy)
        self.assertEqual(spy.forced, ["ses_open"])

    def test_compaction_marker_for_a_consolidated_conversation_writes_no_flag(self):
        self.store.upsert_capture(
            {
                "id": "c_done",
                "content": "[USER] already summarized long ago",
                "session_id": "ses_full",
                "kind": "speech",
                "captured_by": "local",
            }
        )
        with self.store.conn:
            self.store.conn.execute(
                "UPDATE working_memory SET consolidated_at = '2026-11-18T00:00:00Z' "
                "WHERE id = 'c_done'"
            )
        capture_path = os.path.join(self.queue_dir, "capture.jsonl")
        with open(capture_path, "w", encoding="utf-8") as queue:
            queue.write(json.dumps({"kind": "compaction", "conversation_id": "ses_full"}) + "\n")
        spy = ForceSpy()
        with mock.patch.object(self.store, "embed", side_effect=self._stub_embed):
            drain_captures(self.store, self.sync, self.queue_dir, consolidator=spy)
        self.assertEqual(spy.forced, [])

    def test_duplicate_compaction_markers_force_once(self):
        # Two markers for one conversation in a single batch dedupe to
        # exactly one force write — the gate resolves each distinct
        # conversation once, however many markers carried it.
        capture_path = os.path.join(self.queue_dir, "capture.jsonl")
        lines = [
            {"kind": "compaction", "conversation_id": "ses_twice"},
            {"kind": "compaction", "conversation_id": "ses_twice"},
            {
                "role": "user",
                "app": "test",
                "text": "[USER] pending speech so the gate allows a force",
                "cwd": self.fixture.tmp,
                "conversation_id": "ses_twice",
                "ts": 100,
            },
        ]
        with open(capture_path, "w", encoding="utf-8") as queue:
            for line in lines:
                queue.write(json.dumps(line) + "\n")
        spy = ForceSpy()
        with mock.patch.object(self.store, "embed", side_effect=self._stub_embed):
            drain_captures(self.store, self.sync, self.queue_dir, consolidator=spy)
        self.assertEqual(spy.forced, ["ses_twice"])

    def test_drain_stamps_bare_when_the_turn_names_no_directory(self):
        # Resolving the daemon's own cwd for these stamped them 'unknown',
        # which reads as a workspace and matches the recall boost. A window
        # Cursor reports no roots for is unattributable, and saying so is
        # the honest stamp.
        capture_path = os.path.join(self.queue_dir, "capture.jsonl")
        turn = {
            "role": "user",
            "app": "test",
            "text": "a turn from a window that reported no directory",
            "conversation_id": "ses_noroots1",
            "ts": 100,
        }
        with open(capture_path, "w", encoding="utf-8") as queue:
            queue.write(json.dumps(turn) + "\n")
        with mock.patch.object(self.store, "embed", side_effect=self._stub_embed):
            self.assertEqual(drain_captures(self.store, self.sync, self.queue_dir)["drained"], 1)
        row = self.store.conn.execute(
            "SELECT repo FROM working_memory WHERE session_id = 'ses_noroots1'"
        ).fetchone()
        self.assertEqual(row["repo"], "")

    def test_drain_skips_a_turn_that_names_no_client(self):
        # A stored row inherits whatever client the store assumed, and
        # nothing downstream can tell that apart from a real stamp. Dropping
        # the turn is the honest outcome, and the good turn beside it still
        # lands so one bad record cannot wedge the queue.
        capture_path = os.path.join(self.queue_dir, "capture.jsonl")
        turns = [
            {
                "role": "user",
                "text": "this turn names no client at all",
                "cwd": self.fixture.tmp,
                "conversation_id": "ses_abc12345",
                "ts": 100,
            },
            {
                "role": "user",
                "app": "test",
                "text": "this turn says who queued it",
                "cwd": self.fixture.tmp,
                "conversation_id": "ses_abc12345",
                "ts": 101,
            },
        ]
        with open(capture_path, "w", encoding="utf-8") as queue:
            for turn in turns:
                queue.write(json.dumps(turn) + "\n")
        with mock.patch.object(self.store, "embed", side_effect=self._stub_embed):
            result = drain_captures(self.store, self.sync, self.queue_dir)
        self.assertEqual(result["drained"], 1)
        rows = self.store.conn.execute("SELECT content, app FROM working_memory").fetchall()
        self.assertEqual([row["app"] for row in rows], ["test"])
        self.assertEqual(rows[0]["content"], "this turn says who queued it")

    def test_drain_works_with_a_real_consolidator(self):
        """The daemon always passes one; passing None everywhere else let a
        call to a method the consolidator does not have survive, and every
        drain in production raised after the insert. The restore path then
        put the line back, so the same turn landed again on each cycle."""
        from memory_store.consolidation.client_consolidation import ClientConsolidator

        consolidator = ClientConsolidator(self.store, self.sync, "test", "0", idle_secs=1.0)
        capture_path = os.path.join(self.queue_dir, "capture.jsonl")
        turns = [
            {
                "role": "user",
                "app": "test",
                "text": "a turn worth keeping around for the drain",
                "cwd": self.fixture.tmp,
                "conversation_id": "ses_abc12345",
                "ts": 100,
            },
            {"kind": "compaction", "conversation_id": "ses_abc12345"},
        ]
        with open(capture_path, "w", encoding="utf-8") as queue:
            for turn in turns:
                queue.write(json.dumps(turn) + "\n")
        with mock.patch.object(self.store, "embed", side_effect=self._stub_embed):
            result = drain_captures(self.store, self.sync, self.queue_dir, "test", consolidator)
        self.assertEqual(result["drained"], 1)
        self.assertFalse(os.path.exists(capture_path))
        rows = self.store.conn.execute("SELECT COUNT(*) AS n FROM working_memory").fetchone()
        self.assertEqual(rows["n"], 1)

    def test_drain_does_not_require_consolidator_activity(self):
        capture_path = os.path.join(self.queue_dir, "capture.jsonl")
        with open(capture_path, "w", encoding="utf-8") as queue:
            queue.write(
                json.dumps(
                    {
                        "role": "user",
                        "app": "test",
                        "text": "ordinary captured turn",
                        "cwd": self.fixture.tmp,
                        "conversation_id": "ses_abc12345",
                        "ts": 100,
                    }
                )
                + "\n"
            )
        # Per-session eligibility means normal turns do not notify the
        # consolidator. This object deliberately has no activity method.
        result = drain_captures(self.store, self.sync, self.queue_dir, consolidator=object())
        self.assertEqual(result["drained"], 1)

    def test_drain_failure_restores_tail(self):
        # A drain that dies mid-file (a raising upsert) must put the
        # unprocessed tail — the line in flight included — back on the
        # queue. The old behavior unlinked the processing file on any
        # exception and silently dropped the undrained tail.
        capture_path = os.path.join(self.queue_dir, "capture.jsonl")
        turns = [
            {
                "role": "user",
                "app": "test",
                "text": f"turn {i}",
                "cwd": self.fixture.tmp,
                "conversation_id": "ses_x",
                "ts": 100 + i,
            }
            for i in range(3)
        ]
        with open(capture_path, "w", encoding="utf-8") as queue:
            for turn in turns:
                queue.write(json.dumps(turn) + "\n")
        real_upsert = self.store.upsert_capture
        calls = {"n": 0}

        def fail_on_second(row):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("store exploded mid-drain")
            return real_upsert(row)

        with mock.patch.object(self.store, "upsert_capture", side_effect=fail_on_second):
            with self.assertRaises(RuntimeError):
                drain_captures(self.store, self.sync, self.queue_dir)
        # Turn 1 was processed; turns 2 and 3 (the line in flight + tail)
        # are back on the queue, and no .processing file survives.
        restored = [json.loads(line) for line in open(capture_path, encoding="utf-8")]
        self.assertEqual([t["text"] for t in restored], ["turn 1", "turn 2"])
        self.assertEqual(list(Path(self.queue_dir).glob("capture.jsonl.*.processing")), [])
        # A retry drains the tail cleanly.
        result = drain_captures(self.store, self.sync, self.queue_dir)
        self.assertEqual(result["drained"], 2)

    def test_force_resolution_failure_keeps_its_own_error(self):
        # The gate resolves after the queue file is closed and unlinked,
        # outside the drain's requeue path (review 267, count 1): a
        # failure in the resolution propagates as itself on an
        # already-drained batch. Inside the try it landed in a requeue
        # written for mid-file state, which raised off the closed file
        # and masked the original error.
        capture_path = os.path.join(self.queue_dir, "capture.jsonl")
        lines = [
            {"kind": "compaction", "conversation_id": "ses_boom"},
            {
                "role": "user",
                "app": "test",
                "text": "[USER] pending speech so the gate allows a force",
                "cwd": self.fixture.tmp,
                "conversation_id": "ses_boom",
                "ts": 100,
            },
        ]
        with open(capture_path, "w", encoding="utf-8") as queue:
            for line in lines:
                queue.write(json.dumps(line) + "\n")

        class Boom:
            def force(self, session_id):
                raise RuntimeError(f"force write failed for {session_id}")

        with mock.patch.object(self.store, "embed", side_effect=self._stub_embed):
            with self.assertRaisesRegex(RuntimeError, "force write failed for ses_boom"):
                drain_captures(self.store, self.sync, self.queue_dir, consolidator=Boom())
        # The batch drained before the failure: the turn is stored, the
        # queue file is gone, nothing was requeued, no .processing file
        # was left behind.
        rows = self.store.conn.execute("SELECT COUNT(*) AS n FROM working_memory").fetchone()
        self.assertEqual(rows["n"], 1)
        self.assertFalse(os.path.exists(capture_path))
        self.assertEqual(list(Path(self.queue_dir).glob("capture.jsonl.*.processing")), [])

    def test_compaction_marker_without_conversation_id_leaves_a_trace(self):
        # A marker with no conversation_id used to reach force("") (a
        # no-op) and then vanished without a trace; the misbehaving
        # client stays visible now (review 267, count 5).
        capture_path = os.path.join(self.queue_dir, "capture.jsonl")
        with open(capture_path, "w", encoding="utf-8") as queue:
            queue.write(json.dumps({"kind": "compaction"}) + "\n")
        out = io.StringIO()
        spy = ForceSpy()
        with mock.patch.object(self.store, "embed", side_effect=self._stub_embed):
            with contextlib.redirect_stdout(out):
                result = drain_captures(self.store, self.sync, self.queue_dir, consolidator=spy)
        self.assertEqual(result["drained"], 0)
        self.assertEqual(spy.forced, [])
        self.assertIn("compaction dropped", out.getvalue())

    def test_floor_renders_where_the_caller_asked(self):
        """A floor write renders beside the store it came from. When the path
        was a module constant, any store anywhere rendered into the deployed
        data directory, and the publish skill reads that file: a test run
        overwrote the live floor with its own two-rule fixture."""
        from memory_store.server import daemon

        self.fixture.tools.persona_codify(statement="always check the wiring", topic="general")
        written = Path(self.fixture.tmp) / "floor.md"
        self.assertIn("always check the wiring", written.read_text())
        self.assertNotEqual(str(written), daemon.FLOOR_PATH)

    def _rule_writing_tools(self):
        rule_path = Path(self.fixture.tmp) / "rules" / "memory-floor.mdc"
        tools = RecordEmittingTools(
            self.store,
            "test-machine",
            self.sync,
            os.path.join(self.fixture.tmp, "floor.md"),
            floor_rule_path=str(rule_path),
        )
        return tools, rule_path

    def test_the_floor_rule_carries_frontmatter(self):
        """The rule file is the whole delivery path — nothing injects the
        floor — and Cursor applies a rule to every request only when the
        frontmatter says so."""
        tools, rule_path = self._rule_writing_tools()
        tools.persona_codify(statement="always check the wiring", topic="general")
        written = rule_path.read_text()
        self.assertTrue(written.startswith("---\n"), written[:40])
        self.assertIn("alwaysApply: true", written.split("---")[1])
        self.assertIn("always check the wiring", written)

    def test_an_emptied_floor_takes_the_rule_away(self):
        """Retiring the last rule leaves nothing to say. Writing the render
        anyway would leave frontmatter with an empty body applied to every
        request."""
        tools, rule_path = self._rule_writing_tools()
        result = tools.persona_codify(statement="always check the wiring", topic="general")
        self.assertTrue(rule_path.exists())
        tools.persona_update(rule_id=result["id"], status="retired")
        self.assertFalse(rule_path.exists())

    def test_without_a_rule_path_only_the_markdown_lands(self):
        """The path is empty unless a deployment sets it, so a store opened
        anywhere else cannot overwrite the rule the running session reads."""
        self.fixture.tools.persona_codify(statement="always check the wiring", topic="general")
        self.assertIn("always check the wiring", (Path(self.fixture.tmp) / "floor.md").read_text())
        self.assertEqual(list(Path(self.fixture.tmp).rglob("*.mdc")), [])

    def _tool_rows(self):
        for index in range(3):
            self.store.upsert_capture(
                {
                    "id": f"g{index}",
                    "content": "`gcloud auth login` when credentials expire",
                    "source": "convention",
                    "importance": 0.9,
                    "origin": "deliberate",
                    "app": "test",
                }
            )

    def test_tool_recall_answers_for_a_tool_in_command_position(self):
        self._tool_rows()
        result = self.state.tool_recall(
            {"command": "cd example && gcloud auth login", "delivery": "before"}
        )
        self.assertEqual(result["tools"], ["gcloud"])
        self.assertIn("credentials expire", result["memories"][0]["content"])

    def test_a_tool_already_told_about_is_not_told_again(self):
        """Once per tool per conversation. The second `gcloud` command of a
        session costs a round trip and nothing else."""
        self._tool_rows()
        result = self.state.tool_recall(
            {
                "command": "gcloud projects list",
                "seen_tools": ["gcloud"],
                "delivery": "before",
            }
        )
        self.assertEqual(result["tools"], [])
        self.assertEqual(result["memories"], [])

    def test_a_command_naming_no_tool_asks_nothing_of_the_store(self):
        self._tool_rows()
        result = self.state.tool_recall({"command": "rg gcloud .", "delivery": "before"})
        self.assertEqual(result["tools"], [])

    def test_tool_recall_requires_a_command(self):
        from memory_store.tools import ToolError

        with self.assertRaises(ToolError):
            self.state.tool_recall({"delivery": "before"})

    def test_the_held_back_delivery_says_the_command_has_not_run(self):
        self._tool_rows()
        result = self.state.tool_recall({"command": "gcloud auth login", "delivery": "before"})
        self.assertIn("It was held back once", result["section"])
        self.assertIn("`gcloud`", result["section"])

    def test_the_after_delivery_says_the_command_already_ran(self):
        self._tool_rows()
        result = self.state.tool_recall({"command": "gcloud auth login", "delivery": "after"})
        self.assertIn("If the command above failed", result["section"])
        self.assertNotIn("held back", result["section"])

    def test_both_deliveries_send_the_agent_to_memory_update(self):
        """Tool recall reads working rows only, so the episodic half of the
        correction instruction has no place here."""
        self._tool_rows()
        for delivery in ("before", "after"):
            section = self.state.tool_recall(
                {"command": "gcloud auth login", "delivery": delivery}
            )["section"]
            self.assertIn("memory_update", section)
            self.assertNotIn("episodic", section)

    def test_tool_recall_requires_a_delivery(self):
        """No default: the two texts disagree about whether the command has
        run, so a guess tells the agent to re-run one that never started."""
        from memory_store.tools import ToolError

        self._tool_rows()
        with self.assertRaises(ToolError):
            self.state.tool_recall({"command": "gcloud auth login"})

    def test_tool_recall_rejects_a_delivery_outside_the_enum(self):
        from memory_store.tools import ToolError

        self._tool_rows()
        with self.assertRaises(ToolError):
            self.state.tool_recall({"command": "gcloud auth login", "delivery": "during"})

    HOOK = "/nix/store/new-generation/clients/cursor/hook"

    def _hook_writing_state(self, hooks_path):
        tools = RecordEmittingTools(
            self.store,
            "test-machine",
            self.sync,
            os.path.join(self.fixture.tmp, "floor.md"),
            cursor_hooks_path=str(hooks_path),
            cursor_hook_command=self.HOOK,
        )
        return _client_shimmed(DaemonState(self.store, tools, self.sync))

    def _enrol(self, state, kind, key, note="check first"):
        state.call_tool(
            "tool_rule_add",
            {"kind": kind, "key": key, "note": note, "cwd": "/tmp/example"},
            app="test",
        )

    def _hooks(self, hooks_path):
        return json.loads(hooks_path.read_text())["hooks"]

    def test_enrolling_a_tool_puts_it_in_the_matchers(self):
        """The bindings are the enrolment, so the matchers move on the
        write: a matcher fixed at deploy time is stale by the next one."""
        hooks_path = Path(self.fixture.tmp) / "hooks.json"
        state = self._hook_writing_state(hooks_path)
        self._enrol(state, "command", "tofu plan")
        self._enrol(state, "mcp", "deploy_service")
        hooks = self._hooks(hooks_path)
        for event in ("beforeShellExecution", "preToolUse", "postToolUse"):
            with self.subTest(event=event):
                self.assertEqual([entry["command"] for entry in hooks[event]], [self.HOOK])
        self.assertIn("tofu", hooks["beforeShellExecution"][0]["matcher"])
        self.assertIn("deploy_service", hooks["postToolUse"][0]["matcher"])

    def test_removing_the_last_rule_takes_it_out_of_the_matchers(self):
        hooks_path = Path(self.fixture.tmp) / "hooks.json"
        state = self._hook_writing_state(hooks_path)
        self._enrol(state, "command", "tofu plan")
        (binding,) = self.store.tool_bindings()
        state.call_tool("tool_rule_remove", {"rule_id": binding["rule_id"]}, app="test")
        hooks = self._hooks(hooks_path)
        for event in ("beforeShellExecution", "postToolUse"):
            with self.subTest(event=event):
                self.assertEqual(
                    [e["command"] for e in hooks.get(event, []) if e["command"] == self.HOOK], []
                )
        self.assertEqual(hooks["preToolUse"][0]["matcher"], ".*")

    def test_the_matchers_select_what_cursor_sends(self):
        """Matched the way Cursor matches them: a regex search over the
        command, or over the tool name with Cursor's `MCP:` prefix."""
        import re

        matchers = daemon.cursor_tool_matchers(
            [
                {"kind": "command", "key": ["git", "push"]},
                {"kind": "mcp", "key": ["deploy_service"]},
            ],
        )
        shell = re.compile(matchers["beforeShellExecution"])
        for command in ("git push", "cd repo && git push origin", "(git push)"):
            with self.subTest(command=command):
                self.assertTrue(shell.search(command))
        for command in ("gitk", "legit push", "echo digit"):
            with self.subTest(command=command):
                self.assertFalse(shell.search(command))
        pre = re.compile(matchers["preToolUse"])
        for name in ("MCP:memory_remember", "MCP:deploy_service", "MCP:other", "Shell", "Read"):
            with self.subTest(name=name):
                self.assertTrue(pre.search(name))
        post = re.compile(matchers["postToolUse"])
        self.assertTrue(post.search("Shell"))
        self.assertTrue(post.search("MCP:deploy_service"))
        self.assertFalse(post.search("MCP:memory_remember"))

    def test_with_nothing_enrolled_only_pre_tool_use_stays(self):
        """With no bindings there is nothing to say at a tool moment, so the
        shell and post-call entries come out rather than going in wide;
        preToolUse stays for the stamps and the deferred-facts hold."""
        matchers = daemon.cursor_tool_matchers([])
        self.assertEqual(matchers["beforeShellExecution"], "")
        self.assertEqual(matchers["postToolUse"], "")
        self.assertEqual(matchers["preToolUse"], ".*")

    def test_another_tool_s_hook_survives_the_write(self):
        """hooks.json is shared with everything else the user installs, so
        this replaces our entries and leaves the file otherwise alone."""
        hooks_path = Path(self.fixture.tmp) / "hooks.json"
        hooks_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "hooks": {
                        "beforeShellExecution": [{"command": "/other/tool"}],
                        "stop": [{"command": "/other/tool"}],
                    },
                }
            )
        )
        state = self._hook_writing_state(hooks_path)
        self._enrol(state, "command", "tofu plan")
        hooks = self._hooks(hooks_path)
        self.assertEqual(
            [entry["command"] for entry in hooks["beforeShellExecution"]],
            ["/other/tool", self.HOOK],
        )
        self.assertEqual(hooks["stop"], [{"command": "/other/tool"}])

    def test_an_entry_from_an_older_generation_is_replaced(self):
        """Every rebuild moves the hook to a new store path, so an entry is
        ours by its suffix, not by the exact path this process was given.
        Matching the path alone leaves the old generation's entry firing
        beside the new one."""
        hooks_path = Path(self.fixture.tmp) / "hooks.json"
        hooks_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "hooks": {
                        "beforeShellExecution": [
                            {
                                "command": "/nix/store/old-generation/clients/cursor/hook",
                                "matcher": "stale",
                            }
                        ],
                        "preToolUse": [
                            {
                                "command": "/nix/store/old-generation/clients/cursor/hook",
                                "matcher": "stale",
                            }
                        ],
                    },
                }
            )
        )
        state = self._hook_writing_state(hooks_path)
        self._enrol(state, "command", "tofu plan")
        hooks = self._hooks(hooks_path)
        for event in ("beforeShellExecution", "preToolUse"):
            with self.subTest(event=event):
                self.assertEqual([entry["command"] for entry in hooks[event]], [self.HOOK])

    def test_a_store_with_no_bindings_drops_the_shell_hook(self):
        hooks_path = Path(self.fixture.tmp) / "hooks.json"
        hooks_path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "hooks": {"beforeShellExecution": [{"command": self.HOOK, "matcher": "stale"}]},
                }
            )
        )
        state = self._hook_writing_state(hooks_path)
        state.tools.memory_remember(content="nothing bound here", source="fact", app="test")
        hooks = self._hooks(hooks_path)
        self.assertNotIn("beforeShellExecution", hooks)
        self.assertNotIn("postToolUse", hooks)
        self.assertEqual([entry["command"] for entry in hooks["preToolUse"]], [self.HOOK])

    def test_an_unchanged_matcher_leaves_the_file_untouched(self):
        hooks_path = Path(self.fixture.tmp) / "hooks.json"
        state = self._hook_writing_state(hooks_path)
        self._enrol(state, "command", "tofu plan")
        before = hooks_path.stat().st_mtime_ns
        self._enrol(state, "command", "tofu plan", note="a second note on the same tool")
        state.tools.memory_remember(content="unrelated fact", source="fact", app="test")
        self.assertEqual(hooks_path.stat().st_mtime_ns, before)

    def test_without_a_hooks_path_nothing_is_written(self):
        """Empty unless a deployment sets it, so a store opened anywhere
        else cannot rewrite the hooks file of the session running it."""
        self._enrol(self.state, "command", "tofu plan")
        self.assertEqual(list(Path(self.fixture.tmp).rglob("hooks.json")), [])

    def test_unknown_tool_rejected(self):
        from memory_store.tools import ToolError

        with self.assertRaises(ToolError):
            self.state.call_tool("not_a_tool", {}, app="test")


class DomainPrefixTests(unittest.TestCase):
    """Every tool sits under its domain's prefix (ADR
    20261110-commands-grouped-by-domain), and the daemon dispatches only
    allowed prefixes, so a misnamed tool would be listed but uncallable."""

    def test_every_tool_carries_an_allowed_prefix(self):
        from memory_store.tools import TOOL_PREFIXES

        for name in sorted(daemon.MCP_TOOL_NAMES):
            with self.subTest(name=name):
                self.assertTrue(name.startswith(TOOL_PREFIXES))

    def test_the_renamed_tools_are_gone(self):
        for old in ("memory_kb", "memory_compliance_report", "memory_tool_rule_add"):
            with self.subTest(old=old):
                self.assertNotIn(old, daemon.MCP_TOOL_NAMES)


class RuleForgetWireTests(DaemonStateTest):
    def test_rule_forget_ships_the_forget_record(self):
        rule = self.state.call_tool(
            "rule_codify",
            {"situation": "s", "statement": "t", "grader": "agent", "stance": "prescriptive"},
            app="test",
        )
        self.state.call_tool("rule_forget", {"rule_id": rule["rule_id"]}, app="test")
        with open(os.path.join(self.queue_dir, "outbound.jsonl"), encoding="utf-8") as fh:
            records = [json.loads(line) for line in fh if line.strip()]
        self.assertEqual(
            records[-1]["payload"], {"table": "situational_rules", "id": str(rule["rule_id"])}
        )
        self.assertEqual(records[-1]["kind"], "forget")


class MatcherRerenderKindsTests(unittest.TestCase):
    """The pull-side re-render decision: enrolments and forgets re-derive
    the tool matchers, since the matchers come from the bindings; rule
    records feed the floor instead, and memory rows bind nothing."""

    def test_enrolments_and_forgets_rerender(self):
        self.assertTrue(daemon.matcher_rerender_kinds({"tool_rule": 1}))
        self.assertTrue(daemon.matcher_rerender_kinds({"forget": 1}))
        self.assertTrue(daemon.matcher_rerender_kinds({"agent_memory": 3, "tool_rule": 1}))

    def test_other_kinds_leave_the_matchers_alone(self):
        self.assertFalse(daemon.matcher_rerender_kinds({"agent_memory": 3}))
        self.assertFalse(daemon.matcher_rerender_kinds({"memory": 1}))
        self.assertFalse(daemon.matcher_rerender_kinds({"rule": 1}))
        self.assertFalse(daemon.matcher_rerender_kinds({}))


class SessionOpenTests(DaemonStateTest):
    """The session-start KB delivery: the standing doc plus the opening
    request's top-k deliberate facts, silence when there is nothing to
    say, and the render cap at the delivery site."""

    def _seed_kb(self, project="example", doc="The deploy gate is on.", inputs=("m1",)):
        self.store.upsert_kb(
            {
                "id": f"kb:{project}:1:a",
                "project": project,
                "doc": doc,
                "inputs": list(inputs),
                "build_seq": 1,
                "created_at": "2026-11-05T00:00:00Z",
            }
        )

    def _deliberate(self, row_id, content, repo="example"):
        session = self.store.get_or_create_session("hal", "opencode", f"ses_{row_id}", repo)
        self.store.upsert_agent(
            {
                "id": row_id,
                "session_id": session,
                "content": content,
                "timestamp": "2026-11-05T01:00:00Z",
                "repo": repo,
            }
        )

    def _open(self, prompt="how does the deploy gate work?", workspace="example", **extra):
        with mock.patch.object(self.store, "embed", side_effect=self._stub_embed):
            return self.state.session_open({"prompt": prompt, "workspace": workspace, **extra})

    def test_exclusions_cannot_starve_the_block(self):
        # The regression that shaped the scorer contract: folded rows are
        # the project's highest-signal facts, so a post-scoring filter
        # would leave the block under-filled while eligible matches sat
        # beyond the scorer's limit. Exclusions run inside the scorer, so
        # the cap fills from eligible rows.
        self._seed_kb(inputs=tuple(f"f{i}" for i in range(20)))
        for i in range(20):
            self._deliberate(f"f{i}", f"the deploy gate folded note {i}")
        self._deliberate("u1", "the deploy gate has a dry-run mode")
        self._deliberate("u2", "the deploy gate has a teardown target")
        self._deliberate("u3", "the deploy gate pages on failure")
        result = self._open()
        self.assertEqual(sorted(row["id"] for row in result["topk"]), ["u1", "u2", "u3"])

    def test_a_busier_sibling_repo_cannot_crowd_the_block(self):
        # The pool is cross-repo by design for the nudge, where a +0.15
        # boost is the scope's whole say; the block's facts come from the
        # project's own pool, so the scorer scopes before it ranks.
        self._seed_kb(inputs=("m1",))
        self._deliberate("u1", "the deploy gate has a dry-run mode", repo="example")
        for i in range(10):
            self._deliberate(f"o{i}", f"deploy gate note from the sibling repo {i}", repo="busier")
        result = self._open()
        self.assertEqual([row["id"] for row in result["topk"]], ["u1"])

    def test_a_repo_with_a_doc_gets_it_and_its_unfolded_matches(self):
        self._seed_kb(inputs=("m1",))
        self._deliberate("m1", "the deploy gate is on")  # already folded
        self._deliberate("m2", "the deploy gate has a dry-run mode")
        result = self._open()
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["project"], "example")
        self.assertEqual(result["doc"], "The deploy gate is on.")
        self.assertEqual(result["doc_created_at"], "2026-11-05T00:00:00Z")
        self.assertEqual(result["inputs_count"], 1)
        self.assertEqual([row["id"] for row in result["topk"]], ["m2"])
        fact = result["topk"][0]
        self.assertIn("timestamp", fact)
        self.assertIn("veracity", fact)
        self.assertIn("score", fact)

    def test_silence_for_unknown_repo_empty_prompt_and_no_repo(self):
        self._seed_kb()
        self.assertIsNone(self._open(workspace="elsewhere")["doc"])
        self.assertIsNone(self._open(prompt="")["doc"])
        self.assertIsNone(self._open(workspace="")["doc"])

    def test_episodic_summaries_never_reach_the_block(self):
        self._seed_kb()
        self.store.upsert_episodic(
            {
                "id": "e1",
                "content": "the deploy gate blocks merges",
                "timestamp": "2026-11-05T01:00:00Z",
                "repo": "example",
                "origin": "consolidated",
            }
        )
        result = self._open()
        self.assertEqual([row["id"] for row in result["topk"]], [])

    def test_the_render_cap_limits_the_block(self):
        self._seed_kb()
        self._deliberate("m2", "the deploy gate has a dry-run mode")
        self._deliberate("m3", "the deploy gate has a teardown target")
        with mock.patch.object(daemon, "KB_TOPK", 1):
            result = self._open()
        self.assertEqual(len(result["topk"]), 1)

    def test_no_model_falls_back_to_lexical_ranking(self):
        self._seed_kb()
        self._deliberate("m2", "the deploy gate has a dry-run mode")
        with mock.patch.object(
            self.store, "embed", side_effect=RuntimeError("embeddings disabled")
        ):
            result = self.state.session_open(
                {"prompt": "how does the deploy gate work?", "workspace": "example"}
            )
        self.assertEqual([row["id"] for row in result["topk"]], ["m2"])
        self.assertIn("dry-run", result["topk"][0]["content"])

    def test_the_lexical_fallback_ranks_the_same_pool(self):
        # Same pool as the scorer means the translated stragglers rank too:
        # a deliberate row still homed in working_memory was never in an
        # agent_memory delta, so neither the doc nor the exclusions carry
        # it — the block is where it surfaces.
        self._seed_kb()
        session = self.store.get_or_create_session("hal", "opencode", "ses_w1", "example")
        self.store.upsert_capture(
            {
                "id": "w1",
                "content": "the deploy gate has a dry-run mode",
                "source": "fact",
                "origin": "deliberate",
                "repo": "example",
                "app": "opencode",
                "session_id": session,
            }
        )
        self.assertEqual(
            self.store.conn.execute("SELECT COUNT(*) FROM agent_memory").fetchone()[0],
            0,
            "the row is a straggler by construction",
        )
        with mock.patch.object(
            self.store, "embed", side_effect=RuntimeError("embeddings disabled")
        ):
            result = self.state.session_open(
                {"prompt": "how does the deploy gate work?", "workspace": "example"}
            )
        self.assertEqual([row["id"] for row in result["topk"]], ["w1"])

    def test_the_lexical_fallback_honors_the_exclusions_too(self):
        self._seed_kb(inputs=("m2",))
        self._deliberate("m2", "the deploy gate has a dry-run mode")
        with mock.patch.object(
            self.store, "embed", side_effect=RuntimeError("embeddings disabled")
        ):
            result = self.state.session_open(
                {"prompt": "how does the deploy gate work?", "workspace": "example"}
            )
        self.assertEqual([row["id"] for row in result["topk"]], [])

    def test_a_deferring_client_gets_a_count_and_the_facts_wait(self):
        self._seed_kb(inputs=("m1",))
        self._deliberate("m2", "the deploy gate has a dry-run mode")
        result = self._open(defer_facts=True, conversation_id="conv-1", app="cursor")
        self.assertEqual(result["doc"], "The deploy gate is on.")
        self.assertNotIn("topk", result)
        self.assertEqual(result["facts_pending"], 1)
        deferred = self.store.session_facts_for("conv-1")
        self.assertEqual(deferred["fact_ids"], ["m2"])
        self.assertEqual(deferred["project"], "example")
        self.assertEqual(deferred["app"], "cursor")

    def test_deferring_with_no_matches_records_nothing(self):
        self._seed_kb(inputs=("m1",))
        result = self._open(defer_facts=True, conversation_id="conv-1")
        self.assertEqual(result["facts_pending"], 0)
        self.assertIsNone(self.store.session_facts_for("conv-1"))
        self.assertFalse(self.store.session_facts_take_hold("conv-1"))

    def test_deferring_without_a_conversation_inlines_as_before(self):
        self._seed_kb(inputs=("m1",))
        self._deliberate("m2", "the deploy gate has a dry-run mode")
        result = self._open(defer_facts=True)
        self.assertEqual([row["id"] for row in result["topk"]], ["m2"])
        self.assertNotIn("facts_pending", result)


class DeferredFactsFetchTests(DaemonStateTest):
    """knowledge_read hands a deferring conversation its facts, current content
    in ranked order, and the fetch settles the first-tool hold."""

    _seed_kb = SessionOpenTests._seed_kb
    _deliberate = SessionOpenTests._deliberate
    _open = SessionOpenTests._open

    def _defer(self, conversation="conv-1"):
        self._seed_kb(inputs=("m1",))
        self._deliberate("m2", "the deploy gate has a dry-run mode")
        self._deliberate("m3", "the deploy gate has a teardown target")
        self._open(defer_facts=True, conversation_id=conversation, app="cursor")

    def _kb(self, **arguments):
        return self.state.call_tool("knowledge_read", arguments, app="cursor")

    def test_the_fetch_returns_the_facts_alone_and_settles_the_hold(self):
        self._defer()
        result = self._kb(conversation_id="conv-1")
        self.assertEqual(sorted(fact["id"] for fact in result["facts"]), ["m2", "m3"])
        self.assertNotIn("docs", result)
        self.assertIn("dry-run", " ".join(fact["content"] for fact in result["facts"]))
        self.assertFalse(self.store.session_facts_take_hold("conv-1"))

    def test_a_named_project_gets_the_docs_beside_the_facts(self):
        self._defer()
        result = self._kb(conversation_id="conv-1", project="example")
        self.assertTrue(result["facts"])
        self.assertEqual([doc["project"] for doc in result["docs"]], ["example"])

    def test_a_forgotten_fact_drops_out_of_the_fetch(self):
        self._defer()
        self.state.call_tool("memory_forget", {"table": "agent_memory", "id": "m2"}, app="test")
        result = self._kb(conversation_id="conv-1")
        self.assertEqual([fact["id"] for fact in result["facts"]], ["m3"])

    def test_a_long_fact_is_elided_and_flagged(self):
        self._seed_kb(inputs=("m1",))
        self._deliberate("m2", "the deploy gate " + "detail " * 400)
        self._open(defer_facts=True, conversation_id="conv-1")
        (fact,) = self._kb(conversation_id="conv-1")["facts"]
        self.assertTrue(fact["truncated"])
        self.assertLess(len(fact["content"]), 2000)

    def test_another_conversation_gets_the_docs_as_before(self):
        self._defer()
        result = self._kb(conversation_id="conv-2")
        self.assertNotIn("facts", result)
        self.assertEqual([doc["project"] for doc in result["docs"]], ["example"])
        self.assertTrue(self.store.session_facts_take_hold("conv-1"))


class ToolMomentTests(DaemonStateTest):
    """Tool-moment delivery: deterministic matching, project-scoped
    membership, and the holds flag's two behaviors."""

    def setUp(self):
        super().setUp()
        self._holds = daemon.TOOL_HOLDS

    def tearDown(self):
        daemon.TOOL_HOLDS = self._holds
        super().tearDown()

    def _bind(
        self,
        key="git push",
        note="Run make test before pushing.",
        scope="project",
        project="example",
    ):
        tool = {
            "id": tool_key_id("command", key.split()),
            "kind": "command",
            "key": key.split(),
            "created_by": "testbox",
            "created_at": "2026-11-05T00:00:00Z",
        }
        rule = {
            "id": tool_rule_id(
                {"tool_id": tool["id"], "note": note, "scope": scope, "project": project}
            ),
            "tool_id": tool["id"],
            "note": note,
            "scope": scope,
            "project": project,
            "created_by": "testbox",
            "created_at": "2026-11-05T00:00:00Z",
        }
        self.store.bind_tool(tool, rule)
        return tool

    def _moment(self, command, conversation="c1", cwd="/tmp/example"):
        return self.state.tool_moment(
            {
                "app": "opencode",
                "conversation_id": conversation,
                "cwd": cwd,
                "event": {"kind": "command", "command": command},
            }
        )

    def test_wrapper_and_chain_fire(self):
        self._bind()
        self.assertTrue(self._moment("sudo git push origin main", "c1")["deliveries"])
        self.assertTrue(self._moment("make test && git push", "c2")["deliveries"])
        self.assertTrue(self._moment("$(git push)", "c3")["deliveries"])

    def test_quoted_prose_and_negative_are_silent(self):
        self._bind()
        self.assertEqual(self._moment("git status")["deliveries"], [])
        self.assertEqual(self._moment('echo "git push is ready"')["deliveries"], [])

    def test_project_scoped_binding_is_silent_in_a_sibling_repo(self):
        self._bind(project="example")
        self.assertEqual(self._moment("git push", cwd="/tmp/other")["deliveries"], [])

    def test_global_binding_fires_across_repos(self):
        self._bind(scope="global", project="")
        self.assertTrue(self._moment("git push", cwd="/tmp/other")["deliveries"])

    def test_holds_on_rejects_the_first_execution_only(self):
        daemon.TOOL_HOLDS = True
        self._bind(note="Run make test before pushing.")
        first = self._moment("git push", "c1")
        self.assertTrue(first["held"])
        self.assertIn("Run make test before pushing.", first["error"])
        # The refusal carries what removing the rule needs: its id and the call.
        rule_id = first["deliveries"][0]["rule_id"]
        self.assertIn(f"(rule {rule_id})", first["error"])
        self.assertIn("tool_rule_remove", first["error"])
        second = self._moment("git push", "c1")
        self.assertFalse(second["held"])
        self.assertEqual(second["error"], "")
        self.assertTrue(second["deliveries"], "later executions are informational")

    def test_holds_off_is_informational_and_still_records_the_fire(self):
        daemon.TOOL_HOLDS = False
        tool = self._bind()
        moment = self._moment("git push", "c1")
        self.assertFalse(moment["held"])
        self.assertTrue(moment["deliveries"])
        # The fire row exists with held=0: flipping the flag on later
        # does not re-reject this conversation.
        row = self.store.conn.execute(
            "SELECT held FROM tool_fires WHERE tool_id = ? AND conversation_id = ?",
            (tool["id"], "c1"),
        ).fetchone()
        self.assertEqual(row["held"], 0)

    def test_child_sessions_fire_on_their_own_conversation(self):
        daemon.TOOL_HOLDS = True
        self._bind()
        # A child session has its own conversation id, so the parent's
        # settled hold does not carry over — each fires (and is held)
        # once of its own.
        self.assertTrue(self._moment("git push", "parent")["held"])
        self.assertTrue(self._moment("git push", "child")["held"])

    def test_mcp_event_matches_under_each_clients_prefix(self):
        tool = {
            "id": tool_key_id("mcp", ["deploy"]),
            "kind": "mcp",
            "key": ["deploy"],
            "created_by": "testbox",
            "created_at": "2026-11-05T00:00:00Z",
        }
        rule = {
            "id": tool["id"] + ":r",
            "tool_id": tool["id"],
            "note": "Announce the deploy in #ops first.",
            "scope": "global",
            "project": "",
            "created_by": "testbox",
            "created_at": "2026-11-05T00:00:00Z",
        }
        self.store.bind_tool(tool, rule)
        for app, name in (("opencode", "memory_deploy"), ("cursor", "MCP:deploy")):
            with self.subTest(app=app):
                moment = self.state.tool_moment(
                    {
                        "app": app,
                        "conversation_id": f"c-{app}",
                        "cwd": "/tmp/example",
                        "event": {"kind": "mcp", "tool": name},
                    }
                )
                self.assertTrue(moment["deliveries"])

    def test_mcp_event_matches_the_canonical_name(self):
        tool = {
            "id": tool_key_id("mcp", ["deploy"]),
            "kind": "mcp",
            "key": ["deploy"],
            "created_by": "testbox",
            "created_at": "2026-11-05T00:00:00Z",
        }
        rule = {
            "id": tool["id"] + ":r",
            "tool_id": tool["id"],
            "note": "Announce the deploy in #ops first.",
            "scope": "global",
            "project": "",
            "created_by": "testbox",
            "created_at": "2026-11-05T00:00:00Z",
        }
        self.store.bind_tool(tool, rule)
        moment = self.state.tool_moment(
            {
                "app": "opencode",
                "conversation_id": "c1",
                "cwd": "/tmp/example",
                "event": {"kind": "mcp", "tool": "memory_deploy"},
            }
        )
        self.assertTrue(moment["deliveries"])

    def test_two_bindings_on_one_tool_deliver_together(self):
        # Two bindings land as two rows (different notes = different
        # rules); one moment renders both, and the hold text carries
        # every fired note.
        self._bind(note="Run make test first.")
        self._bind(note="Announce in #ops.")
        daemon.TOOL_HOLDS = True
        moment = self._moment("git push", "c1")
        self.assertEqual(len(moment["deliveries"]), 2)
        self.assertIn("Run make test first.", moment["error"])
        self.assertIn("Announce in #ops.", moment["error"])

    def test_a_global_binding_is_one_row_from_any_repo(self):
        # Global scope drops the detected project: the same note bound
        # from two repos is the same content-hash id, so the fleet
        # converges on one binding instead of one per enrolling repo.
        self._bind(key="git push", note="n", scope="global", project="")
        moment = self._moment("git push", cwd="/tmp/other")
        self.assertTrue(moment["deliveries"])
        self.assertEqual(len(self.store.tool_bindings()), 1)
        self.assertEqual(self.store.tool_bindings()[0]["project"], "")

    def test_bind_error_paths_through_the_mcp_surface(self):
        from memory_store.tools import ToolError

        for bad in (
            {"kind": "command", "key": ";", "note": "n", "cwd": "/tmp/example"},
            {"kind": "command", "key": "   ", "note": "n", "cwd": "/tmp/example"},
            {"kind": "mcp", "key": "deploy prod", "note": "n", "cwd": "/tmp/example"},
            {"kind": "command", "key": "git push", "note": "n", "scope": "bogus"},
        ):
            with self.assertRaises(ToolError):
                self.state.call_tool("tool_rule_add", bad, app="opencode")

    def test_route_rejects_an_unusable_event(self):
        from memory_store.tools import ToolError

        with self.assertRaises(ToolError):
            self.state.tool_moment({"app": "opencode", "conversation_id": "c1", "event": {}})

    def test_holds_ship_on(self):
        for raw in (None, "", "1", "on", "true", "anything"):
            with self.subTest(raw=raw):
                self.assertTrue(daemon._holds_enabled(raw))
        for raw in ("0", "off", "false", " OFF "):
            with self.subTest(raw=raw):
                self.assertFalse(daemon._holds_enabled(raw))


class SessionFactsGateTests(DaemonStateTest):
    """The first-tool hold for deferred session-start facts: one refusal
    per conversation, on any tool but this store's own, whatever the holds
    flag says, and never once the facts were fetched."""

    def setUp(self):
        super().setUp()
        self._holds = daemon.TOOL_HOLDS

    def tearDown(self):
        daemon.TOOL_HOLDS = self._holds
        super().tearDown()

    def _moment(self, kind, name, conversation="conv-1"):
        key = "command" if kind == "command" else "tool"
        return self.state.tool_moment(
            {
                "app": "cursor",
                "conversation_id": conversation,
                "cwd": "/tmp/example",
                "event": {"kind": kind, key: name},
            }
        )

    def test_the_first_tool_is_held_once_even_with_holds_off(self):
        daemon.TOOL_HOLDS = False
        self.store.session_facts_defer("conv-1", "cursor", "example", ["m1"])
        first = self._moment("tool", "Read")
        self.assertTrue(first["held"])
        self.assertIn("knowledge_read", first["error"])
        self.assertFalse(self._moment("tool", "Read")["held"])

    def test_the_store_s_own_tools_pass_and_do_not_spend_the_hold(self):
        self.store.session_facts_defer("conv-1", "cursor", "example", ["m1"])
        self.assertFalse(self._moment("mcp", "MCP:memory_recall")["held"])
        self.assertTrue(self._moment("tool", "Grep")["held"])

    def test_another_server_s_mcp_tool_is_held(self):
        self.store.session_facts_defer("conv-1", "cursor", "example", ["m1"])
        self.assertTrue(self._moment("mcp", "MCP:deploy")["held"])

    def test_a_fetch_first_means_no_hold(self):
        self.store.session_facts_defer("conv-1", "cursor", "example", ["m1"])
        self.store.session_facts_mark_fetched("conv-1")
        self.assertFalse(self._moment("tool", "Read")["held"])

    def test_a_conversation_with_nothing_deferred_is_never_held(self):
        self.assertFalse(self._moment("tool", "Read")["held"])
        self.assertFalse(self._moment("command", "git status")["held"])

    def test_the_facts_hold_leaves_a_binding_its_own_hold(self):
        daemon.TOOL_HOLDS = True
        ToolMomentTests._bind(self, key="git push", note="Run make test first.")
        self.store.session_facts_defer("conv-1", "cursor", "example", ["m1"])
        first = self._moment("command", "git push")
        self.assertIn("knowledge_read", first["error"])
        second = self._moment("command", "git push")
        self.assertTrue(second["held"])
        self.assertIn("Run make test first.", second["error"])


class ToolRuleCurationTests(DaemonStateTest):
    """Cross-project curation (PRJ-168): the lookup labels every rule on a
    key for the calling project, promote widens a project-scoped rule to
    global and retires the source (tombstone first semantics — twin then
    forget, and the original enrollment's replay must not resurrect it),
    and copy adopts a rule into the calling project."""

    def setUp(self):
        super().setUp()
        self._holds = daemon.TOOL_HOLDS

    def tearDown(self):
        daemon.TOOL_HOLDS = self._holds
        super().tearDown()

    def _seed(
        self,
        key="git push",
        note="Run make test before pushing.",
        scope="project",
        project="example",
    ):
        """Enroll straight into the store, as another project's session
        would have (fixed timestamps; the ids are content hashes)."""
        tool = {
            "id": tool_key_id("command", key.split()),
            "kind": "command",
            "key": key.split(),
            "created_by": "other-machine",
            "created_at": "2026-11-08T00:00:00Z",
        }
        rule = {
            "id": tool_rule_id(
                {"tool_id": tool["id"], "note": note, "scope": scope, "project": project}
            ),
            "tool_id": tool["id"],
            "note": note,
            "scope": scope,
            "project": project,
            "created_by": "other-machine",
            "created_at": "2026-11-08T00:00:00Z",
        }
        self.store.bind_tool(tool, rule)
        return {**tool, "rule": rule}

    def _seed_record(self, seeded):
        """The wire record the seed's enrollment would have shipped — the
        delayed replay a tombstone must refuse."""
        return {
            "record_id": "seeded-enrollment",
            "kind": "tool_rule",
            "machine_id": "other-machine",
            "occurred_at": "2026-11-08T00:00:00Z",
            "payload": {
                "tool": {k: seeded[k] for k in ("id", "kind", "key", "created_by", "created_at")},
                "rule": seeded["rule"],
            },
        }

    def _outbound_kinds(self):
        path = os.path.join(self.queue_dir, "outbound.jsonl")
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as fh:
            return [json.loads(line)["kind"] for line in fh if line.strip()]

    def _lookup(self, cwd="/tmp/example", key="git push", kind="command"):
        return self.state.call_tool(
            "tool_rule_lookup",
            {"kind": kind, "key": key, "cwd": cwd},
            app="opencode",
        )

    def test_lookup_labels_global_own_and_foreign(self):
        self._seed(note="example's gate", project="example")
        self._seed(note="the fleet-wide gate", scope="global", project="")
        result = self._lookup(cwd="/tmp/example")
        by_note = {row["note"]: row for row in result["rules"]}
        self.assertTrue(by_note["example's gate"]["visible_here"])
        self.assertTrue(by_note["the fleet-wide gate"]["visible_here"])
        other = self._lookup(cwd="/tmp/other")
        other_by_note = {row["note"]: row for row in other["rules"]}
        self.assertFalse(other_by_note["example's gate"]["visible_here"])
        self.assertTrue(other_by_note["the fleet-wide gate"]["visible_here"])
        # Every row stays listed in both projects: the lookup's whole
        # point is that hidden rules are discoverable, just labeled.
        self.assertEqual(len(other["rules"]), 2)

    def test_lookup_errors_without_a_project(self):
        self._seed()
        from memory_store.tools import ToolError

        with self.assertRaises(ToolError):
            self._lookup(cwd="")
        with self.assertRaises(ToolError):
            self._lookup(key=";")

    def test_promote_widens_and_retires_and_refuses_resurrection(self):
        seeded = self._seed(note="example's gate", project="example")
        result = self.state.call_tool(
            "tool_rule_promote",
            {"rule_id": seeded["rule"]["id"], "conversation_id": "c-promote"},
            app="opencode",
        )
        self.assertEqual(result["status"], "ok")
        # The twin: global, same note, same tool.
        bindings = self.store.tool_bindings()
        self.assertEqual(len(bindings), 1)
        self.assertEqual(bindings[0]["scope"], "global")
        self.assertEqual(bindings[0]["project"], "")
        self.assertEqual(bindings[0]["note"], "example's gate")
        self.assertEqual(bindings[0]["conversation_id"], "c-promote")
        # The wire order is twin first, removal second.
        self.assertEqual(self._outbound_kinds(), ["tool_rule", "forget"])
        # The delayed replay of the ORIGINAL enrollment must not bring the
        # project-scoped row back on this machine.
        self.sync.apply(self._seed_record(seeded))
        self.assertEqual(len(self.store.tool_bindings()), 1)
        self.assertEqual(self.store.tool_bindings()[0]["scope"], "global")
        # And the twin id is what the store landed on.
        self.assertEqual(bindings[0]["rule_id"], result["promoted_rule_id"])

    def test_promote_errors_on_global_and_missing_sources(self):
        from memory_store.tools import ToolError

        seeded = self._seed(scope="global", project="")
        with self.assertRaises(ToolError):
            self.state.call_tool(
                "tool_rule_promote", {"rule_id": seeded["rule"]["id"]}, app="opencode"
            )
        with self.assertRaises(ToolError):
            self.state.call_tool("tool_rule_promote", {"rule_id": "tr_nope"}, app="opencode")

    def test_remove_retires_the_rule_and_refuses_resurrection(self):
        from memory_store.tools import ToolError

        seeded = self._seed(note="example's gate", project="example")
        result = self.state.call_tool(
            "tool_rule_remove", {"rule_id": seeded["rule"]["id"]}, app="opencode"
        )
        self.assertEqual(result["removed_rule_id"], seeded["rule"]["id"])
        self.assertEqual(self.store.tool_bindings(), [])
        self.assertEqual(self._outbound_kinds(), ["forget"])
        self.sync.apply(self._seed_record(seeded))
        self.assertEqual(self.store.tool_bindings(), [], "the tombstone refuses the replay")
        with self.assertRaises(ToolError):
            self.state.call_tool(
                "tool_rule_remove", {"rule_id": seeded["rule"]["id"]}, app="opencode"
            )
        with self.assertRaises(ToolError):
            self.state.call_tool("tool_rule_remove", {"rule_id": "tr_nope"}, app="opencode")

    def test_remove_leaves_a_copy_of_the_same_note(self):
        seeded = self._seed(note="example's gate", project="example")
        copied = self.state.call_tool(
            "tool_rule_copy",
            {"rule_id": seeded["rule"]["id"], "cwd": "/tmp/other"},
            app="opencode",
        )
        self.state.call_tool("tool_rule_remove", {"rule_id": seeded["rule"]["id"]}, app="opencode")
        remaining = [b["rule_id"] for b in self.store.tool_bindings()]
        self.assertEqual(remaining, [copied["rule_id"]])

    def test_copy_adopts_into_the_calling_project(self):
        seeded = self._seed(note="example's gate", project="example")
        result = self.state.call_tool(
            "tool_rule_copy",
            {"rule_id": seeded["rule"]["id"], "cwd": "/tmp/other", "conversation_id": "c-copy"},
            app="opencode",
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["project"], "other")
        bindings = self.store.tool_bindings()
        self.assertEqual(len(bindings), 2)
        copied = next(row for row in bindings if row["project"] == "other")
        self.assertEqual(copied["note"], "example's gate")
        self.assertEqual(copied["scope"], "project")
        self.assertEqual(copied["conversation_id"], "c-copy")
        self.assertEqual(copied["tool_id"], seeded["id"], "the copy references the same enrollment")
        # The copy ships its own enrollment record, nothing else.
        self.assertEqual(self._outbound_kinds(), ["tool_rule"])

    def test_copy_refuses_self_and_identical(self):
        from memory_store.tools import ToolError

        seeded = self._seed(note="example's gate", project="example")
        with self.assertRaises(ToolError):
            self.state.call_tool(
                "tool_rule_copy",
                {"rule_id": seeded["rule"]["id"], "cwd": "/tmp/example"},
                app="opencode",
            )
        # A global source is copyable; a second identical copy is the same
        # content-addressed id and is refused as already-carried.
        global_seeded = self._seed(note="the fleet-wide gate", scope="global", project="")
        self.state.call_tool(
            "tool_rule_copy",
            {"rule_id": global_seeded["rule"]["id"], "cwd": "/tmp/other"},
            app="opencode",
        )
        with self.assertRaises(ToolError):
            self.state.call_tool(
                "tool_rule_copy",
                {"rule_id": global_seeded["rule"]["id"], "cwd": "/tmp/other"},
                app="opencode",
            )

    def test_add_refuses_a_forgotten_rule(self):
        from memory_store.tools import ToolError

        seeded = self._seed(note="example's gate", project="example")
        self.store.forget("tool_rules", seeded["rule"]["id"])
        with self.assertRaises(ToolError):
            self.state.call_tool(
                "tool_rule_add",
                {
                    "kind": "command",
                    "key": "git push",
                    "note": "example's gate",
                    "cwd": "/tmp/example",
                },
                app="opencode",
            )

    def test_hold_continuity_survives_promotion(self):
        # The hold ledger is keyed on the TOOL id, which promotion never
        # changes: a conversation that already ran the tool does not get
        # re-held by the twin, and a fresh conversation is held once.
        daemon.TOOL_HOLDS = True
        seeded = self._seed(note="Run make test before pushing.", project="example")

        def moment(conversation):
            return self.state.tool_moment(
                {
                    "app": "opencode",
                    "conversation_id": conversation,
                    "cwd": "/tmp/example",
                    "event": {"kind": "command", "command": "git push"},
                }
            )

        first = moment("c1")
        self.assertTrue(first["held"])
        self.state.call_tool("tool_rule_promote", {"rule_id": seeded["rule"]["id"]}, app="opencode")
        later = moment("c1")
        self.assertFalse(
            later["held"], "the hold is per tool+conversation; promotion is not a second hold"
        )
        self.assertTrue(later["deliveries"], "the twin still delivers informationally")
        self.assertTrue(moment("c2")["held"], "a fresh conversation is held once by the twin")

    def test_mcp_key_lookup_round_trips(self):
        tool = {
            "id": tool_key_id("mcp", ["deploy"]),
            "kind": "mcp",
            "key": ["deploy"],
            "created_by": "other-machine",
            "created_at": "2026-11-08T00:00:00Z",
        }
        rule = {
            "id": tool_rule_id(
                {
                    "tool_id": tool["id"],
                    "note": "Announce in #ops.",
                    "scope": "global",
                    "project": "",
                }
            ),
            "tool_id": tool["id"],
            "note": "Announce in #ops.",
            "scope": "global",
            "project": "",
            "created_by": "other-machine",
            "created_at": "2026-11-08T00:00:00Z",
        }
        self.store.bind_tool(tool, rule)
        result = self._lookup(kind="mcp", key="deploy")
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["rules"][0]["rule_id"], rule["id"])
        self.assertEqual(result["tool_id"], tool["id"])
        self.assertTrue(result["rules"][0]["visible_here"])


class StartupRetryTests(unittest.TestCase):
    """The boot-time retry of records an older version set aside."""

    def _run(self, sync) -> str:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            daemon._retry_deferred_at_startup(sync)
        return output.getvalue()

    def test_reports_what_it_applied_or_set_aside_again(self):
        sync = mock.Mock()
        sync.retry_deferred.return_value = {"applied": 2, "by_kind": {}, "deferred": 1}
        self.assertEqual(self._run(sync).count("deferred records at startup"), 1)

    def test_stays_quiet_when_nothing_was_waiting(self):
        sync = mock.Mock()
        sync.retry_deferred.return_value = {"applied": 0, "by_kind": {}, "deferred": 0}
        self.assertEqual(self._run(sync), "")

    def test_a_failure_is_logged_and_never_stops_the_daemon(self):
        sync = mock.Mock()
        sync.retry_deferred.side_effect = RuntimeError("store locked")
        self.assertIn("deferred retry failed", self._run(sync))


if __name__ == "__main__":
    unittest.main()
