"""Tests for the owned store: schema, upserts, budget, feedback, forget."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store import spans
from memory_store.store import (
    EMBEDDING_DIM,
    EMBEDDING_MODEL,
    FEEDBACK_SIGNALS,
    Store,
    normalize_signal,
    validate_record,
)
from memory_store.sync import RecordContractError, SyncClient


def make_store(tmpdir: str) -> Store:
    return Store(Path(tmpdir) / "test.db")


class CaptureUpsertTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = make_store(self.tmp)

    def tearDown(self):
        self.store.close()

    def test_capture_upsert_is_idempotent(self):
        row = {
            "id": "abc123",
            "content": "[USER] hello world",
            "source": "cursor:example:ses_1",
            "kind": "speech",
        }
        self.store.upsert_capture(row)
        self.store.upsert_capture(dict(row, importance=0.9))  # same content: no-op
        got = self.store.conn.execute(
            "SELECT importance FROM working_memory WHERE id = 'abc123'"
        ).fetchone()
        self.assertEqual(got["importance"], 0.5)

    def test_capture_update_on_content_change(self):
        self.store.upsert_capture({"id": "abc", "content": "one", "source": "cursor:x:1"})
        self.store.upsert_capture({"id": "abc", "content": "two", "source": "cursor:x:1"})
        got = self.store.conn.execute(
            "SELECT content FROM working_memory WHERE id = 'abc'"
        ).fetchone()
        self.assertEqual(got["content"], "two")

    def test_kind_lands_in_row(self):
        self.store.upsert_capture(
            {"id": "k1", "content": "[USER] <chat-history-summary>", "kind": "fork_summary"}
        )
        got = self.store.conn.execute("SELECT kind FROM working_memory WHERE id = 'k1'").fetchone()
        self.assertEqual(got["kind"], "fork_summary")

    def test_fts_indexes_captures(self):
        self.store.upsert_capture(
            {"id": "f1", "content": "uniquezebra placeholder text", "source": "s"}
        )
        hits = self.store.conn.execute(
            "SELECT id FROM fts_working WHERE fts_working MATCH 'uniquezebra'"
        ).fetchall()
        self.assertEqual(len(hits), 1)

    def test_forget_capture_removes_fts(self):
        self.store.upsert_capture({"id": "del1", "content": "todelete marker text", "source": "s"})
        self.store.forget("working_memory", "del1")
        hits = self.store.conn.execute(
            "SELECT id FROM fts_working WHERE fts_working MATCH 'todelete'"
        ).fetchall()
        self.assertEqual(len(hits), 0)
        self.assertTrue(self.store.is_tombstoned("working_memory", "del1"))


class SessionRegistryTests(unittest.TestCase):
    """The session registry: provenance as structure, not string convention
    (PRD 20261104 data model)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = make_store(self.tmp)

    def tearDown(self):
        self.store.close()

    def test_get_or_create_is_idempotent_per_client_conversation(self):
        first = self.store.get_or_create_session("hal", "opencode", "ses_1", project="example")
        second = self.store.get_or_create_session("hal", "opencode", "ses_1", project="example")
        self.assertEqual(first, second)
        got = self.store.conn.execute("SELECT COUNT(*) AS n FROM session").fetchone()["n"]
        self.assertEqual(got, 1)

    def test_the_same_conversation_id_means_three_sessions_across_provenance(self):
        ids = {
            self.store.get_or_create_session("hal", "opencode", "ses_1"),
            self.store.get_or_create_session("dolores", "opencode", "ses_1"),
            self.store.get_or_create_session("hal", "cursor", "ses_1"),
        }
        self.assertEqual(len(ids), 3)

    def test_a_child_registers_its_parent_and_links_structurally(self):
        child = self.store.get_or_create_session(
            "hal", "opencode", "ses_child", parent_conversation_id="ses_top"
        )
        top = self.store.get_or_create_session("hal", "opencode", "ses_top")
        got = self.store.conn.execute(
            "SELECT role, parent_session_id FROM session WHERE id = ?", (child,)
        ).fetchone()
        self.assertEqual(got["role"], "subagent")
        self.assertEqual(got["parent_session_id"], top)
        parent = self.store.conn.execute("SELECT role FROM session WHERE id = ?", (top,)).fetchone()
        self.assertEqual(parent["role"], "main")

    def test_a_later_resolution_fills_a_project_the_first_turn_could_not_name(self):
        # Rootless Cursor windows resolve to nothing on the first turn; the
        # first turn that names a workspace backfills the registry row.
        session_id = self.store.get_or_create_session("hal", "cursor", "ses_9", project="")
        self.store.get_or_create_session("hal", "cursor", "ses_9", project="example")
        got = self.store.conn.execute(
            "SELECT project FROM session WHERE id = ?", (session_id,)
        ).fetchone()
        self.assertEqual(got["project"], "example")

    def test_a_resolved_project_survives_later_empty_resolutions(self):
        session_id = self.store.get_or_create_session("hal", "cursor", "ses_9", project="example")
        self.store.get_or_create_session("hal", "cursor", "ses_9", project="")
        got = self.store.conn.execute(
            "SELECT project FROM session WHERE id = ?", (session_id,)
        ).fetchone()
        self.assertEqual(got["project"], "example")

    def test_capture_turn_mirrors_under_its_session(self):
        row = {
            "id": "c1",
            "content": "[USER] hello",
            "source": "",
            "timestamp": "2026-11-04T10:00:00Z",
            "session_id": "ses_1",
            "kind": "speech",
            "repo": "example",
            "origin": "capture",
            "app": "opencode",
            "captured_by": "hal",
            "author_type": "human",
        }
        mirrored = self.store.record_capture_turn(row)
        got = self.store.conn.execute(
            "SELECT author_type, kind, content, ts FROM session_history WHERE id = 'c1'"
        ).fetchone()
        self.assertEqual(got["author_type"], "human")
        self.assertEqual(got["kind"], "speech")
        self.assertEqual(got["ts"], "2026-11-04T10:00:00Z")
        session = self.store.conn.execute(
            "SELECT machine, tool, project FROM session WHERE id = ?", (mirrored,)
        ).fetchone()
        self.assertEqual(session["machine"], "hal")
        self.assertEqual(session["tool"], "opencode")
        self.assertEqual(session["project"], "example")
        # A replay writes nothing.
        self.store.record_capture_turn(dict(row))
        got = self.store.conn.execute("SELECT COUNT(*) AS n FROM session_history").fetchone()["n"]
        self.assertEqual(got, 1)

    def test_deliberate_rows_never_reach_the_registry(self):
        self.store.record_capture_turn(
            {"id": "m1", "content": "fact", "origin": "deliberate", "app": "opencode"}
        )
        self.store.record_capture_turn({"id": "m2", "content": "no origin at all"})
        got = self.store.conn.execute("SELECT COUNT(*) AS n FROM session").fetchone()["n"]
        self.assertEqual(got, 0)
        got = self.store.conn.execute("SELECT COUNT(*) AS n FROM session_history").fetchone()["n"]
        self.assertEqual(got, 0)


class SessionFactsDeferTests(unittest.TestCase):
    """A repeat session-open (a client retrying) re-defers the same
    conversation: the new ranking wins, but a fetch or hold that already
    happened stays happened, so the retry cannot reopen the hold."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = make_store(self.tmp)
        self.store.session_facts_defer("conv-1", "cursor", "example", ["m1", "m2"])

    def tearDown(self):
        self.store.close()

    def test_a_redefer_after_the_fetch_keeps_it_fetched(self):
        self.store.session_facts_mark_fetched("conv-1")
        fetched_at = self.store.session_facts_for("conv-1")["fetched_at"]
        self.assertTrue(fetched_at)
        self.store.session_facts_defer("conv-1", "cursor", "example", ["m3"])
        row = self.store.session_facts_for("conv-1")
        self.assertEqual(row["fact_ids"], ["m3"])
        self.assertEqual(row["fetched_at"], fetched_at)
        self.assertFalse(self.store.session_facts_take_hold("conv-1"))

    def test_a_redefer_after_the_hold_keeps_it_held(self):
        self.assertTrue(self.store.session_facts_take_hold("conv-1"))
        held_at = self.store.session_facts_for("conv-1")["held_at"]
        self.assertTrue(held_at)
        self.store.session_facts_defer("conv-1", "cursor", "example", ["m3"])
        row = self.store.session_facts_for("conv-1")
        self.assertEqual(row["fact_ids"], ["m3"])
        self.assertEqual(row["held_at"], held_at)
        self.assertIsNone(row["fetched_at"])
        self.assertFalse(self.store.session_facts_take_hold("conv-1"))


class AgentMemoryTests(unittest.TestCase):
    """Deliberate content's home: rows keyed to the session registry,
    anchored honestly when the write carries no conversation (PRD
    20261104 data model; PRJ-177)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = make_store(self.tmp)

    def tearDown(self):
        self.store.close()

    def test_upsert_agent_links_the_resolved_session(self):
        session = self.store.get_or_create_session("hal", "opencode", "ses_1", project="example")
        self.store.upsert_agent(
            {
                "id": "m1",
                "session_id": session,
                "scope": "global",
                "content": "the fact",
                "source": "insight",
                "repo": "example",
                "app": "opencode",
            }
        )
        got = self.store.conn.execute(
            "SELECT scope, source, kind, session_id FROM agent_memory WHERE id = 'm1'"
        ).fetchone()
        self.assertEqual(got["scope"], "global")
        self.assertEqual(got["source"], "insight")
        self.assertEqual(got["kind"], "speech")
        self.assertEqual(got["session_id"], session)

    def test_same_content_is_a_replay_and_writes_nothing(self):
        # Every sync relays the origin's records back to it; the upsert
        # must swallow the replay, not stack a second row.
        session = self.store.get_or_create_session("hal", "opencode", "ses_1")
        self.store.upsert_agent({"id": "m1", "session_id": session, "content": "fact"})
        self.store.upsert_agent({"id": "m1", "session_id": session, "content": "fact"})
        got = self.store.conn.execute("SELECT COUNT(*) AS n FROM agent_memory").fetchone()["n"]
        self.assertEqual(got, 1)

    def test_record_payload_carries_the_triple_never_a_session_id(self):
        session = self.store.get_or_create_session("hal", "opencode", "ses_1", project="example")
        self.store.upsert_agent(
            {"id": "m1", "session_id": session, "content": "fact", "source": "fact"}
        )
        payload = self.store.agent_record_payload("m1")
        self.assertIsNone(payload.get("session_id"), "the registry id must not travel")
        self.assertEqual(
            payload["session"],
            {
                "machine": "hal",
                "tool": "opencode",
                "conversation_id": "ses_1",
                "project": "example",
            },
        )

    def test_wire_contract_names_the_agent_shape(self):
        base = {
            "record_id": "r1",
            "kind": "agent_memory",
            "machine_id": "hal",
            "occurred_at": "2026-11-04T00:00:00Z",
            "payload": {
                "id": "m1",
                "content": "fact",
                "session": {"machine": "hal", "tool": "opencode", "conversation_id": "ses_1"},
            },
        }
        self.assertIsNone(validate_record(base))
        self.assertEqual(
            validate_record({**base, "payload": {"id": "m1", "content": "fact"}}),
            "agent_memory payload must carry the session's machine",
        )
        self.assertEqual(
            validate_record(
                {
                    **base,
                    "payload": {
                        "id": "m1",
                        "content": "fact",
                        "session": {"tool": "opencode", "conversation_id": "ses_1"},
                    },
                }
            ),
            "agent_memory payload must carry the session's machine",
        )
        self.assertEqual(
            validate_record(
                {
                    **base,
                    "payload": {
                        "id": "m1",
                        "content": "fact",
                        "session": {"machine": "hal", "conversation_id": "ses_1"},
                    },
                }
            ),
            "agent_memory payload must carry the session's tool",
        )
        self.assertEqual(
            validate_record(
                {
                    **base,
                    "payload": {
                        "id": "m1",
                        "content": "fact",
                        "session": {"machine": "hal", "tool": "opencode"},
                    },
                }
            ),
            "agent_memory payload must carry the session's conversation_id",
        )
        self.assertEqual(
            validate_record(
                {
                    **base,
                    "payload": {
                        "id": "m1",
                        "content": "fact",
                        "session": {
                            "machine": "hal",
                            "tool": "opencode",
                            "conversation_id": "ses_1",
                        },
                        "scope": "fleet",
                    },
                }
            ),
            "agent_memory scope must be project|global",
        )

    def test_a_text_importance_never_rides_the_wire(self):
        # A string importance passes intake unvalidated and a scorer
        # multiplies it — TEXT lands in the row and recall raises on every
        # query that touches the row. The type-check at intake is what
        # keeps one record from breaking recall machine-wide.
        base = {
            "record_id": "r1",
            "machine_id": "hal",
            "occurred_at": "2026-11-04T00:00:00Z",
        }
        self.assertEqual(
            validate_record(
                {
                    **base,
                    "kind": "agent_memory",
                    "payload": {
                        "id": "m1",
                        "content": "fact",
                        "session": {
                            "machine": "hal",
                            "tool": "opencode",
                            "conversation_id": "s",
                        },
                        "importance": "high",
                    },
                }
            ),
            "agent_memory payload importance must be a number, not str",
        )
        self.assertEqual(
            validate_record(
                {
                    **base,
                    "kind": "memory",
                    "payload": {"id": "m2", "content": "fact", "importance": "high"},
                }
            ),
            "memory payload importance must be a number, not str",
        )
        self.assertIsNone(
            validate_record(
                {
                    **base,
                    "kind": "memory",
                    "payload": {"id": "m3", "content": "fact", "importance": 0},
                }
            ),
            "a real 0 importance is a number",
        )
        self.assertEqual(
            validate_record(
                {
                    **base,
                    "kind": "memory",
                    "payload": {"id": "m4", "content": "fact", "metadata": "stray"},
                }
            ),
            "memory payload metadata must be an object",
        )

    def test_the_watermark_counts_both_homes(self):
        session = self.store.get_or_create_session("hal", "opencode", "ses_1")
        self.store.upsert_agent(
            {
                "id": "m1",
                "session_id": session,
                "content": "agent-home write",
                "timestamp": "2026-11-01T00:00:00Z",
            }
        )
        self.store.conn.execute(
            """INSERT INTO working_memory (id, content, timestamp, origin)
               VALUES ('m2', 'straggler write', '2026-11-03T00:00:00Z', 'deliberate')"""
        )
        self.store.conn.commit()
        baseline = self.store.deliberate_writes()["watermark"]
        self.assertEqual(baseline, "2026-11-03T00:00:00Z")
        after = self.store.deliberate_writes("2026-11-02T00:00:00Z")
        self.assertEqual(after["count"], 1)

    def test_forget_homes_resolves_the_deliberate_twin(self):
        # Before every machine's migration drains, a deliberate id can sit
        # in both homes; the forget must reach both, whichever table the
        # caller named.
        session = self.store.get_or_create_session("hal", "opencode", "ses_1")
        self.store.upsert_agent({"id": "m1", "session_id": session, "content": "x"})
        self.store.conn.execute(
            "INSERT INTO working_memory (id, content, origin) VALUES ('m1', 'x', 'deliberate')"
        )
        self.store.conn.commit()
        self.assertEqual(
            self.store.forget_homes("agent_memory", "m1"),
            ("agent_memory", "working_memory"),
        )
        self.assertEqual(
            self.store.forget_homes("working_memory", "m1"),
            ("working_memory", "agent_memory"),
        )
        # A working-only id routes to itself.
        self.assertEqual(self.store.forget_homes("working_memory", "c999"), ("working_memory",))
        # Tables outside the deliberate pair pass through untouched.
        self.assertEqual(self.store.forget_homes("persona_rules", "3"), ("persona_rules",))

    def test_a_forgotten_agent_row_stays_dead_to_both_kinds(self):
        session = self.store.get_or_create_session("hal", "opencode", "ses_1")
        self.store.upsert_agent({"id": "m1", "session_id": session, "content": "fact"})
        self.store.forget("agent_memory", "m1")
        self.assertTrue(self.store.is_tombstoned("agent_memory", "m1"))
        self.assertIsNone(self.store.agent_row("m1"))

    def test_forget_refuses_the_entity_directory(self):
        """The wire accepts a forget naming entities, but an entry is
        forgotten by adding a row: deleting would hit the wrong table and
        the tombstone would refuse the records a restore needs."""
        self.store.upsert_situational(
            {
                "id": 5,
                "situation": "s",
                "statement": "st",
                "grader": "agent",
                "stance": "prescriptive",
            }
        )
        with self.assertRaises(ValueError):
            self.store.forget("entities", 5)
        self.assertFalse(self.store.is_tombstoned("entities", 5))
        self.assertIsNotNone(
            self.store.conn.execute("SELECT 1 FROM situational_rules WHERE id = 5").fetchone()
        )

    def test_a_forgotten_tool_rule_tombstones_and_deletes(self):
        # The tool-rule family joined FORGET_TABLES with cross-project
        # curation (PRJ-168): promote removes the source row, and the
        # tombstone is what keeps its original enrollment record — still
        # in every machine's record log — from resurrecting it on replay.
        rule = {
            "id": "tr_x",
            "tool_id": "tool_x",
            "note": "n",
            "scope": "project",
            "project": "example",
            "created_by": "hal",
            "created_at": "2026-11-08T00:00:00Z",
        }
        tool = {
            "id": "tool_x",
            "kind": "command",
            "key": ["git", "push"],
            "created_by": "hal",
            "created_at": "2026-11-08T00:00:00Z",
        }
        self.store.bind_tool(tool, rule)
        self.store.forget("tool_rules", "tr_x")
        self.assertTrue(self.store.is_tombstoned("tool_rules", "tr_x"))
        self.assertIsNone(self.store.tool_rule("tr_x"))
        # The wire accepts the family now: a forget record naming
        # tool_rules validates instead of being refused at send.
        self.assertIsNone(
            validate_record(
                {
                    "record_id": "r1",
                    "kind": "forget",
                    "machine_id": "hal",
                    "occurred_at": "2026-11-08T00:00:00Z",
                    "payload": {"table": "tool_rules", "id": "tr_x"},
                }
            )
        )

    def test_a_metadata_only_edit_converges_on_apply(self):
        # The edit ships as a full payload whose content matches the local
        # row; apply must land the metadata change, not swallow it as a
        # replay (the wire whole-payload upsert makes the replay safe).
        session = self.store.get_or_create_session("hal", "opencode", "ses_1")
        self.store.upsert_agent(
            {"id": "m9", "session_id": session, "content": "the fact", "importance": 0.4}
        )
        payload = self.store.agent_record_payload("m9")
        payload["importance"] = 0.9
        payload["source"] = "preference"
        applier = SyncClient(self.store, hub_url="", machine_id="hal")
        applier.apply(
            {
                "record_id": "r9",
                "kind": "agent_memory",
                "machine_id": "hal",
                "occurred_at": "2026-11-04T00:00:00Z",
                "payload": payload,
            }
        )
        got = self.store.agent_row("m9")
        self.assertEqual(got["importance"], 0.9)
        self.assertEqual(got["source"], "preference")

    def test_the_memory_kind_converges_metadata_edits_the_same_way(self):
        # The working tier's same-content upsert must not swallow a
        # full-payload edit any more than the agent home's does.
        self.store.upsert_capture(
            {
                "id": "m8",
                "content": "the fact",
                "origin": "deliberate",
                "importance": 0.4,
                "source": "fact",
                "app": "opencode",
                "captured_by": "hal",
            }
        )
        applier = SyncClient(self.store, hub_url="", machine_id="hal")
        applier.apply(
            {
                "record_id": "r8",
                "kind": "memory",
                "machine_id": "hal",
                "occurred_at": "2026-11-04T00:00:00Z",
                "payload": {
                    "id": "m8",
                    "content": "the fact",
                    "origin": "deliberate",
                    "importance": 0.8,
                    "source": "preference",
                    "app": "opencode",
                    "repo": "example",
                },
            }
        )
        got = self.store.conn.execute(
            "SELECT importance, source, origin FROM working_memory WHERE id = 'm8'"
        ).fetchone()
        self.assertEqual(got["importance"], 0.8)
        self.assertEqual(got["source"], "preference")
        self.assertEqual(got["origin"], "deliberate")

    def test_record_payload_carries_metadata(self):
        session = self.store.get_or_create_session("hal", "opencode", "ses_1")
        self.store.upsert_agent(
            {
                "id": "m7",
                "session_id": session,
                "content": "fact",
                "metadata": {"consolidator_version": "rev:test"},
            }
        )
        payload = self.store.agent_record_payload("m7")
        self.assertEqual(payload["metadata"], {"consolidator_version": "rev:test"})


class DeliberateMigrationTests(unittest.TestCase):
    """The one-pass move of the legacy deliberate pool (PRJ-177): copy into
    agent_memory under the per-app placeholder anchor, tombstone-delete the
    working copy, emit the records through the daemon's hook."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = make_store(self.tmp)

    def tearDown(self):
        self.store.close()

    def _seed_legacy(self, count=3, app="opencode"):
        for i in range(count):
            self.store.conn.execute(
                """INSERT INTO working_memory
                       (id, content, source, timestamp, session_id, importance,
                        veracity, kind, repo, origin, app)
                   VALUES (?, ?, 'insight', ?, 'default', 0.5, 'unknown',
                           'speech', 'example', 'deliberate', ?)""",
                (f"mL{app[0]}{i:x}", f"legacy {app} {i}", f"2026-01-0{i + 1}T00:00:00Z", app),
            )
        self.store.conn.commit()

    def test_migration_moves_anchors_and_drains(self):
        self._seed_legacy(3, app="opencode")
        self._seed_legacy(1, app="cursor")
        moved = self.store.migrate_deliberate_rows()
        self.assertEqual(moved, 4)
        self.assertEqual(
            self.store.conn.execute(
                "SELECT COUNT(*) AS n FROM working_memory WHERE origin = 'deliberate'"
            ).fetchone()["n"],
            0,
        )
        self.assertEqual(
            self.store.conn.execute("SELECT COUNT(*) AS n FROM agent_memory").fetchone()["n"], 4
        )
        # Every migrated row anchors to its app's placeholder session, and
        # the id, content, and timestamp ride through verbatim.
        got = self.store.conn.execute(
            """SELECT a.id, a.content, a.timestamp, s.machine, s.tool,
                      s.client_conversation_id AS conversation
               FROM agent_memory a JOIN session s ON a.session_id = s.id
               WHERE a.id = 'mLo0'"""
        ).fetchone()
        self.assertEqual(got["content"], "legacy opencode 0")
        self.assertEqual(got["timestamp"], "2026-01-01T00:00:00Z")
        self.assertEqual(got["machine"], "legacy")
        self.assertEqual(got["conversation"], "provenance-unrecorded")
        # The move is idempotent: a second pass finds nothing.
        self.assertEqual(self.store.migrate_deliberate_rows(), 0)

    def test_migration_emits_the_records_through_the_hook(self):
        self._seed_legacy(2)
        seen: list = []
        self.store.migrate_deliberate_rows(emit=lambda kind, payload: seen.append((kind, payload)))
        kinds = [kind for kind, _ in seen]
        self.assertEqual(kinds.count("agent_memory"), 2)
        self.assertEqual(kinds.count("forget"), 2)
        payload = next(p for kind, p in seen if kind == "agent_memory")
        self.assertEqual(payload["session"]["machine"], "legacy")
        self.assertEqual(payload["scope"], "project")
        forgets = [p for kind, p in seen if kind == "forget"]
        self.assertEqual({p["table"] for p in forgets}, {"working_memory"})

    def test_a_forgotten_migrated_row_never_returns(self):
        self._seed_legacy(1)
        self.store.migrate_deliberate_rows()
        row_id = "mLo0"
        self.store.forget("agent_memory", row_id)
        # The migration's own tombstone on the working copy blocks a
        # delayed replay of the original write record.
        self.assertTrue(self.store.is_tombstoned("working_memory", row_id))
        # And a later migration pass finds nothing to resurrect.
        self.assertEqual(self.store.migrate_deliberate_rows(), 0)

    def test_stragglers_from_late_replays_migrate_on_a_later_pass(self):
        # Post-migration, a delayed 'memory' record from an un-migrated
        # machine can land a deliberate row in working_memory; the reader
        # keeps it visible until the next boot's pass moves it.
        self.store.migrate_deliberate_rows()
        self._seed_legacy(1)
        self.assertEqual(self.store.migrate_deliberate_rows(), 1)
        self.assertEqual(
            self.store.conn.execute("SELECT COUNT(*) AS n FROM agent_memory").fetchone()["n"],
            1,
        )

    def test_migration_tombstone_blocks_the_old_record_kind(self):
        self._seed_legacy(1)
        self.store.migrate_deliberate_rows()
        self.assertTrue(self.store.is_tombstoned("working_memory", "mLo0"))
        # A replayed 'memory' record for the same id is refused at apply.
        applier = SyncClient(self.store, hub_url="", machine_id="hal")
        record = {
            "record_id": "r1",
            "kind": "memory",
            "machine_id": "hal",
            "occurred_at": "2026-11-04T00:00:00Z",
            "payload": {"id": "mLo0", "content": "legacy opencode 0"},
        }
        applier.apply(record)
        self.assertIsNone(
            self.store.conn.execute("SELECT 1 FROM working_memory WHERE id = 'mLo0'").fetchone(),
            "a tombstoned working copy must not resurrect from a replay",
        )

    def test_the_migration_preserves_created_at(self):
        self.store.conn.execute(
            """INSERT INTO working_memory
                   (id, content, source, timestamp, session_id, importance,
                    veracity, kind, repo, origin, app, created_at)
               VALUES ('mC1', 'old write', 'insight', '2025-03-01T00:00:00Z',
                       'default', 0.5, 'unknown', 'speech', 'example', 'deliberate',
                       'opencode', '2025-03-01 00:00:00')"""
        )
        self.store.conn.commit()
        self.store.migrate_deliberate_rows()
        got = self.store.agent_row("mC1")
        self.assertEqual(got["created_at"], "2025-03-01 00:00:00")
        # A fresh write without one stamps now, and later edits leave it.
        session = self.store.get_or_create_session("hal", "opencode", "ses_x")
        self.store.upsert_agent({"id": "mC2", "session_id": session, "content": "new"})
        fresh = self.store.agent_row("mC2")
        self.assertTrue(fresh["created_at"])

    def test_a_legacy_row_with_junk_metadata_does_not_brick_the_boot(self):
        self.store.conn.execute(
            """INSERT INTO working_memory
                   (id, content, source, timestamp, session_id, importance,
                    veracity, kind, repo, origin, app, metadata_json)
               VALUES ('mJ1', 'junk metadata row', 'insight', '2026-01-01T00:00:00Z',
                       'default', 0.5, 'unknown', 'speech', 'example', 'deliberate',
                       'opencode', 'not json')"""
        )
        self.store.conn.commit()
        moved = self.store.migrate_deliberate_rows()
        self.assertEqual(moved, 1)
        got = self.store.agent_row("mJ1")
        self.assertEqual(
            json.loads(got["metadata_json"]),
            {},
            "a malformed legacy metadata blob normalizes to empty, not an outage",
        )

    def test_an_old_shape_memory_record_applies_as_deliberate(self):
        applier = SyncClient(self.store, hub_url="", machine_id="hal")
        applier.apply(
            {
                "record_id": "r10",
                "kind": "memory",
                "machine_id": "hal",
                "occurred_at": "2026-01-01T00:00:00Z",
                "payload": {
                    "id": "mO1",
                    "content": "old shape write",
                    "source": "insight:example",
                },
            }
        )
        got = self.store.conn.execute(
            "SELECT origin, source, repo, app FROM working_memory WHERE id = 'mO1'"
        ).fetchone()
        self.assertEqual(got["origin"], "deliberate")
        self.assertEqual(got["source"], "insight")
        self.assertEqual(got["repo"], "example")
        self.assertEqual(got["app"], "opencode")

    def test_a_replayed_old_shape_record_does_not_flip_a_deliberate_row(self):
        session = self.store.get_or_create_session("hal", "opencode", "ses_1")
        self.store.upsert_agent(
            {"id": "mO2", "session_id": session, "content": "old shape write", "source": "insight"}
        )
        self.store.conn.execute(
            """INSERT INTO working_memory (id, content, origin, source, repo, app)
               VALUES ('mO2', 'old shape write', 'deliberate', 'insight', 'example', 'opencode')"""
        )
        self.store.conn.commit()
        applier = SyncClient(self.store, hub_url="", machine_id="hal")
        applier.apply(
            {
                "record_id": "r11",
                "kind": "memory",
                "machine_id": "hal",
                "occurred_at": "2026-01-01T00:00:00Z",
                "payload": {
                    "id": "mO2",
                    "content": "old shape write",
                    "source": "insight:example",
                },
            }
        )
        got = self.store.conn.execute(
            "SELECT origin, source FROM working_memory WHERE id = 'mO2'"
        ).fetchone()
        self.assertEqual(got["origin"], "deliberate")
        self.assertEqual(got["source"], "insight")

    def test_a_sync_twin_survivor_drains_with_its_forget_record(self):
        # An agent row landed by the apply path while the working copy came
        # from a delayed replay: the copy pass skips (the twin holds the
        # content), the drain pass empties the copy and emits exactly its
        # forget record.
        session = self.store.get_or_create_session("hal", "opencode", "ses_1")
        self.store.upsert_agent(
            {"id": "mT1", "session_id": session, "content": "twin", "source": "insight"}
        )
        self.store.conn.execute(
            """INSERT INTO working_memory (id, content, origin, source, repo, app)
               VALUES ('mT1', 'twin', 'deliberate', 'insight', 'example', 'opencode')"""
        )
        self.store.conn.commit()
        seen: list = []
        moved = self.store.migrate_deliberate_rows(
            emit=lambda kind, payload: seen.append((kind, payload))
        )
        self.assertEqual(moved, 0)
        self.assertEqual([kind for kind, _ in seen], ["forget"])
        self.assertIsNone(
            self.store.conn.execute("SELECT 1 FROM working_memory WHERE id = 'mT1'").fetchone()
        )

    def test_an_emit_refusal_marks_the_row_and_the_move_completes(self):
        # The refusal defers that row's RECORDS, not the rest of the move:
        # the local move stays durable, later rows keep shipping, and the
        # pending list carries the refused row to the next boot.
        self._seed_legacy(3)
        calls: list = []
        refused = {"mLo1": False}

        def emit(kind, payload):
            calls.append((kind, payload["id"]))
            if payload["id"] == "mLo1" and not refused["mLo1"]:
                refused["mLo1"] = True
                raise RecordContractError("contract refused")
            return True

        self.store.migrate_deliberate_rows(emit=emit)
        self.assertEqual(
            self.store.conn.execute("SELECT COUNT(*) AS n FROM agent_memory").fetchone()["n"],
            3,
        )
        self.assertEqual(self.store._meta_get("agent_migration_unshipped"), "mLo1")

    def test_a_refused_row_re_emits_on_the_next_pass(self):
        # A refusal mid-emit leaves the row moved locally with its wire
        # records lost — the pending list in store_meta is what re-emits
        # them on the next boot, instead of leaving the row permanently
        # unshipped behind its own tombstone.
        self._seed_legacy(3)
        calls: list = []
        refused = {"mLo1": False}

        def emit(kind, payload):
            calls.append((kind, payload["id"]))
            if payload["id"] == "mLo1" and not refused["mLo1"]:
                refused["mLo1"] = True
                raise RecordContractError("contract refused")
            return True

        self.store.migrate_deliberate_rows(emit=emit)
        shipped_first_pass = [c for c in calls if c[1] != "mLo1"]
        self.assertEqual(
            shipped_first_pass,
            [
                ("agent_memory", "mLo0"),
                ("forget", "mLo0"),
                ("agent_memory", "mLo2"),
                ("forget", "mLo2"),
            ],
        )
        # Next boot: the heal re-emits BOTH records for the pending row;
        # the healed id leaves the pending list.
        calls.clear()
        self.store.migrate_deliberate_rows(emit=emit)
        self.assertEqual(calls, [("agent_memory", "mLo1"), ("forget", "mLo1")])
        self.assertEqual(
            self.store._meta_get("agent_migration_unshipped"),
            "",
            "the healed id leaves the pending list",
        )
        self.assertEqual(
            self.store.conn.execute("SELECT COUNT(*) AS n FROM agent_memory").fetchone()["n"],
            3,
        )

    def test_a_swallowed_enqueue_failure_is_pending_too(self):
        self._seed_legacy(1)

        def dropping_emit(kind, payload):
            return False  # the enqueue failed and swallowed the record

        self.store.migrate_deliberate_rows(emit=dropping_emit)
        self.assertEqual(self.store._meta_get("agent_migration_unshipped"), "mLo0")

    def test_the_pending_list_survives_close_and_reopen(self):
        # The heal record must be durable: a boot that marks unshipped rows
        # and dies before any later store write would lose the record when
        # the pending write ran outside a transaction — close() commits
        # nothing, and the moved rows are out of the scan, so the reopen
        # would heal nothing.
        self._seed_legacy(1)

        def refuse(kind, payload):
            raise RecordContractError("refused")

        self.store.migrate_deliberate_rows(emit=refuse)
        self.store.close()
        reopened = Store(Path(self.tmp) / "test.db")
        try:
            self.assertEqual(
                reopened._meta_get("agent_migration_unshipped"),
                "mLo0",
                "the heal record survived close+reopen",
            )
        finally:
            reopened.close()

    def test_a_pending_row_whose_twin_vanished_clears(self):
        self.store.get_or_create_session("hal", "opencode", "ses_1")
        self.store.upsert_agent({"id": "mP1", "session_id": "ses", "content": "pending"})
        self.store._meta_set("agent_migration_unshipped", "mP1,mGone")
        seen: list = []
        self.store.migrate_deliberate_rows(emit=lambda k, p: seen.append((k, p)))
        # mP1 heals (both records re-emit); mGone's agent row no longer
        # exists — its pending entry clears without emitting.
        shipped_ids = {payload["id"] for _, payload in seen}
        self.assertIn("mP1", shipped_ids)
        self.assertNotIn("mGone", shipped_ids)

    def test_an_edited_straggler_drains_into_its_twin(self):
        # The divergence case: a straggler was edited in place (no twin
        # existed at edit time), and a twin with the OLDER content from
        # another machine's migration landed afterwards. The working copy
        # carries the newest intent; the drain folds it into the twin and
        # re-ships the agent record, so the edit converges instead of
        # dying behind the drain's forget.
        session = self.store.get_or_create_session("hal", "opencode", "ses_1")
        self.store.upsert_agent(
            {
                "id": "mD1",
                "session_id": session,
                "content": "original content",
                "source": "insight",
                "repo": "example",
                "app": "opencode",
            }
        )
        self.store.conn.execute(
            """INSERT INTO working_memory
                   (id, content, origin, source, timestamp, kind, repo, app)
               VALUES ('mD1', 'edited content', 'deliberate', 'insight',
                       '2026-01-02T00:00:00Z', 'speech', 'example', 'opencode')"""
        )
        self.store.conn.commit()
        seen: list = []
        moved = self.store.migrate_deliberate_rows(
            emit=lambda kind, payload: seen.append((kind, payload))
        )
        self.assertEqual(moved, 0)  # twin exists; the drain handled the copy
        self.assertEqual(self.store.agent_row("mD1")["content"], "edited content")
        self.assertIsNone(
            self.store.conn.execute("SELECT 1 FROM working_memory WHERE id = 'mD1'").fetchone()
        )
        shipped = [kind for kind, _ in seen]
        self.assertIn("agent_memory", shipped)
        self.assertIn("forget", shipped)

    def test_a_null_importance_migrates_without_crashing_the_scorers(self):
        # The legacy working-memory schema permitted NULL kind/importance;
        # a verbatim carry would refuse the row (kind has NOT NULL) or
        # hand recall's scorer a None to multiply. Both coerce here.
        self.store.conn.execute(
            """INSERT INTO working_memory
                   (id, content, source, timestamp, session_id, importance,
                    veracity, kind, repo, origin, app)
               VALUES ('mN1', 'nullish legacy row', 'insight', '2026-01-01T00:00:00Z',
                       'default', NULL, NULL, NULL, 'example', 'deliberate', 'opencode')"""
        )
        self.store.conn.commit()
        moved = self.store.migrate_deliberate_rows()
        self.assertEqual(moved, 1)
        got = self.store.agent_row("mN1")
        self.assertEqual(got["kind"], "speech")
        self.assertEqual(got["importance"], 0.5)
        self.assertEqual(got["veracity"], "unknown")
        # A real 0 importance survives the coercion.
        session = self.store.get_or_create_session("hal", "opencode", "ses_1")
        self.store.upsert_agent(
            {"id": "mN2", "session_id": session, "content": "zero", "importance": 0}
        )
        self.assertEqual(self.store.agent_row("mN2")["importance"], 0)

    def test_an_emit_free_pass_preserves_the_pending_list(self):
        self.store._meta_set("agent_migration_unshipped", "mHold1")
        self.store.get_or_create_session("hal", "opencode", "ses_1")
        self.store.upsert_agent({"id": "mHold1", "session_id": "ses", "content": "held"})
        self.store.migrate_deliberate_rows()  # no emit: nobody to ship to
        self.assertEqual(
            self.store._meta_get("agent_migration_unshipped"),
            "mHold1",
            "a pass without an emit hook must not wipe recorded unshipped rows",
        )


class EpisodicTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = make_store(self.tmp)

    def tearDown(self):
        self.store.close()

    def test_episodic_upsert_idempotent_and_indexed(self):
        row = {"id": "ep1", "content": "summary about gateway units", "source": "hub"}
        self.store.upsert_episodic(row)
        self.store.upsert_episodic(dict(row))
        count = self.store.conn.execute(
            "SELECT COUNT(*) AS n FROM episodic_memory WHERE id = 'ep1'"
        ).fetchone()["n"]
        self.assertEqual(count, 1)
        hits = self.store.conn.execute(
            "SELECT rowid FROM fts_episodes WHERE fts_episodes MATCH 'gateway'"
        ).fetchall()
        self.assertEqual(len(hits), 1)

    def test_forget_episodic_cleans_vec_and_fts(self):
        self.store.upsert_episodic({"id": "ep2", "content": "victim row", "source": "hub"})
        self.store.forget("episodic_memory", "ep2")
        count = self.store.conn.execute(
            "SELECT COUNT(*) AS n FROM episodic_memory WHERE id = 'ep2'"
        ).fetchone()["n"]
        self.assertEqual(count, 0)


class VecUnavailableTests(unittest.TestCase):
    """A store that cannot load sqlite-vec has to say so.

    Writes succeed either way and land without a vector, so the only symptom
    is recall missing those rows much later. A cutover import run under a
    python without the extension put 25 unvectored rows in the live store and
    nothing reported it.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.lines = []
        spans.sink(self.lines.append)
        self.addCleanup(spans.pop_sink, self.lines.append)

    def test_a_failed_extension_load_is_logged(self):
        with mock.patch.dict(os.environ, {"MEMORY_DISABLE_EMBEDDINGS": "0"}):
            with mock.patch.dict(sys.modules, {"sqlite_vec": None}):
                store = Store(Path(self.tmp) / "novec.db")
        self.addCleanup(store.close)
        self.assertFalse(store.vec_available)
        self.assertTrue(
            any(
                "op=store.vec_unavailable" in line and "level=error" in line for line in self.lines
            ),
            self.lines,
        )

    def test_the_explicit_opt_out_stays_quiet(self):
        with mock.patch.dict(os.environ, {"MEMORY_DISABLE_EMBEDDINGS": "1"}):
            store = Store(Path(self.tmp) / "optout.db")
        self.addCleanup(store.close)
        self.assertFalse(store.vec_available)
        self.assertFalse([line for line in self.lines if "store.vec_unavailable" in line])


class PersonaBudgetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = make_store(self.tmp)

    def tearDown(self):
        self.store.close()

    def _fill(self, n_chars):
        self.store.upsert_persona({"id": 1, "statement": "x" * n_chars, "status": "active"})

    def test_budget_refuses_over_limit(self):
        self._fill(14000)
        result = self.store.upsert_persona({"id": 2, "statement": "y" * 2000, "status": "active"})
        self.assertEqual(result["status"], "refused")
        self.assertEqual(result["reason"], "budget")
        state = result["budget_state"]
        self.assertEqual(state["total"], 14000)

    def test_budget_allows_shrink_via_reword(self):
        self._fill(14000)
        # Reword rule 1 down to make room, then add rule 2.
        ok = self.store.upsert_persona({"id": 1, "statement": "x" * 6000, "status": "active"})
        self.assertEqual(ok["status"], "ok")
        ok2 = self.store.upsert_persona({"id": 2, "statement": "y" * 6000, "status": "active"})
        self.assertEqual(ok2["status"], "ok")

    def test_retiring_frees_the_space(self):
        self._fill(10000)
        self.store.upsert_persona({"id": 1, "statement": "x" * 10000, "status": "retired"})
        self.assertEqual(self.store.persona_budget_state()["total"], 0)
        ok = self.store.upsert_persona({"id": 2, "statement": "z" * 12000, "status": "active"})
        self.assertEqual(ok["status"], "ok")

    def test_reactivating_a_retired_rule_is_charged_in_full(self):
        self._fill(10000)
        self.store.upsert_persona({"id": 2, "statement": "z" * 4000, "status": "retired"})
        over = self.store.upsert_persona({"id": 2, "statement": "z" * 6000, "status": "active"})
        self.assertEqual(over["status"], "refused")

    def test_legacy_proposed_status_lands_active(self):
        self.store.upsert_persona({"id": 1, "statement": "x" * 10, "status": "proposed"})
        row = self.store.conn.execute("SELECT status FROM persona_rules WHERE id = 1").fetchone()
        self.assertEqual(row["status"], "active")

    def test_unknown_status_rejected(self):
        with self.assertRaises(ValueError):
            self.store.upsert_persona({"id": 1, "statement": "x", "status": "pending"})

    def test_update_same_rule_charges_only_the_delta(self):
        self._fill(14000)
        # Rewording rule 1 to a longer statement within the same charge slot:
        # total - old + new must fit.
        result = self.store.upsert_persona({"id": 1, "statement": "x" * 14999, "status": "active"})
        self.assertEqual(result["status"], "ok")
        over = self.store.upsert_persona({"id": 1, "statement": "x" * 15001, "status": "active"})
        self.assertEqual(over["status"], "refused")


class FeedbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = make_store(self.tmp)

    def tearDown(self):
        self.store.close()

    def test_feedback_accumulates_and_confidence_derives(self):
        self.store.upsert_situational(
            {
                "id": 5,
                "situation": "committing",
                "statement": "run checks first",
                "grader": "agent",
                "stance": "prescriptive",
            }
        )
        self.store.apply_feedback(5, "situational", "confirm", 1.0)
        self.store.apply_feedback(5, "situational", "confirm", 1.0)
        self.store.apply_feedback(5, "situational", "disconfirm", 1.0)
        conf = self.store.confidence(5)
        # (2 + 5*0.5) / (2 + 1 + 5) = 4.5/8
        self.assertAlmostEqual(conf, 4.5 / 8.0)
        row = self.store.conn.execute(
            "SELECT confirm_count, disconfirm_count FROM situational_rules WHERE id = 5"
        ).fetchone()
        self.assertEqual((row["confirm_count"], row["disconfirm_count"]), (2.0, 1.0))

    def test_soft_signal_partial_delta(self):
        self.store.upsert_situational(
            {
                "id": 6,
                "situation": "s",
                "statement": "t",
                "grader": "agent",
                "stance": "prescriptive",
            }
        )
        self.store.apply_feedback(6, "situational", "disconfirm", 0.25)
        conf = self.store.confidence(6)
        # (0 + 2.5) / (0 + 0.25 + 5)
        self.assertAlmostEqual(conf, 2.5 / 5.25)

    def test_persona_apply_feedback(self):
        self.store.upsert_persona({"id": 9, "statement": "answer the question asked"})
        self.store.apply_feedback(9, "persona", "apply", 1.0)
        row = self.store.conn.execute(
            "SELECT apply_count, last_applied_at FROM persona_rules WHERE id = 9"
        ).fetchone()
        self.assertEqual(row["apply_count"], 1)
        self.assertIsNotNone(row["last_applied_at"])

    def test_upsert_situational_does_not_substitute_grader_or_stance(self):
        """The store re-supplied both defaults, which left its own
        validation unreachable for a row that omitted them."""
        with self.assertRaisesRegex(ValueError, "invalid grader None"):
            self.store.upsert_situational(
                {"id": 12, "situation": "s", "statement": "t", "stance": "prescriptive"}
            )
        with self.assertRaisesRegex(ValueError, "invalid stance None"):
            self.store.upsert_situational(
                {"id": 13, "situation": "s", "statement": "t", "grader": "agent"}
            )
        count = self.store.conn.execute("SELECT COUNT(*) AS n FROM situational_rules").fetchone()
        self.assertEqual(count["n"], 0)

    def test_apply_feedback_does_not_substitute_a_polarity(self):
        """apply_feedback used to pass `polarity or "disconfirm"`, which
        put the default back for any caller that had correctly left it
        unset."""
        self.store.upsert_situational(
            {
                "id": 11,
                "situation": "s",
                "statement": "t",
                "grader": "agent",
                "stance": "prescriptive",
            }
        )
        with self.assertRaises(ValueError):
            self.store.apply_feedback(11, "situational", "soft", 0.25)
        row = self.store.conn.execute(
            "SELECT confirm_count, disconfirm_count FROM situational_rules WHERE id = 11"
        ).fetchone()
        self.assertEqual((row["confirm_count"], row["disconfirm_count"]), (0.0, 0.0))


class NormalizeSignalTests(unittest.TestCase):
    def test_canonical_signals_pass_through_without_a_polarity(self):
        # Why dropping the default is safe everywhere: only a literal
        # "soft" ever consults polarity, and the wire carries canonical
        # values, so no apply path needs one.
        for signal in FEEDBACK_SIGNALS:
            self.assertEqual(normalize_signal(signal), signal)

    def test_agent_shorthand_maps_without_a_polarity(self):
        self.assertEqual(normalize_signal("confirm"), "confirm")
        self.assertEqual(normalize_signal("disconfirm"), "refute")

    def test_soft_raises_rather_than_picking_a_direction(self):
        with self.assertRaisesRegex(ValueError, "needs polarity"):
            normalize_signal("soft")

    def test_soft_maps_both_directions(self):
        self.assertEqual(normalize_signal("soft", "confirm"), "soft_confirm")
        self.assertEqual(normalize_signal("soft", "disconfirm"), "soft_refute")


class RecordContractTests(unittest.TestCase):
    """`validate_record` is the one definition of the wire contract. It
    lived in hub_server, which put the only check on a machine with no
    agent and no user; origins now apply the same function before a record
    leaves, so a violation lands on the caller that caused it."""

    def _record(self, **overrides) -> dict:
        record = {
            "record_id": "host-a-1",
            "kind": "memory",
            "machine_id": "host-a",
            "occurred_at": "2026-10-07T12:00:00Z",
            "payload": {"id": "m1", "content": "a durable fact"},
        }
        record.update(overrides)
        return record

    def test_a_well_formed_record_has_no_reason(self):
        self.assertIsNone(validate_record(self._record()))

    def test_the_hub_validates_through_the_same_function(self):
        from memory_store.server import hub_server

        self.assertIs(hub_server.validate_record, validate_record)

    def test_session_records_need_a_conversation_id(self):
        self.assertIsNone(
            validate_record(
                self._record(
                    kind="session",
                    payload={"conversation_id": "ses_1", "tool": "opencode"},
                )
            )
        )
        reason = validate_record(self._record(kind="session", payload={"tool": "opencode"}))
        self.assertIn("conversation_id", reason or "")

    def test_feedback_signal_must_be_canonical(self):
        for signal in ("soft", "disconfirm", "bogus"):
            reason = validate_record(
                self._record(
                    kind="feedback",
                    payload={"rule_id": 1, "rule_kind": "situational", "signal": signal},
                )
            )
            self.assertIn("signal must be one of", reason or "")

    def test_canonical_feedback_passes(self):
        for signal in FEEDBACK_SIGNALS:
            self.assertIsNone(
                validate_record(
                    self._record(
                        kind="feedback",
                        payload={"rule_id": 1, "rule_kind": "situational", "signal": signal},
                    )
                )
            )

    def test_reasons_name_the_violation(self):
        cases = {
            "unsupported record kind": self._record(kind="nonsense"),
            "machine_id must contain only": self._record(machine_id="Host A"),
            "occurred_at must be ISO 8601": self._record(occurred_at="last tuesday"),
            "payload must be a JSON object": self._record(payload="a string"),
            "memory payload must carry content": self._record(payload={"id": "m1"}),
        }
        for expected, record in cases.items():
            self.assertIn(expected, validate_record(record) or "")

    def test_extra_fields_are_a_violation(self):
        record = self._record()
        record["extra"] = "unexpected"
        self.assertIn("fields must be exactly", validate_record(record) or "")

    def test_the_relay_passes_a_kind_it_does_not_know(self):
        """A machine upgraded ahead of the hub writes kinds the hub has
        never heard of; marking them invalid strands them for good."""
        record = self._record(kind="sighting", payload={"anything": "goes"})
        self.assertIsNone(validate_record(record, allow_unknown_kinds=True))

    def test_the_relay_still_checks_an_unknown_kinds_envelope(self):
        cases = {
            "machine_id must contain only": self._record(kind="sighting", machine_id="Host A"),
            "occurred_at must be ISO 8601": self._record(kind="sighting", occurred_at="nope"),
            "payload must be a JSON object": self._record(kind="sighting", payload=[]),
            "kind must be a non-empty string": self._record(kind=""),
        }
        for expected, record in cases.items():
            self.assertIn(expected, validate_record(record, allow_unknown_kinds=True) or "")

    def test_entity_inserts_need_their_row_fields(self):
        cases = {
            "entity payload must carry an op": {"id": "x1"},
            "entity payload must carry the row id": {"op": "create", "kind": "human"},
            "entity create payload must carry kind": {"op": "create", "id": "e1"},
            "entity rename payload must carry display_name": {
                "op": "rename",
                "id": "n1",
                "entity_id": "e1",
            },
            "entity relate payload must carry object_id": {
                "op": "relate",
                "id": "r1",
                "subject_id": "a1",
                "verb": "acts_for",
            },
            "entity alias_add payload must carry value": {
                "op": "alias_add",
                "id": "a1",
                "entity_id": "e1",
                "type": "github",
            },
            "entity observe payload must carry content": {
                "op": "observe",
                "id": "o1",
                "entity_id": "e1",
            },
            "entity create payload must carry created_at as YYYY-MM-DDTHH:MM:SSZ": {
                "op": "create",
                "id": "e1",
                "kind": "human",
                "created_at": "whenever",
            },
            "entity alias_add instance must be a string": {
                "op": "alias_add",
                "id": "a1",
                "entity_id": "e1",
                "type": "slack",
                "value": "U04ABC",
                "instance": 7,
            },
        }
        for expected, payload in cases.items():
            reason = validate_record(self._record(kind="entity", payload=payload))
            self.assertIn(expected, reason or "", payload)

    def test_entity_removals_need_a_deleted_at(self):
        for op in ("unrelate", "alias_remove", "unobserve", "restore"):
            reason = validate_record(self._record(kind="entity", payload={"op": op, "id": "x1"}))
            self.assertIn(f"entity {op} payload must carry deleted_at", reason or "")

    def _entity_create(self, **overrides) -> dict:
        payload = {
            "op": "create",
            "id": "e1",
            "kind": "human",
            "session": {"machine": "host-a", "tool": "cursor", "conversation_id": "c1"},
            "created_at": "2026-10-23T12:00:00Z",
        }
        payload.update(overrides)
        return self._record(kind="entity", payload=payload)

    def test_a_well_formed_entity_record_passes(self):
        self.assertIsNone(validate_record(self._entity_create()))

    def test_entity_stamps_have_one_shape(self):
        """Apply compares these strings to order rows; an offset form sorts
        out of chronological order against the Z form."""
        for stamp in (
            "2026-10-23T14:00:00-04:00",
            "2026-10-23 12:00:00",
            "2026-13-23T12:00:00Z",
            "2026-01- 9T00:00:00Z",
            "202\u0666-01-01T00:00:00Z",
            "2026-01-01T0\u0660:00:00Z",
        ):
            with self.subTest(stamp=stamp):
                reason = validate_record(self._entity_create(created_at=stamp))
                self.assertIn("created_at as YYYY-MM-DDTHH:MM:SSZ", reason or "")
        removal = {"op": "alias_remove", "id": "a1", "deleted_at": "2026-10-23T14:00:00+00:00"}
        reason = validate_record(self._record(kind="entity", payload=removal))
        self.assertIn("deleted_at as YYYY-MM-DDTHH:MM:SSZ", reason or "")

    def test_an_entity_insert_needs_its_session(self):
        missing = validate_record(self._entity_create(session=None))
        self.assertIn("entity create payload must carry the session's machine", missing or "")
        partial = validate_record(self._entity_create(session={"machine": "host-a"}))
        self.assertIn("entity create payload must carry the session's tool", partial or "")

    def test_forgetting_an_entry_needs_a_session_and_a_memory_forget_does_not(self):
        entry = self._record(kind="forget", payload={"table": "entities", "id": "e1"})
        self.assertIn(
            "forget entities payload must carry the session's machine",
            validate_record(entry) or "",
        )
        entry["payload"]["session"] = {
            "machine": "host-a",
            "tool": "cursor",
            "conversation_id": "c1",
        }
        self.assertIsNone(validate_record(entry))
        memory = self._record(kind="forget", payload={"table": "working_memory", "id": "m1"})
        self.assertIsNone(validate_record(memory))

    def test_the_wire_does_not_police_the_directorys_vocabulary(self):
        """A verb or kind is a value, not a schema change: checking it here
        would make adding one a hub-first deploy."""
        session = {"machine": "host-a", "tool": "cursor", "conversation_id": "c1"}
        for payload in (
            {
                "op": "create",
                "id": "e1",
                "kind": "spaceship",
                "session": session,
                "created_at": "2026-10-23T12:00:00Z",
            },
            {
                "op": "relate",
                "id": "r1",
                "subject_id": "a1",
                "verb": "reports_to",
                "object_id": "e1",
                "session": session,
                "created_at": "2026-10-23T12:00:00Z",
            },
        ):
            self.assertIsNone(validate_record(self._record(kind="entity", payload=payload)))

    def test_an_unknown_entity_op_is_refused_at_the_origin_and_relayed(self):
        record = self._record(kind="entity", payload={"op": "teleport", "id": "x1"})
        self.assertIn("unsupported entity op", validate_record(record) or "")
        self.assertIsNone(validate_record(record, allow_unknown_kinds=True))

    def test_the_relay_still_checks_a_known_kinds_payload(self):
        record = self._record(payload={"id": "m1"})
        self.assertIn(
            "memory payload must carry content",
            validate_record(record, allow_unknown_kinds=True) or "",
        )


class RecordLogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = make_store(self.tmp)

    def tearDown(self):
        self.store.close()

    def test_append_and_pull_cursor_semantics(self):
        records = [{"record_id": f"r{i}", "kind": "capture", "payload": {"n": i}} for i in range(5)]
        self.store.append_records(records, "host-a")
        first = self.store.pull_records(0, limit=3)
        self.assertEqual(len(first["records"]), 3)
        self.assertTrue(first["has_more"])
        second = self.store.pull_records(first["next_cursor"], limit=3)
        self.assertEqual(len(second["records"]), 2)
        self.assertFalse(second["has_more"])
        self.assertEqual(second["next_cursor"], 5)
        # re-pull from same cursor is stable
        again = self.store.pull_records(first["next_cursor"], limit=3)
        self.assertEqual(again["records"][0]["record_id"], "r3")

    def test_record_ids_deduped(self):
        self.store.append_records([{"record_id": "dup", "kind": "memory", "payload": {}}], "a")
        self.store.append_records([{"record_id": "dup", "kind": "memory", "payload": {}}], "a")
        count = self.store.conn.execute("SELECT COUNT(*) AS n FROM record_log").fetchone()["n"]
        self.assertEqual(count, 1)


class MigrationTests(unittest.TestCase):
    """Old-shape databases reopen migrated: the guard must parse each
    statement's own table and column. The bug this guards against parsed
    every migration with a DROP COLUMN splitter, so ADD COLUMN grounds
    silently never fired on any pre-existing store."""

    def _make_old_shape_db(self, path: Path) -> None:

        conn = sqlite3.connect(path)
        conn.executescript(
            """
            CREATE TABLE persona_rules (
                id INTEGER PRIMARY KEY,
                statement TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'proposed',
                provenance TEXT,
                origin_machine TEXT,
                topic TEXT,
                apply_count REAL NOT NULL DEFAULT 0,
                last_applied_at TEXT,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
                updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );
            CREATE TABLE feedback_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                rule_id INTEGER NOT NULL,
                rule_kind TEXT NOT NULL,
                signal TEXT NOT NULL,
                delta REAL NOT NULL DEFAULT 1,
                origin_machine TEXT,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
            );
            """
        )
        conn.commit()
        conn.close()

    def test_old_shape_db_migrates_on_open(self):
        tmp = Path(tempfile.mkdtemp())
        db_path = tmp / "old.db"
        self._make_old_shape_db(db_path)
        store = Store(db_path)
        try:
            persona_columns = {
                row["name"] for row in store.conn.execute("PRAGMA table_info(persona_rules)")
            }
            self.assertIn("topic", persona_columns)
            feedback_columns = {
                row["name"] for row in store.conn.execute("PRAGMA table_info(feedback_log)")
            }
            self.assertIn("grounds", feedback_columns)
            # And the migrated column is usable end to end:
            store.apply_feedback(1, "situational", "confirm", 1.0, "t", grounds="g")
            row = store.conn.execute(
                "SELECT grounds FROM feedback_log WHERE rule_id = 1"
            ).fetchone()
            self.assertEqual(row["grounds"], "g")
        finally:
            store.close()

    def test_proposed_floor_rules_activate_on_open(self):
        tmp = Path(tempfile.mkdtemp())
        db_path = tmp / "old.db"
        self._make_old_shape_db(db_path)

        conn = sqlite3.connect(db_path)
        conn.execute(
            "INSERT INTO persona_rules (id, statement, status) VALUES (1, 'unanswered', 'proposed')"
        )
        conn.execute(
            "INSERT INTO persona_rules (id, statement, status) VALUES (2, 'gone', 'retired')"
        )
        conn.commit()
        conn.close()
        store = Store(db_path)
        try:
            statuses = {
                row["id"]: row["status"]
                for row in store.conn.execute("SELECT id, status FROM persona_rules")
            }
            self.assertEqual(statuses, {1: "active", 2: "retired"})
            self.assertEqual(store.persona_budget_state()["total"], len("unanswered"))
        finally:
            store.close()

    def test_fresh_db_idempotent_reopen(self):
        # Opening a migrated store again must not raise (the guard's
        # already-applied paths) — the daemon reopens its DB every start.
        tmp = Path(tempfile.mkdtemp())
        store = Store(tmp / "fresh.db")
        store.close()
        reopened = Store(tmp / "fresh.db")
        try:
            feedback_columns = {
                row["name"] for row in reopened.conn.execute("PRAGMA table_info(feedback_log)")
            }
            self.assertIn("grounds", feedback_columns)
        finally:
            reopened.close()

    def _make_compound_source_db(self, path: Path) -> None:
        """Pre-columns store: compound source strings, junk session ids,
        no repo/origin/app columns."""

        conn = sqlite3.connect(path)
        conn.executescript(
            """
            CREATE TABLE working_memory (
                id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT,
                timestamp TEXT, session_id TEXT DEFAULT 'default',
                importance REAL DEFAULT 0.5, metadata_json TEXT,
                veracity TEXT DEFAULT 'unknown', author_id TEXT,
                author_type TEXT, kind TEXT DEFAULT 'speech',
                consolidated_at TEXT, consolidation_claimed_at TEXT
            );
            CREATE TABLE episodic_memory (
                rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT UNIQUE NOT NULL, content TEXT NOT NULL, source TEXT,
                timestamp TEXT, session_id TEXT DEFAULT 'default',
                importance REAL DEFAULT 0.5, metadata_json TEXT,
                summary_of TEXT DEFAULT '', veracity TEXT DEFAULT 'unknown'
            );
            INSERT INTO working_memory (id, content, source, session_id, kind)
                VALUES ('c1', 'captured turn', 'cursor:example:ses_f496', 'default', 'speech');
            INSERT INTO working_memory (id, content, source, session_id, kind)
                VALUES ('d1', 'deliberate fact', 'fact:example', 'default', 'speech');
            INSERT INTO working_memory (id, content, source, session_id, kind)
                VALUES ('d2', 'bare deliberate', 'insight', 'default', 'speech');
            INSERT INTO episodic_memory (id, content, source, metadata_json, summary_of)
                VALUES ('e1', 'summary', 'sleep_consolidation',
                        '{"source_label": "cursor:example:ses_f496", "rows": 2}', '');
            """
        )
        conn.commit()
        conn.close()

    def test_compound_sources_migrate_to_columns(self):
        tmp = Path(tempfile.mkdtemp())
        db_path = tmp / "legacy.db"
        self._make_compound_source_db(db_path)
        store = Store(db_path)
        try:
            rows = {
                row["id"]: row
                for row in store.conn.execute(
                    "SELECT id, repo, origin, app, session_id, source FROM working_memory"
                )
            }
            # Captured row: columns populated, session id real, source label
            # slot empty (kind already says speech), app stamped.
            self.assertEqual(rows["c1"]["repo"], "example")
            self.assertEqual(rows["c1"]["origin"], "capture")
            self.assertEqual(rows["c1"]["app"], "opencode")
            self.assertEqual(rows["c1"]["session_id"], "ses_f496")
            # Deliberate compound: repo from tail, label intact.
            self.assertEqual(rows["d1"]["repo"], "example")
            self.assertEqual(rows["d1"]["origin"], "deliberate")
            self.assertEqual(rows["d1"]["source"], "fact")
            d2 = store.conn.execute(
                "SELECT source, repo, origin FROM working_memory WHERE id = 'd2'"
            ).fetchone()
            self.assertEqual(d2["source"], "insight")
            self.assertEqual(d2["repo"], "")
            self.assertEqual(d2["origin"], "deliberate")
            # cursor ceases to exist as data:
            n = store.conn.execute(
                "SELECT COUNT(*) AS n FROM working_memory WHERE source LIKE 'cursor:%'"
            ).fetchone()["n"]
            self.assertEqual(n, 0)
            # Episodic: consolidated provenance + structured summary_of.
            ep = store.conn.execute(
                "SELECT repo, origin, app, summary_of FROM episodic_memory WHERE id = 'e1'"
            ).fetchone()
            self.assertEqual(ep["repo"], "example")
            self.assertEqual(ep["origin"], "consolidated")
            self.assertEqual(ep["app"], "memory-store")
            self.assertEqual(ep["summary_of"], "ses_f496")
        finally:
            store.close()

    def test_source_migration_leaves_later_writes_alone(self):
        """A globally-scoped row has an empty repo forever, so the pass
        cannot use that as its own has-it-run signal. Reopening must not
        re-stamp app and origin over what a later write set."""
        tmp = Path(tempfile.mkdtemp())
        db_path = tmp / "legacy.db"
        self._make_compound_source_db(db_path)
        store = Store(db_path)
        store.close()
        reopened = Store(db_path)
        try:
            reopened.upsert_capture(
                {
                    "id": "imported",
                    "content": "brought across from another store",
                    "source": "rule",
                    "origin": "deliberate",
                    "app": "mnemosyne",
                    "repo": "",
                }
            )
        finally:
            reopened.close()
        third = Store(db_path)
        try:
            row = third.conn.execute(
                "SELECT app, origin FROM working_memory WHERE id = 'imported'"
            ).fetchone()
            self.assertEqual(row["app"], "mnemosyne")
            self.assertEqual(row["origin"], "deliberate")
        finally:
            third.close()


class VecStoreTests(unittest.TestCase):
    """Vec0 lifecycle: captures never embed (nothing reads their vectors),
    deliberate + episodic rows do, and a model/dimension change rebuilds
    the tables at open — recomputed from content, never migrated."""

    def setUp(self):
        try:
            import sqlite_vec  # noqa: F401
        except ImportError:
            self.skipTest("sqlite_vec unavailable in this environment")
        self._embeddings_disabled = os.environ.pop("MEMORY_DISABLE_EMBEDDINGS", None)
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        if self._embeddings_disabled is not None:
            os.environ["MEMORY_DISABLE_EMBEDDINGS"] = self._embeddings_disabled

    def _stub_embed(self, dim):
        return mock.patch.object(
            Store,
            "embed",
            side_effect=lambda texts, origin=None: [[0.5] * dim for _ in texts],
        )

    def test_an_upgraded_store_with_a_missing_vec_table_still_boots(self):
        # A store deployed before the agent-memory split carries the two
        # legacy vec tables and no vec_agent; the open must extend the set
        # per-table and backfill, not raise on the tables it already has.
        with self._stub_embed(EMBEDDING_DIM):
            store = Store(self.tmp / "up.db")
            try:
                if not store.vec_available:
                    self.skipTest("vec unavailable (embeddings disabled or extension missing)")
                session = store.get_or_create_session("hal", "opencode", "ses_u")
                store.upsert_agent(
                    {"id": "m1", "session_id": session, "content": "vector backfill probe"}
                )
                # Drop the agent table through the connection with the
                # extension loaded (the virtual-table module); the reopen
                # re-creates it and backfills the vectors.
                store.conn.execute("DROP TABLE vec_agent")
                store.conn.commit()
            finally:
                store.close()
            reopened = Store(self.tmp / "up.db")
            try:
                self.assertIsNotNone(reopened.agent_row("m1"))
                agent_rowid = reopened.conn.execute(
                    "SELECT rowid FROM agent_memory WHERE id = 'm1'"
                ).fetchone()[0]
                vectors = reopened.stored_vectors("vec_agent", [agent_rowid])
                self.assertTrue(vectors, "the reopened store never backfilled the agent vector")
            finally:
                reopened.close()

    def test_captures_never_embed(self):
        with self._stub_embed(EMBEDDING_DIM):
            store = Store(self.tmp / "vec.db")
            try:
                if not store.vec_available:
                    self.skipTest("vec unavailable (embeddings disabled or extension missing)")
                store.upsert_capture(
                    {
                        "id": "c1",
                        "content": "captured turn",
                        "source": "",
                        "origin": "capture",
                        "app": "opencode",
                    }
                )
                store.upsert_capture(
                    {
                        "id": "d1",
                        "content": "deliberate fact",
                        "source": "fact",
                        "origin": "deliberate",
                        "app": "opencode",
                    }
                )
                working_vectors = store.stored_vectors(
                    "vec_working",
                    [
                        r["rowid"]
                        for r in store.conn.execute("SELECT rowid FROM working_memory").fetchall()
                    ],
                )
                self.assertEqual(len(working_vectors), 1, "only the deliberate row is vectorized")
            finally:
                store.close()

    def test_dim_change_rebuilds_vec_tables(self):
        db_path = self.tmp / "dim.db"
        with mock.patch("memory_store.store.EMBEDDING_DIM", 1024), self._stub_embed(1024):
            store = Store(db_path)
            try:
                store.upsert_capture(
                    {
                        "id": "d1",
                        "content": "deliberate",
                        "source": "fact",
                        "origin": "deliberate",
                        "app": "opencode",
                    }
                )
                store.upsert_episodic({"id": "e1", "content": "summary", "source": "hub"})
                store.upsert_capture(
                    {
                        "id": "c1",
                        "content": "captured",
                        "source": "",
                        "origin": "capture",
                        "app": "opencode",
                    }
                )
            finally:
                store.close()
        with self._stub_embed(EMBEDDING_DIM):
            reopened = Store(db_path)
            try:
                ddl = reopened.conn.execute(
                    "SELECT sql FROM sqlite_master WHERE name = 'vec_working'"
                ).fetchone()["sql"]
                self.assertIn(f"float[{EMBEDDING_DIM}]", ddl)
                self.assertNotIn("float[1024]", ddl)
                # Backfill recomputed only reader-consumed rows: deliberate
                # + episodic, never the capture.
                self.assertEqual(
                    reopened.conn.execute("SELECT COUNT(*) AS n FROM vec_working").fetchone()["n"],
                    1,
                )
                self.assertEqual(
                    reopened.conn.execute("SELECT COUNT(*) AS n FROM vec_episodes").fetchone()["n"],
                    1,
                )
                self.assertEqual(reopened._meta_get("embedding_model"), EMBEDDING_MODEL)
                self.assertEqual(reopened._meta_get("embedding_dim"), str(EMBEDDING_DIM))
                # The backfilled vectors carry the NEW model's space:
                vectors = reopened.stored_vectors(
                    "vec_episodes",
                    [
                        r["rowid"]
                        for r in reopened.conn.execute(
                            "SELECT rowid FROM episodic_memory"
                        ).fetchall()
                    ],
                )
                self.assertTrue(all(v[0] == 0.5 for v in vectors.values()))
            finally:
                reopened.close()

    def test_reopen_after_rebuild_is_idempotent(self):
        # A second open must not rebuild: vec0 rejects a duplicate rowid
        # insert, so a spurious re-backfill would crash every open.
        db_path = self.tmp / "idem.db"
        with self._stub_embed(EMBEDDING_DIM):
            store = Store(db_path)
            store.upsert_episodic({"id": "e1", "content": "summary", "source": "hub"})
            store.close()
            reopened = Store(db_path)
            try:
                self.assertEqual(reopened._meta_get("embedding_dim"), str(EMBEDDING_DIM))
                self.assertEqual(
                    reopened.conn.execute("SELECT COUNT(*) AS n FROM vec_episodes").fetchone()["n"],
                    1,
                )
            finally:
                reopened.close()

    def test_legacy_vec_tables_without_meta_rebuild(self):
        # Stores written before store_meta existed (the bge-large era) hold
        # 1024-dim tables with no meta row: the first open takes the
        # rebuild path — this is the client migration.
        db_path = self.tmp / "legacy.db"
        with mock.patch("memory_store.store.EMBEDDING_DIM", 1024), self._stub_embed(1024):
            store = Store(db_path)
            try:
                store.upsert_episodic({"id": "e1", "content": "summary", "source": "hub"})
                store.conn.execute("DELETE FROM store_meta")
            finally:
                store.close()
        with self._stub_embed(EMBEDDING_DIM):
            reopened = Store(db_path)
            try:
                ddl = reopened.conn.execute(
                    "SELECT sql FROM sqlite_master WHERE name = 'vec_working'"
                ).fetchone()["sql"]
                self.assertIn(f"float[{EMBEDDING_DIM}]", ddl)
                self.assertNotIn("float[1024]", ddl)
                self.assertEqual(reopened._meta_get("embedding_dim"), str(EMBEDDING_DIM))
            finally:
                reopened.close()


if __name__ == "__main__":
    unittest.main()
