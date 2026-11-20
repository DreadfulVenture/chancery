"""Lineage-gated writes (PRD 20261114-lineage-gated-writes): the registry
resolves a conversation's line to its root, the daemon gates the write
surface on it, attribution is stamped by the daemon, and unattended
learning never reads an unanchored conversation. The initiator rides the
connection (the deployment's declaration), never the model's arguments."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../..")

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.consolidation.consolidation import next_consolidation_group  # noqa: E402
from memory_store.server.daemon import DaemonState, RecordEmittingTools, drain_captures  # noqa: E402
from memory_store.kb import delta_scan  # noqa: E402
from memory_store.store import Store  # noqa: E402
from memory_store.sync import SyncClient  # noqa: E402
from memory_store.tools import ToolError  # noqa: E402


class LineageFixture:
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="lineage-test-")
        self.queue_dir = os.path.join(self.tmp, "queue")
        os.makedirs(self.queue_dir)
        self.store = Store(Path(self.tmp) / "memory.db")
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

    def session(self, conversation_id, initiator="", parent=None):
        return self.store.get_or_create_session(
            "test-machine",
            "test",
            conversation_id,
            parent_conversation_id=parent,
            initiator=initiator,
        )

    def call(self, name, arguments, *, connection_initiator="", app="test"):
        return self.state.call_tool(
            name, arguments, app=app, connection_initiator=connection_initiator
        )


class LineageResolutionTests(unittest.TestCase):
    """The registry walk: root initiator + depth, the one-time backfill,
    and the fail-closed corners."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="lineage-test-")
        self.path = Path(self.tmp) / "memory.db"

    def tearDown(self):
        pass

    def test_a_human_session_reads_depth_zero(self):
        store = Store(self.path)
        store.get_or_create_session("m", "test", "hum", initiator="human")
        self.assertEqual(store.session_lineage("m", "test", "hum"), ("human", 0))
        self.assertEqual(store.conversation_class("m", "test", "hum"), "human")
        store.close()

    def test_a_child_of_a_human_session_is_driven(self):
        store = Store(self.path)
        store.get_or_create_session("m", "test", "hum", initiator="human")
        store.get_or_create_session(
            "m", "test", "kid", initiator="agent", parent_conversation_id="hum"
        )
        self.assertEqual(store.session_lineage("m", "test", "kid"), ("human", 1))
        self.assertEqual(store.conversation_class("m", "test", "kid"), "driven")
        store.close()

    def test_an_agent_root_is_unanchored_at_any_depth(self):
        store = Store(self.path)
        store.get_or_create_session("m", "test", "bot", initiator="agent")
        store.get_or_create_session(
            "m", "test", "sub", initiator="agent", parent_conversation_id="bot"
        )
        self.assertEqual(store.session_lineage("m", "test", "bot"), ("agent", 0))
        self.assertEqual(store.conversation_class("m", "test", "sub"), "unanchored")
        store.close()

    def test_the_backfill_stamps_preexisting_rows_human(self):
        # A row that predates the initiator column carries '' — the
        # one-time backfill stamps it human at the next open, because
        # every client then was human-driven. Rewinding the flag replays
        # the migration over this row.
        store = Store(self.path)
        store.get_or_create_session("m", "test", "old")
        self.assertEqual(
            (store.conn.execute("SELECT initiator FROM session").fetchone())["initiator"], ""
        )
        store._meta_set("legacy_initiator_backfilled", "")
        store._backfill_legacy_initiators()
        self.assertEqual(store.session_lineage("m", "test", "old"), ("human", 0))
        store.close()

    def test_rows_created_after_the_backfill_fail_closed(self):
        # The backfill runs once; a row created afterwards with no stated
        # initiator is unidentified lineage and resolves agent.
        store = Store(self.path)
        store.get_or_create_session("m", "test", "fresh")
        self.assertEqual(store.session_lineage("m", "test", "fresh"), ("agent", 0))
        self.assertEqual(store.conversation_class("m", "test", "fresh"), "unanchored")
        store.close()

    def test_a_cycle_fails_closed(self):
        store = Store(self.path)
        root_id = store.get_or_create_session("m", "test", "hum", initiator="human")
        kid_id = store.get_or_create_session(
            "m", "test", "kid", initiator="agent", parent_conversation_id="hum"
        )
        store.conn.execute(
            "UPDATE session SET parent_session_id = ? WHERE id = ?", (kid_id, root_id)
        )
        self.assertEqual(store.conversation_class("m", "test", "kid"), "unanchored")
        store.close()

    def test_an_unknown_conversation_is_absent(self):
        store = Store(self.path)
        self.assertEqual(store.session_lineage("m", "test", "nope"), ("", -1))
        self.assertEqual(store.conversation_class("m", "test", "nope"), "absent")
        store.close()


class LineageGateTests(unittest.TestCase):
    """The daemon's write gate: refusal, the observation grant, and
    daemon-decided attribution on both tool paths. The initiator arrives
    on the connection; a value in the arguments is stripped."""

    def setUp(self):
        self.fixture = LineageFixture()
        self.store = self.fixture.store
        self.state = self.fixture.state

    def tearDown(self):
        self.store.close()

    def _remember(self, connection_initiator="human", conversation=None, **kwargs):
        arguments = {"content": "a fact", **kwargs}
        if conversation is not None:
            arguments["conversation_id"] = conversation
        return self.fixture.call(
            "memory_remember", arguments, connection_initiator=connection_initiator
        )

    def _agent_rows(self):
        return self.store.conn.execute(
            "SELECT content, author_type, source, scope, importance, veracity FROM agent_memory"
        ).fetchall()

    def test_a_human_session_writes_without_an_author_stamp(self):
        self.fixture.session("hum", initiator="human")
        self._remember(conversation="hum")
        rows = self._agent_rows()
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["author_type"])

    def test_driven_writes_are_agent_attributed(self):
        self.fixture.session("hum", initiator="human")
        self.fixture.session("kid", initiator="agent", parent="hum")
        self._remember(
            connection_initiator="human", conversation="kid", content="the chain learned this"
        )
        rows = self._agent_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["author_type"], "agent")

    def test_driven_keeps_the_full_write_surface(self):
        self.fixture.session("hum", initiator="human")
        self.fixture.session("kid", initiator="agent", parent="hum")
        result = self.fixture.call(
            "rule_codify",
            {
                "situation": "deploying",
                "statement": "check first",
                "grader": "agent",
                "stance": "prescriptive",
                "conversation_id": "kid",
            },
            connection_initiator="human",
        )
        self.assertEqual(result["status"], "ok")

    def test_unanchored_steering_labels_are_refused(self):
        self.fixture.session("bot", initiator="agent")
        for label in ("rule", "preference", "convention", "correction", "stated"):
            with self.subTest(label=label):
                with self.assertRaises(ToolError) as caught:
                    self._remember(connection_initiator="agent", conversation="bot", source=label)
                self.assertIn("human-started", str(caught.exception))

    def test_unanchored_observations_are_stamped_and_clamped(self):
        self.fixture.session("bot", initiator="agent")
        self._remember(
            connection_initiator="agent",
            conversation="bot",
            source="fact",
            content="the docs live in docs/",
            importance=0.95,
            veracity="verified",
            scope="global",
        )
        rows = self._agent_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["author_type"], "agent")
        self.assertEqual(rows[0]["source"], "fact")
        # The grant carries no self-certified metadata: the row is the
        # agent's say-so at the store's default weight, project-scoped.
        self.assertEqual(rows[0]["scope"], "project")
        self.assertEqual(rows[0]["importance"], 0.5)
        self.assertEqual(rows[0]["veracity"], "inferred")

    def test_unanchored_observations_default_to_fact(self):
        self.fixture.session("bot", initiator="agent")
        self._remember(connection_initiator="agent", conversation="bot")
        rows = self._agent_rows()
        self.assertEqual(rows[0]["source"], "fact")
        self.assertEqual(rows[0]["author_type"], "agent")

    def test_unanchored_behaviour_writes_are_refused(self):
        self.fixture.session("bot", initiator="agent")
        for name, arguments in (
            ("memory_update", {"id": "m1", "content": "rewritten"}),
            ("memory_forget", {"table": "agent_memory", "id": "m1"}),
            ("persona_codify", {"topic": "t", "rule": "r"}),
            ("rule_forget", {"rule_id": 1}),
            ("rule_feedback", {"rule_id": 1, "signal": "confirm"}),
            ("tool_rule_remove", {"rule_id": "tr_x"}),
        ):
            with self.subTest(tool=name):
                with self.assertRaises(ToolError) as caught:
                    self.fixture.call(
                        name, {**arguments, "conversation_id": "bot"}, connection_initiator="agent"
                    )
                self.assertIn("human-started", str(caught.exception))

    def test_an_unregistered_conversation_refuses_everything_but_the_grant(self):
        with self.assertRaises(ToolError) as caught:
            self.fixture.call("memory_update", {"id": "m1", "content": "x"})
        self.assertIn("not registered", str(caught.exception))
        # No conversation, no declaration: the observation grant is all a
        # bare write gets, stamped agent.
        self._remember(content="a bare observation", connection_initiator="")
        rows = self._agent_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["author_type"], "agent")

    def test_a_declared_human_connection_writes_unregistered(self):
        # The connection declares human; a session's first write can
        # outrun the registration that would have landed at session open.
        self._remember(conversation="fresh", connection_initiator="human")
        rows = self._agent_rows()
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["author_type"])
        row = self.store.conn.execute(
            "SELECT initiator FROM session WHERE machine = ? AND tool = ? "
            "AND client_conversation_id = ?",
            ("test-machine", "test", "fresh"),
        ).fetchone()
        self.assertEqual(row["initiator"], "human")

    def test_a_declared_agent_connection_creates_an_agent_row(self):
        # The bot's connection declares agent; the row its first write
        # creates must not read legacy-human, or the second write passes
        # the gate open.
        self._remember(conversation="bot-fresh", connection_initiator="agent")
        with self.assertRaises(ToolError) as caught:
            self.fixture.call(
                "memory_update",
                {"id": "m1", "content": "x", "conversation_id": "bot-fresh"},
                connection_initiator="agent",
            )
        self.assertIn("human-started", str(caught.exception))

    def test_a_forged_argument_is_stripped_on_every_path(self):
        # The daemon decides attribution and lineage; nothing the model
        # puts in the arguments reaches either.
        self.fixture.session("hum", initiator="human")
        self.fixture.call(
            "memory_remember",
            {
                "content": "a fact",
                "conversation_id": "hum",
                "initiator": "agent",
                "author_type": "human",
                "author_id": "hal",
            },
            connection_initiator="human",
        )
        rows = self._agent_rows()
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["author_type"])

    def test_junk_metadata_refuses_cleanly_instead_of_crashing(self):
        self.fixture.session("bot", initiator="agent")
        for junk in (123, {"deep": True}, ["list"]):
            with self.subTest(junk=junk):
                result = self._remember(
                    connection_initiator="agent",
                    conversation="bot",
                    importance=junk,
                )
                self.assertEqual(result["status"], "ok")
        rows = self._agent_rows()
        self.assertEqual([row["importance"] for row in rows], [0.5, 0.5, 0.5])


class ParentBackfillTests(unittest.TestCase):
    """A write can create the row before the registration line drains; the
    link the line carries must land anyway."""

    def setUp(self):
        self.fixture = LineageFixture()
        self.store = self.fixture.store
        self.state = self.fixture.state

    def tearDown(self):
        self.store.close()

    def test_a_late_registration_backfills_the_parent(self):
        self.fixture.session("hum", initiator="human")
        # The child's observation write lands first: row created, no
        # parent, resolves unanchored.
        self.fixture.call(
            "memory_remember",
            {"content": "early observation", "conversation_id": "kid"},
            connection_initiator="agent",
        )
        self.assertEqual(self.store.conversation_class("test-machine", "test", "kid"), "unanchored")
        # The registration line drains: parent link and stated initiator
        # land on the existing row.
        self.fixture.session("kid", initiator="agent", parent="hum")
        self.assertEqual(self.store.session_lineage("test-machine", "test", "kid"), ("human", 1))
        self.assertEqual(self.store.conversation_class("test-machine", "test", "kid"), "driven")

    def test_a_fabricated_parent_never_reads_human(self):
        # The bot registers against a parent id that has no row: the
        # placeholder resolves agent — the refusing direction — and stays
        # there until a real registration names it.
        self.fixture.session("kid", initiator="agent", parent="fabricated-uuid")
        self.assertEqual(self.store.session_lineage("test-machine", "test", "kid"), ("agent", 1))
        self.assertEqual(self.store.conversation_class("test-machine", "test", "kid"), "unanchored")
        with self.assertRaises(ToolError) as caught:
            self.fixture.call(
                "rule_codify",
                {
                    "situation": "deploying",
                    "statement": "check first",
                    "grader": "agent",
                    "stance": "prescriptive",
                    "conversation_id": "kid",
                },
                connection_initiator="agent",
            )
        self.assertIn("human-started", str(caught.exception))


class UnanchoredReadRedactionTests(unittest.TestCase):
    """Provenance pointers leave with the caller's class: an unanchored
    caller learns no valid parent session id from a read — through
    session_id, source_conversation, or the summary_of key on episodic
    rows, and not by way of memory_get."""

    def setUp(self):
        self.fixture = LineageFixture()
        self.store = self.fixture.store
        self.state = self.fixture.state
        self.store.vec_available = False

    def tearDown(self):
        self.store.close()

    def _seed(self, conversation_id):
        self.store.upsert_capture(
            {
                "id": f"c-{conversation_id}",
                "content": "deploy via make targets",
                "source": "",
                "kind": "speech",
                "repo": "example",
                "origin": "capture",
                "app": "test",
                "captured_by": "test-machine",
                "session_id": conversation_id,
                "author_type": "human",
            }
        )
        self.fixture.session(conversation_id, initiator="human")

    def _embed(self):
        return mock.patch.object(
            self.store, "embed", side_effect=lambda texts, origin=None: [[1.0] for _ in texts]
        )

    def test_a_human_caller_sees_the_pointers(self):
        self._seed("hum")
        with self._embed():
            result = self.fixture.call(
                "memory_find_conversations",
                {"query": "deploy", "conversation_id": "hum"},
                connection_initiator="human",
            )
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["pointers"][0]["session_id"], "hum")

    def test_an_unanchored_caller_does_not(self):
        self._seed("hum")
        self.fixture.session("bot", initiator="agent")
        with self._embed():
            result = self.fixture.call(
                "memory_find_conversations",
                {"query": "deploy", "conversation_id": "bot"},
                connection_initiator="agent",
            )
        self.assertEqual(result["count"], 1)
        self.assertNotIn("session_id", result["pointers"][0])

    def test_memory_get_hides_session_ids_from_unanchored_callers(self):
        self._seed("hum")
        self.fixture.session("bot", initiator="agent")
        row_id = "c-hum"
        with self._embed():
            human = self.fixture.call("memory_get", {"id": row_id}, connection_initiator="human")
            bot = self.fixture.call("memory_get", {"id": row_id}, connection_initiator="agent")
        self.assertEqual(human["record"]["session_id"], "hum")
        self.assertNotIn("session_id", bot["record"])


class CaptureAndLearningTests(unittest.TestCase):
    """The drain stamps driven and unanchored user turns as the agent voice
    they are, registers fresh sessions to peers, and consolidation plus the
    KB never read an unanchored line."""

    def setUp(self):
        self.fixture = LineageFixture()
        self.store = self.fixture.store
        self.sync = self.fixture.sync
        self.queue_dir = self.fixture.queue_dir

    def tearDown(self):
        self.store.close()

    def _queue(self, record):
        with open(os.path.join(self.queue_dir, "capture.jsonl"), "a") as handle:
            handle.write(json.dumps(record) + "\n")

    def _capture_turn(
        self, conversation_id, role="user", text="the human said this", initiator=None
    ):
        record = {
            "role": role,
            "text": text,
            "cwd": self.fixture.tmp,
            "app": "test",
            "conversation_id": conversation_id,
            "ts": 1700000000,
        }
        if initiator is not None:
            record["initiator"] = initiator
        self._queue(record)

    def _drain(self):
        return drain_captures(self.store, self.sync, self.queue_dir, machine_id="test-machine")

    def _history_author(self, conversation_id):
        row = self.store.conn.execute(
            "SELECT author_type FROM session_history WHERE session_id = "
            "(SELECT id FROM session WHERE client_conversation_id = ?)",
            (conversation_id,),
        ).fetchone()
        return row["author_type"] if row else None

    def test_driven_user_turns_are_agent_stamped(self):
        self.fixture.session("hum", initiator="human")
        self.fixture.session("kid", initiator="agent", parent="hum")
        self._capture_turn("kid")
        self._drain()
        self.assertEqual(self._history_author("kid"), "agent")

    def test_human_user_turns_keep_their_stamp(self):
        self.fixture.session("hum", initiator="human")
        self._capture_turn("hum")
        self._drain()
        self.assertEqual(self._history_author("hum"), "human")

    def test_a_turn_that_registers_a_session_ships_the_registration(self):
        self._capture_turn("fresh", initiator="human")
        self._drain()
        records = [
            json.loads(line)
            for line in Path(self.queue_dir, "outbound.jsonl").read_text().splitlines()
        ]
        sessions = [r for r in records if r["kind"] == "session"]
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["payload"]["initiator"], "human")

    def test_unanchored_conversations_never_consolidate(self):
        for conversation_id, initiator in (("hum", "human"), ("bot", "agent")):
            self.fixture.session(conversation_id, initiator=initiator)
            self._capture_turn(conversation_id, text=f"speech in {conversation_id}")
        self._drain()
        groups = next_consolidation_group(self.store)
        self.assertIn("hum", groups)
        self.assertNotIn("bot", groups)

    def test_agent_rows_never_feed_the_kb(self):
        self.fixture.session("hum", initiator="human")
        session_id = self.store.conn.execute(
            "SELECT id FROM session WHERE client_conversation_id = 'hum'"
        ).fetchone()["id"]
        self.store.upsert_agent(
            {
                "id": "m-human",
                "session_id": session_id,
                "content": "the gateway owns the docs",
                "repo": "example",
                "timestamp": "2026-11-14T00:00:00Z",
                "author_type": None,
            }
        )
        self.store.upsert_agent(
            {
                "id": "m-bot",
                "session_id": session_id,
                "content": "the bot observed something",
                "repo": "example",
                "timestamp": "2026-11-14T00:00:01Z",
                "author_type": "agent",
            }
        )
        taken = delta_scan(self.store)["example"]
        self.assertEqual([row["id"] for row in taken], ["m-human"])


if __name__ == "__main__":
    unittest.main()
