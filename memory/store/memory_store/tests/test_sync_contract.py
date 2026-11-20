"""Sync contract tests: the SyncClient against the REAL hub handler
(HTTPServer in-process, real validation, real record log) — the contract
the FakeHub in test_sync_drill does not enforce."""

from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.store import UNRECORDED_CONVERSATION, Store
from memory_store.sync import SyncClient

from memory_store.server.hub_server import HubHTTPHandler, initialize_hub  # noqa: E402

_ENTITY_SESSION = {"machine": "host-a", "tool": "cursor", "conversation_id": "c1"}


class _QuietHubHandler(HubHTTPHandler):
    def log_message(self, *args):
        pass


class RealHub:
    """The hub_server HTTP handler on an ephemeral loopback port, with the
    same bearer auth and record log the deployed hub uses."""

    def __init__(self, tmp: Path):
        from http.server import HTTPServer

        self.record_db = str(tmp / "records.db")
        initialize_hub(self.record_db)
        handler = type(
            "BoundHandler",
            (_QuietHubHandler,),
            {"api_key": "test-key", "db_path": self.record_db},
        )
        self.server = HTTPServer(("127.0.0.1", 0), handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def _post(url: str, api_key: str, body: bytes) -> dict:
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read())


def _get(url: str, api_key: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {api_key}"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read())


class _ContractCase(unittest.TestCase):
    """Shared fixture: real hub handler + client, embeddings off."""

    @classmethod
    def setUpClass(cls):
        # Embeddings stay off for this suite (capture upserts would hit the
        # fastembed model download); scoped to the class — the module-level
        # version poisoned every later test's Store with vec-less stores.
        cls._saved = os.environ.pop("MEMORY_DISABLE_EMBEDDINGS", None)
        os.environ["MEMORY_DISABLE_EMBEDDINGS"] = "1"

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("MEMORY_DISABLE_EMBEDDINGS", None)
        if cls._saved is not None:
            os.environ["MEMORY_DISABLE_EMBEDDINGS"] = cls._saved

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.hub = RealHub(self.tmp)
        self.store = Store(str(self.tmp / "client.db"))
        self.client = SyncClient(
            self.store,
            self.hub.url(""),
            "host-a",
            api_key="test-key",
            queue_dir=str(self.tmp / "queue"),
        )

    def tearDown(self):
        self.client.store.close()
        self.hub.stop()

    def _strand(self, kind: str, payload: dict, record_id: str = "") -> None:
        """Write a record straight into the outbound queue, the way an
        older client left it there. `enqueue` validates what it builds, so
        it can no longer produce the pre-upgrade shapes these tests are
        about — and a record this version refuses to build is exactly what
        'stranded by an older client' means."""
        queue_dir = Path(self.client.queue_dir)
        queue_dir.mkdir(parents=True, exist_ok=True)
        record = {
            "record_id": record_id or f"host-a-{len(payload)}-{kind}",
            "kind": kind,
            "machine_id": "host-a",
            "occurred_at": "2026-09-19T12:00:00Z",
            "payload": payload,
        }
        with (queue_dir / "outbound.jsonl").open("a", encoding="utf-8") as queue:
            queue.write(json.dumps(record) + "\n")


class SyncContractTests(_ContractCase):
    def _capture_record(self, record_id: str) -> dict:
        return {
            "record_id": record_id,
            "kind": "capture",
            "machine_id": "host-a",
            "occurred_at": "2026-09-18T12:00:00Z",
            "payload": {
                "id": "cap1",
                "content": "[USER] contract probe",
                "source": "cursor:example:ses_1",
                "timestamp": "2026-09-18T12:00:00Z",
                "kind": "speech",
            },
        }

    def test_wire_record_shape_is_exact(self):
        # The hub enforces the exact field set; the client's enqueue must
        # produce exactly it (occurred_at included, ISO-8601).
        self.client.enqueue(
            "capture", {"id": "cap1", "content": "[USER] probe", "source": "cursor:example:ses_1"}
        )
        with open(Path(self.client.queue_dir) / "outbound.jsonl") as queue:
            record = json.loads(queue.readline())
        self.assertEqual(
            set(record),
            {"record_id", "kind", "machine_id", "occurred_at", "payload"},
        )
        from datetime import datetime

        datetime.fromisoformat(record["occurred_at"].replace("Z", "+00:00"))

        # The enqueued record must survive a real push (accepted, not rejected).
        result = self.client.push()
        self.assertEqual(result["pushed"], 1)
        pull = self.client.pull()
        self.assertEqual(pull["applied"], 1)

    def test_pull_applies_record_and_advances_cursor(self):
        response = _post(
            self.hub.url("/records"),
            "test-key",
            json.dumps({"records": [self._capture_record("probe-1")]}).encode(),
        )
        self.assertEqual(response["accepted"], 1)
        pull = self.client.pull()
        self.assertEqual(pull["applied"], 1)
        row = self.store.conn.execute(
            "SELECT content FROM working_memory WHERE id = 'cap1'"
        ).fetchone()
        self.assertEqual(row["content"], "[USER] contract probe")
        # A second pull applies nothing new (cursor is durable).
        self.assertEqual(self.client.pull()["applied"], 0)

    def test_rejected_batch_drains_and_the_hub_holds_the_record(self):
        self.client.enqueue(
            "capture", {"id": "cap1", "content": "[USER] probe", "source": "cursor:example:ses_1"}
        )
        # Strip occurred_at to reproduce a shape the hub rejects.
        path = Path(self.client.queue_dir) / "outbound.jsonl"
        record = json.loads(path.read_text())
        record.pop("occurred_at")
        path.write_text(json.dumps(record))

        result = self.client.push()
        self.assertEqual(result["rejected"], 1)
        # The record is at the hub, marked, so the queue has nothing left
        # to retry and leaves no orphaned .processing file behind.
        self.assertFalse(path.exists())
        self.assertEqual(
            list(Path(self.client.queue_dir).glob("outbound.jsonl.*.processing")),
            [],
        )
        served = self.client._request_records(0, 10)["records"]
        self.assertEqual(len(served), 1)
        self.assertIn("occurred_at", served[0]["invalid_reason"])

    def test_auth_enforced(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(urllib.request.Request(self.hub.url("/records")), timeout=10)
        self.assertEqual(ctx.exception.code, 401)

    def test_capture_accepted_by_relay(self):
        response = _post(
            self.hub.url("/records"),
            "test-key",
            json.dumps({"records": [self._capture_record("probe-2")]}).encode(),
        )
        self.assertEqual(response["accepted"], 1)

    def test_cursor_pagination(self):
        records = [self._capture_record(f"probe-batch-{i}") for i in range(3)]
        _post(self.hub.url("/records"), "test-key", json.dumps({"records": records}).encode())
        first = _get(self.hub.url("/records?cursor=0&limit=2"), "test-key")
        self.assertEqual(len(first["records"]), 2)
        self.assertTrue(first["has_more"])
        second = _get(self.hub.url(f"/records?cursor={first['next_cursor']}&limit=2"), "test-key")
        self.assertEqual(len(second["records"]), 1)
        self.assertFalse(second["has_more"])


class RoundTripTests(_ContractCase):
    """Every record kind must round-trip through the REAL hub handler —
    and every payload is produced by exercising the REAL emit path
    (RecordEmittingTools, the capture drain, the hub worker's fan-out),
    never hand-transcribed: a hand-built dict verifies the author's
    intention, not the code, which is exactly how the feedback vocabulary
    drift and its wrong-weight delta shipped past green suites (the
    producer shipped delta=1.0 for soft gradings while the fixture said
    0.25). Kinds the client does not originate drive their real producer
    instead (episodic = the consolidator's enqueue; capture = the drain)."""

    def setUp(self):
        super().setUp()
        from memory_store.server.daemon import RecordEmittingTools

        self.tools = RecordEmittingTools(
            self.store, "host-a", self.client, str(self.tmp / "floor.md")
        )

    def _assert_accepted(self, count: int):
        result = self.client.push()
        self.assertEqual(result["pushed"], count)
        self.assertEqual(
            result["rejected"],
            0,
            "record rejected by the hub — client/hub contract mismatch",
        )
        return self.client.pull()

    def test_capture_roundtrip(self):
        # Capture's producer IS the drain: seed the plugin-shaped queue
        # and let the real classification/emit path create the record.
        from memory_store.server.daemon import drain_captures

        (self.tmp / "queue" / "capture.jsonl").write_text(
            json.dumps(
                {
                    "role": "user",
                    "app": "test",
                    "text": "[USER] roundtrip probe turn",
                    "cwd": str(self.tmp),
                    "conversation_id": "ses_rt",
                    "ts": 100,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        drained = drain_captures(self.store, self.client, str(self.tmp / "queue"))
        self.assertEqual(drained["drained"], 1)
        # The drain ships the fresh session's registration beside the
        # capture: two records for one turn.
        self._assert_accepted(2)
        row = self.store.conn.execute(
            "SELECT content, origin FROM working_memory WHERE content LIKE '%roundtrip probe%'"
        ).fetchone()
        self.assertEqual(row["origin"], "capture")

    def test_capture_apply_builds_the_registry_too(self):
        # The apply path mirrors the drain: any machine that lands a capture
        # record also registers the session and records the raw turn.
        from memory_store.server.daemon import drain_captures

        (self.tmp / "queue" / "capture.jsonl").write_text(
            json.dumps(
                {
                    "role": "user",
                    "app": "test",
                    "text": "[USER] registry relay probe",
                    "cwd": str(self.tmp),
                    "conversation_id": "ses_registry",
                    "ts": 100,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        drain_captures(self.store, self.client, str(self.tmp / "queue"))
        # The turn registered its session: registration + capture, two
        # records for one line.
        self._assert_accepted(2)
        working_id = self.store.conn.execute(
            "SELECT id FROM working_memory WHERE content LIKE '%registry relay probe%'"
        ).fetchone()["id"]
        # The local write and the relayed-back apply agree: one registry
        # session, one mirrored turn, keyed by the shared row id.
        mirrors = self.store.conn.execute(
            "SELECT h.id AS mirror_id FROM session_history h "
            "JOIN session s ON s.id = h.session_id "
            "WHERE s.client_conversation_id = 'ses_registry'"
        ).fetchall()
        self.assertEqual([m["mirror_id"] for m in mirrors], [working_id])

    def test_session_roundtrip(self):
        # The session producer IS the drain: a child registration line
        # queued plugin-shaped and drained once.
        from memory_store.server.daemon import drain_captures

        (self.tmp / "queue" / "capture.jsonl").write_text(
            json.dumps(
                {
                    "kind": "session",
                    "conversation_id": "ses_child",
                    "parent_conversation_id": "ses_top",
                    "cwd": str(self.tmp),
                    "app": "test",
                    "ts": 100,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        self.assertEqual(
            drain_captures(self.store, self.client, str(self.tmp / "queue"))["drained"], 1
        )
        self._assert_accepted(1)
        child = self.store.conn.execute(
            "SELECT id, role, parent_session_id FROM session "
            "WHERE client_conversation_id = 'ses_child'"
        ).fetchall()
        self.assertEqual(len(child), 1)
        self.assertEqual(child[0]["role"], "subagent")
        self.assertIsNotNone(child[0]["parent_session_id"])
        # The registration registered the parent too, and no turn rows exist.
        parent = self.store.conn.execute(
            "SELECT role FROM session WHERE id = ?", (child[0]["parent_session_id"],)
        ).fetchone()
        self.assertEqual(parent["role"], "main")
        got = self.store.conn.execute("SELECT COUNT(*) AS n FROM session_history").fetchone()["n"]
        self.assertEqual(got, 0)

    def test_capture_roundtrip_preserves_a_large_turn(self):
        # The capture contract is 1:1: the drain, hub, and pull path must
        # carry whatever OpenCode provides, not a smaller local policy.
        from memory_store.server.daemon import drain_captures

        content = "[USER] " + "x" * (4 * 1024 * 1024)
        (self.tmp / "queue" / "capture.jsonl").write_text(
            json.dumps(
                {
                    "role": "user",
                    "app": "test",
                    "text": content,
                    "cwd": str(self.tmp),
                    "conversation_id": "ses_large",
                    "ts": 100,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        self.assertEqual(
            drain_captures(self.store, self.client, str(self.tmp / "queue"))["drained"],
            1,
        )
        records = [
            json.loads(line)
            for line in (self.tmp / "queue" / "outbound.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
        ]
        record = next(r for r in records if r["kind"] == "capture")
        self.assertEqual(record["payload"]["content"], content)
        # One turn, two records: the fresh session's registration ships
        # beside the capture.
        self._assert_accepted(2)
        row = self.store.conn.execute(
            "SELECT content FROM working_memory WHERE id = ?", (record["payload"]["id"],)
        ).fetchone()
        self.assertEqual(row["content"], content)

    def test_memory_roundtrip(self):
        self.tools.memory_remember(app="test", content="deliberate roundtrip fact", source="fact")
        # The record is the agent-memory shape now: row fields + the
        # session's resolution triple (machine/tool/conversation_id,
        # never a registry id).
        record = json.loads((self.tmp / "queue" / "outbound.jsonl").read_text(encoding="utf-8"))
        self.assertEqual(record["kind"], "agent_memory")
        # A write with no conversation knows its machine but not its
        # conversation; the placeholder anchor carries the machine.
        self.assertEqual(record["payload"]["session"]["machine"], "host-a")
        # An unprompted conversation id anchors to the placeholder session.
        self.assertEqual(record["payload"]["session"]["conversation_id"], UNRECORDED_CONVERSATION)
        self._assert_accepted(1)
        row = self.store.conn.execute(
            "SELECT scope, source FROM agent_memory WHERE content = 'deliberate roundtrip fact'"
        ).fetchone()
        self.assertEqual(row["scope"], "project")
        self.assertEqual(row["source"], "fact")

    def test_agent_memory_roundtrip(self):
        # The deliberate home: a write with a session link, the record
        # carries the triple, apply resolves a LOCAL registry row for it.
        self.tools.memory_remember(
            app="test", content="session-linked fact", source="insight", conversation_id="ses_rt"
        )
        record = json.loads((self.tmp / "queue" / "outbound.jsonl").read_text(encoding="utf-8"))
        self.assertEqual(record["kind"], "agent_memory")
        self.assertEqual(
            record["payload"]["session"],
            {"machine": "host-a", "tool": "test", "conversation_id": "ses_rt", "project": ""},
        )
        self._assert_accepted(1)
        session = self.store.conn.execute(
            """SELECT s.machine, s.tool, s.client_conversation_id AS conversation
               FROM agent_memory a JOIN session s ON a.session_id = s.id
               WHERE a.content = 'session-linked fact'"""
        ).fetchone()
        self.assertEqual(session["machine"], "host-a")
        self.assertEqual(session["conversation"], "ses_rt")
        # The relay-back of the same record is a no-op, not a second row.
        self.client.push()
        self.client.pull()
        self.assertEqual(
            self.store.conn.execute("SELECT COUNT(*) AS n FROM agent_memory").fetchone()["n"],
            1,
        )

    def test_an_agent_memory_replay_after_forget_is_refused(self):
        self.tools.memory_remember(
            app="test", content="doomed linked fact", source="insight", conversation_id="ses_t"
        )
        record = json.loads((self.tmp / "queue" / "outbound.jsonl").read_text(encoding="utf-8"))
        row_id = record["payload"]["id"]
        self.tools.memory_forget(table="agent_memory", id=row_id)
        # The remember record is still queued on top of one forget record
        # per deliberate home.
        self._assert_accepted(3)
        # The hub relays the record back; a forgotten row stays dead.
        self.client.apply(record)
        self.assertIsNone(
            self.store.conn.execute("SELECT 1 FROM agent_memory WHERE id = ?", (row_id,)).fetchone()
        )
        self.assertTrue(self.store.is_tombstoned("agent_memory", row_id))

    def test_episodic_roundtrip(self):
        # Episodic's producer is the client consolidator: the daemon enqueues
        # an episodic record, the relay serves it, and another machine's
        # apply lands it in its episodic table.
        self.store.upsert_episodic(
            {
                "id": "ep-rt",
                "content": "consolidated summary roundtrip",
                "source": "sleep_consolidation",
                "importance": 0.6,
                "timestamp": "2026-09-19T12:00:00Z",
                "session_id": "ses_rt",
                "repo": "example",
                "origin": "consolidated",
                "app": "memory-store",
                "summary_of": "ses_rt",
            }
        )
        payload = dict(
            self.store.conn.execute(
                "SELECT id, content, source, timestamp, session_id, repo, origin, "
                "app, summary_of FROM episodic_memory WHERE id = 'ep-rt'"
            ).fetchone()
        )
        payload["metadata"] = {"consolidator_version": "rev:test"}
        self.client.enqueue("episodic", payload)
        self._assert_accepted(1)
        row = self.store.conn.execute(
            "SELECT content FROM episodic_memory WHERE id = 'ep-rt'"
        ).fetchone()
        self.assertEqual(row["content"], "consolidated summary roundtrip")

    def test_rule_roundtrip(self):
        self.tools.rule_codify(
            situation="committing",
            statement="run checks first",
            grader="agent",
            stance="prescriptive",
        )
        self._assert_accepted(1)
        row = self.store.conn.execute(
            "SELECT statement FROM situational_rules WHERE statement = 'run checks first'"
        ).fetchone()
        self.assertEqual(row["statement"], "run checks first")

    def test_feedback_roundtrip(self):
        # Grade through the real tool stack and ship what it emitted —
        # the exact path that never crossed the real validator before,
        # with the producer's own field values (canonical signal,
        # effective delta), not a transcription.
        rule = self.tools.rule_codify(
            situation="deploying",
            statement="check-example first",
            grader="agent",
            stance="prescriptive",
        )
        self.tools.rule_feedback(
            rule_id=rule["rule_id"],
            signal="soft",
            polarity="disconfirm",
            grounds="fired on a planning turn",
        )
        self._assert_accepted(2)  # rule + feedback, both accepted
        row = self.store.conn.execute(
            "SELECT confirm_count, disconfirm_count FROM situational_rules WHERE id = ?",
            (rule["rule_id"],),
        ).fetchone()
        self.assertEqual((row["confirm_count"], row["disconfirm_count"]), (0.0, 0.25))

    def test_feedback_all_canonical_signals_accepted(self):
        # The vocabulary contract itself: every agent-facing shape emits a
        # canonical record that the real validator accepts.
        from memory_store.store import FEEDBACK_SIGNALS

        rule = self.tools.rule_codify(
            situation="s", statement="st", grader="agent", stance="prescriptive"
        )
        for kwargs in (
            {"signal": "confirm"},
            {"signal": "disconfirm"},
            {"signal": "soft", "polarity": "confirm"},
            {"signal": "soft", "polarity": "disconfirm"},
        ):
            self.tools.rule_feedback(rule_id=rule["rule_id"], **kwargs)
        self._assert_accepted(5)  # rule + 4 gradings
        # Field-complete: every shipped delta is the effective weight.
        rows = self.store.conn.execute(
            "SELECT signal, delta FROM feedback_log WHERE rule_id = ? ORDER BY id",
            (rule["rule_id"],),
        ).fetchall()
        self.assertEqual(sorted({r["signal"] for r in rows}), sorted(FEEDBACK_SIGNALS))
        for r in rows:
            self.assertEqual(r["delta"], 0.25 if r["signal"].startswith("soft_") else 1.0)

    def test_forget_roundtrip(self):
        self.tools.memory_remember(app="test", content="doomed roundtrip row", source="fact")
        self._assert_accepted(1)
        row_id = self.store.conn.execute(
            "SELECT id FROM agent_memory WHERE content = 'doomed roundtrip row'"
        ).fetchone()["id"]
        self.tools.memory_forget(table="agent_memory", id=row_id)
        # One forget record per deliberate home (both tombstone); the
        # remember record already landed in the first accepted push.
        self._assert_accepted(2)
        self.assertTrue(self.store.is_tombstoned("agent_memory", row_id))
        self.assertTrue(self.store.is_tombstoned("working_memory", row_id))
        row = self.store.conn.execute(
            "SELECT 1 FROM agent_memory WHERE id = ?", (row_id,)
        ).fetchone()
        self.assertIsNone(row)

    def test_entity_roundtrip(self):
        self.client.enqueue(
            "entity",
            {
                "op": "create",
                "session": _ENTITY_SESSION,
                "id": "e1",
                "kind": "human",
                "created_at": "2026-10-23T12:00:00Z",
            },
        )
        self.client.enqueue(
            "entity",
            {
                "op": "rename",
                "session": _ENTITY_SESSION,
                "id": "n1",
                "entity_id": "e1",
                "display_name": "Jane Doe",
                "created_at": "2026-10-23T12:00:01Z",
            },
        )
        self._assert_accepted(2)
        row = self.store.conn.execute(
            "SELECT kind, display_name FROM current_entities WHERE id = 'e1'"
        ).fetchone()
        self.assertEqual((row["kind"], row["display_name"]), ("human", "Jane Doe"))

    def test_entity_forget_roundtrip(self):
        self.client.enqueue(
            "entity",
            {
                "op": "create",
                "session": _ENTITY_SESSION,
                "id": "e1",
                "kind": "human",
                "created_at": "2026-10-23T12:00:00Z",
            },
        )
        self.client.enqueue("forget", {"table": "entities", "id": "e1", "session": _ENTITY_SESSION})
        self._assert_accepted(2)
        self.assertIsNone(
            self.store.conn.execute("SELECT 1 FROM current_entities WHERE id = 'e1'").fetchone()
        )
        # No tombstone: a tombstone would refuse the rows a restore needs.
        self.assertFalse(self.store.is_tombstoned("entities", "e1"))
        self.assertEqual(
            self.store.conn.execute("SELECT COUNT(*) AS n FROM entities").fetchone()["n"], 1
        )

    def test_a_removal_pulled_before_its_row_defers_then_applies(self):
        """The ordering the directory's design leans on: the removal is set
        aside until the row it ends arrives, and the end state matches
        in-order apply."""
        self._strand(
            "entity",
            {
                "op": "create",
                "session": _ENTITY_SESSION,
                "id": "e1",
                "kind": "human",
                "created_at": "2026-10-23T12:00:00Z",
            },
            record_id="host-a-e1",
        )
        self._strand(
            "entity",
            {"op": "alias_remove", "id": "a1", "deleted_at": "2026-10-23T12:00:05Z"},
            record_id="host-a-remove",
        )
        self._strand(
            "entity",
            {
                "op": "alias_add",
                "session": _ENTITY_SESSION,
                "id": "a1",
                "entity_id": "e1",
                "type": "github",
                "value": "jdoe",
                "instance": "github.com",
                "created_at": "2026-10-23T12:00:02Z",
            },
            record_id="host-a-add",
        )
        self.client.push()

        result = self.client.pull()
        self.assertEqual((result["applied"], result["deferred"]), (3, 0))
        self.assertIsNone(
            self.store.conn.execute("SELECT 1 FROM current_aliases WHERE id = 'a1'").fetchone()
        )
        row = self.store.conn.execute(
            "SELECT deleted_at FROM entity_aliases WHERE id = 'a1'"
        ).fetchone()
        self.assertEqual(row["deleted_at"], "2026-10-23T12:00:05Z")

    def test_stranded_old_format_feedback_drains_valid(self):
        # The client situation at the time of the drift: stranded
        # batches carry the agent-facing vocabulary AND the old emitter's
        # pre-weight delta (1.0 for soft — the old code shipped the raw
        # delta param, not the effective one). Push-time normalization
        # upgrades them in place so they finally drain.
        self._strand(
            "feedback",
            {
                "rule_id": 6000,
                "rule_kind": "situational",
                "signal": "disconfirm",
                "delta": 1.0,
                "origin_machine": "host-a",
            },
            record_id="host-a-stranded-6000",
        )
        self._strand(
            "feedback",
            {
                "rule_id": 6001,
                "rule_kind": "situational",
                "signal": "soft",
                "polarity": "disconfirm",
                "delta": 1.0,
                "origin_machine": "host-a",
            },
            record_id="host-a-stranded-6001",
        )
        result = self.client.push()
        self.assertEqual(result["pushed"], 2)
        self.assertEqual(result["rejected"], 0)
        self.client.pull()
        rows = {
            r["rule_id"]: r["signal"]
            for r in self.store.conn.execute(
                "SELECT rule_id, signal FROM feedback_log WHERE rule_id IN (6000, 6001)"
            ).fetchall()
        }
        self.assertEqual(rows, {6000: "refute", 6001: "soft_refute"})

    def test_push_reports_rejections_on_result(self):
        # A rejected record must be visible as data, not just a raised
        # exception's log line — the rejection count rides the push result
        # (and the sync span) so contract drift is measurable. Unknown
        # signals pass through normalization untouched and are rejected by
        # the real validator (per-record, batch's valid records still ship).
        # Stranded rather than enqueued: this version will not build one.
        self._strand(
            "feedback",
            {
                "rule_id": 1,
                "rule_kind": "situational",
                "signal": "bogus-signal",
                "delta": 1.0,
                "origin_machine": "host-a",
            },
            record_id="host-a-bogus",
        )
        result = self.client.push()
        self.assertEqual(result["rejected"], 1)
        self.assertEqual(result["pushed"], 1)


class InvalidRecordTests(_ContractCase):
    """A record the hub marked invalid rides the pull so it is visible,
    and is stepped over rather than applied — applying a known-bad record
    turns it into a row nobody can tell from a good one."""

    def test_an_invalid_record_is_skipped_and_the_cursor_advances(self):
        self._strand(
            "memory",
            {"id": "m-bad", "content": "", "source": "fact"},
            record_id="host-a-bad",
        )
        self.client.push()

        result = self.client.pull()
        self.assertEqual(result["applied"], 0)
        self.assertEqual(result["skipped"], 1)
        row = self.store.conn.execute(
            "SELECT COUNT(*) AS n FROM working_memory WHERE id = 'm-bad'"
        ).fetchone()
        self.assertEqual(row["n"], 0)
        # The cursor moved past it: a marked record must not be re-pulled
        # forever, and must not block the records behind it.
        self.assertEqual(self.client.pull()["skipped"], 0)

    def test_valid_records_behind_an_invalid_one_still_apply(self):
        """One queue, one push, one pull: the bad record neither blocks
        the good one on the way out nor gets applied on the way in."""
        self._strand("memory", {"id": "m-bad", "content": ""}, record_id="host-a-bad")
        self.client.enqueue(
            "memory",
            {"id": "m-good", "content": "a durable fact", "source": "fact"},
        )
        result = self.client.push()
        self.assertEqual((result["pushed"], result["rejected"]), (2, 1))
        self.assertFalse((Path(self.client.queue_dir) / "outbound.jsonl").exists())

        result = self.client.pull()
        self.assertEqual((result["applied"], result["skipped"]), (1, 1))
        row = self.store.conn.execute(
            "SELECT content FROM working_memory WHERE id = 'm-good'"
        ).fetchone()
        self.assertEqual(row["content"], "a durable fact")

    def test_a_rejected_record_does_not_cycle_on_the_queue(self):
        """The bug this closes: the record was restored to the queue and
        re-sent every cycle, so nothing queued behind it ever left."""
        self._strand("memory", {"id": "m-bad", "content": ""}, record_id="host-a-bad")
        self.assertEqual(self.client.push()["rejected"], 1)
        queue_path = Path(self.client.queue_dir) / "outbound.jsonl"
        self.assertFalse(queue_path.exists())
        self.assertEqual(list(Path(self.client.queue_dir).glob("*.processing")), [])
        # Nothing left to send, so the next cycle is a no-op rather than a
        # repeat of the same rejection.
        self.assertEqual(self.client.push(), {"pushed": 0})

    def test_a_rejection_in_the_first_batch_does_not_strand_the_second(self):
        """Batches are 100 records; the rejection used to abort the whole
        push, so every record after the first batch stayed on the queue."""
        self._strand("memory", {"id": "m-bad", "content": ""}, record_id="host-a-bad")
        for n in range(120):
            self.client.enqueue(
                "memory",
                {"id": f"m-{n}", "content": f"durable fact {n}", "source": "fact"},
            )
        result = self.client.push()
        self.assertEqual((result["pushed"], result["rejected"]), (121, 1))
        self.assertFalse((Path(self.client.queue_dir) / "outbound.jsonl").exists())

        self.client.pull()
        count = self.store.conn.execute(
            "SELECT COUNT(*) AS n FROM working_memory WHERE id LIKE 'm-%'"
        ).fetchone()
        self.assertEqual(count["n"], 120)


class _UpgradedClient(SyncClient):
    """Stands in for a later version that knows a kind this one does not."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.sightings: list[dict] = []

    def apply(self, record):
        if record["kind"] == "sighting":
            self.sightings.append(record["payload"])
            return
        super().apply(record)


class _FlakyClient(SyncClient):
    """Fails chosen records' applies a set number of times, the way a
    passing fault such as an embedder that will not load does."""

    def __init__(self, *args, failures: dict[str, int], **kwargs):
        super().__init__(*args, **kwargs)
        self.failures = failures

    def apply(self, record):
        if self.failures.get(record["record_id"], 0) > 0:
            self.failures[record["record_id"]] -= 1
            raise RuntimeError("embedder unavailable")
        super().apply(record)


class DeferredRecordTests(_ContractCase):
    """A record this machine cannot apply is set aside and the cursor moves
    on (ADR 20261023-forward-compatible-sync). Raising instead fails the
    same page every cycle, so nothing behind it ever arrives."""

    def _sighting(self, record_id: str, name: str) -> None:
        self._strand("sighting", {"seen": name}, record_id=record_id)

    def _deferred(self) -> list[dict]:
        return self.store.deferred_records()

    def test_an_unknown_kind_is_deferred_and_records_behind_it_apply(self):
        self._sighting("host-a-e1", "someone")
        self.client.enqueue("memory", {"id": "m-good", "content": "a durable fact"})
        self.assertEqual(self.client.push()["rejected"], 0)

        result = self.client.pull()
        self.assertEqual((result["applied"], result["deferred"]), (1, 1))
        rows = self._deferred()
        self.assertEqual([r["record_id"] for r in rows], ["host-a-e1"])
        self.assertIn("unknown record kind", rows[0]["reason"])
        row = self.store.conn.execute(
            "SELECT content FROM working_memory WHERE id = 'm-good'"
        ).fetchone()
        self.assertEqual(row["content"], "a durable fact")
        # The cursor moved past it: the next pull fetches nothing new and
        # only retries what was set aside.
        again = self.client.pull()
        self.assertEqual((again["applied"], again["deferred"]), (0, 1))

    def test_a_known_kind_whose_apply_raises_is_deferred(self):
        """A rule passes the hub's check on target, then the store rejects
        a grader it does not recognize — the same stall, from a known kind."""
        self._strand(
            "rule",
            {
                "target": "situational",
                "id": 7,
                "situation": "s",
                "statement": "st",
                "grader": "nobody",
                "stance": "prescriptive",
            },
            record_id="host-a-r7",
        )
        self.client.enqueue("memory", {"id": "m-after", "content": "behind the rule"})
        self.client.push()

        result = self.client.pull()
        self.assertEqual((result["applied"], result["deferred"]), (1, 1))
        self.assertIn("invalid grader", self._deferred()[0]["reason"])

    def test_retry_applies_once_the_client_can_and_drops_the_row(self):
        self._sighting("host-a-e1", "someone")
        self.client.push()
        self.client.pull()
        self.assertEqual(len(self._deferred()), 1)

        upgraded = _UpgradedClient(
            self.store,
            self.hub.url(""),
            "host-a",
            api_key="test-key",
            queue_dir=self.client.queue_dir,
        )
        result = upgraded.retry_deferred()
        self.assertEqual(result, {"applied": 1, "by_kind": {"sighting": 1}, "deferred": 0})
        self.assertEqual(upgraded.sightings, [{"seen": "someone"}])
        self.assertEqual(self._deferred(), [])

    def test_retried_records_count_in_the_pull_result(self):
        """The daemon re-renders on by_kind, so a rule that applies on retry
        has to show up there like one that applied on first pull."""
        self._sighting("host-a-e1", "someone")
        self.client.push()
        self.client.pull()
        upgraded = _UpgradedClient(
            self.store,
            self.hub.url(""),
            "host-a",
            api_key="test-key",
            queue_dir=self.client.queue_dir,
        )
        result = upgraded.pull()
        self.assertEqual(result["by_kind"], {"sighting": 1})
        self.assertEqual((result["applied"], result["deferred"]), (1, 0))

    def test_a_retry_that_fails_again_keeps_the_row(self):
        """Nothing retires a record that can never apply: it stays visible,
        with the attempts behind it."""
        self._sighting("host-a-e1", "someone")
        self.client.push()
        self.client.pull()
        attempts = self._deferred()[0]["attempts"]

        result = self.client.retry_deferred()
        self.assertEqual((result["applied"], result["deferred"]), (0, 1))
        self.assertEqual(self._deferred()[0]["attempts"], attempts + 1)

    def test_a_record_waiting_on_a_later_one_applies_in_the_same_pull(self):
        """An entity removal can be logged ahead of the row it ends. The
        retry pass runs after the page drains, so it lands on this pull
        rather than waiting for the next cycle."""
        self._strand(
            "entity",
            {"op": "alias_remove", "id": "a1", "deleted_at": "2026-10-23T12:00:05Z"},
            record_id="host-a-remove",
        )
        self._strand(
            "entity",
            {
                "op": "create",
                "id": "e1",
                "kind": "human",
                "session": _ENTITY_SESSION,
                "created_at": "2026-10-23T12:00:00Z",
            },
            record_id="host-a-create",
        )
        self._strand(
            "entity",
            {
                "op": "alias_add",
                "session": _ENTITY_SESSION,
                "id": "a1",
                "entity_id": "e1",
                "type": "github",
                "value": "jdoe",
                "created_at": "2026-10-23T12:00:02Z",
            },
            record_id="host-a-add",
        )
        self.client.push()

        result = self.client.pull()
        self.assertEqual((result["applied"], result["deferred"]), (3, 0))
        self.assertEqual(self._deferred(), [])
        self.assertIsNone(
            self.store.conn.execute("SELECT 1 FROM current_aliases WHERE id = 'a1'").fetchone()
        )

    def test_deferred_records_retry_in_log_order(self):
        # Ids sort opposite to push order, so only the hub sequence can
        # produce the expected order.
        for n, suffix in enumerate(("z", "m", "a")):
            self._sighting(f"host-a-{suffix}", f"person {n}")
        self.client.push()
        self.client.pull()
        upgraded = _UpgradedClient(
            self.store,
            self.hub.url(""),
            "host-a",
            api_key="test-key",
            queue_dir=self.client.queue_dir,
        )
        upgraded.retry_deferred()
        self.assertEqual(
            [sighting["seen"] for sighting in upgraded.sightings],
            ["person 0", "person 1", "person 2"],
        )

    def _client(self, cls=SyncClient, **kwargs) -> SyncClient:
        return cls(
            self.store,
            self.hub.url(""),
            "host-a",
            api_key="test-key",
            queue_dir=self.client.queue_dir,
            **kwargs,
        )

    def _rule(self, record_id: str, rule_id: int, statement: str, grader: str) -> None:
        self._strand(
            "rule",
            {
                "target": "situational",
                "id": rule_id,
                "situation": "s",
                "statement": statement,
                "grader": grader,
                "stance": "prescriptive",
            },
            record_id=record_id,
        )

    def _content(self, row_id: str) -> str | None:
        row = self.store.conn.execute(
            "SELECT content FROM working_memory WHERE id = ?", (row_id,)
        ).fetchone()
        return row["content"] if row else None

    def test_a_rows_later_edit_waits_behind_its_deferred_one(self):
        """The last apply wins for a memory, so applying the older edit on
        retry, after the newer one, would leave this machine holding it
        while every other machine holds the newer."""
        self._strand("memory", {"id": "m1", "content": "prefers tabs"}, record_id="host-a-1")
        self._strand("memory", {"id": "m1", "content": "prefers spaces"}, record_id="host-a-2")
        self.client.push()

        flaky = self._client(_FlakyClient, failures={"host-a-1": 1})
        result = flaky.pull()
        self.assertEqual((result["applied"], result["deferred"]), (2, 0))
        self.assertEqual(self._content("m1"), "prefers spaces")

    def test_a_rows_edits_land_in_order_once_the_head_applies(self):
        """The upgrade case: an older machine cannot apply a rule's first
        edit but could apply its second. Both wait, and the upgrade lands
        them in log order."""
        self._rule("host-a-r1", 7, "first", "nobody")
        self._rule("host-a-r2", 7, "second", "user")
        self.client.push()

        result = self.client.pull()
        self.assertEqual((result["applied"], result["deferred"]), (0, 2))
        reasons = [row["reason"] for row in self._deferred()]
        self.assertIn("invalid grader", reasons[0])
        self.assertIn("waiting behind", reasons[1])

        with mock.patch("memory_store.store.SITUATIONAL_GRADERS", ("user", "agent", "nobody")):
            retried = self.client.retry_deferred()
        self.assertEqual((retried["applied"], retried["deferred"]), (2, 0))
        row = self.store.conn.execute(
            "SELECT statement, grader FROM situational_rules WHERE id = 7"
        ).fetchone()
        self.assertEqual((row["statement"], row["grader"]), ("second", "user"))

    def test_a_stuck_record_holds_only_its_own_row(self):
        self._rule("host-a-r1", 7, "stuck", "nobody")
        self._rule("host-a-r2", 8, "other rule", "user")
        self._strand("memory", {"id": "m1", "content": "a durable fact"}, record_id="host-a-m1")
        self.client.push()

        result = self.client.pull()
        self.assertEqual((result["applied"], result["deferred"]), (2, 1))
        self.assertEqual([row["record_id"] for row in self._deferred()], ["host-a-r1"])
        self.assertIsNotNone(
            self.store.conn.execute("SELECT 1 FROM situational_rules WHERE id = 8").fetchone()
        )
        self.assertEqual(self._content("m1"), "a durable fact")

    def test_a_forget_never_waits_behind_a_deferred_edit(self):
        """Holding a forget back would keep a row this machine was told to
        delete for as long as the edit stays stuck."""
        self._strand("memory", {"id": "m1", "content": "a durable fact"}, record_id="host-a-m1")
        self._strand("forget", {"table": "working_memory", "id": "m1"}, record_id="host-a-f1")
        self.client.push()

        flaky = self._client(_FlakyClient, failures={"host-a-m1": 2})
        result = flaky.pull()
        self.assertEqual((result["applied"], result["deferred"]), (1, 1))
        self.assertTrue(self.store.is_tombstoned("working_memory", "m1"))

        flaky.retry_deferred()
        self.assertEqual(self._deferred(), [])
        self.assertIsNone(self._content("m1"))


class SelfEchoTests(_ContractCase):
    """The relay-back invariant, per kind: the hub relays every record back
    to its origin machine, so the full loop origin -> hub -> origin must
    leave the origin's store reflecting each record exactly ONCE. Capture,
    memory, and rules are upsert-idempotent (asserted here so regressions
    surface); feedback was accumulative with no idempotency — the origin
    counted each of its own gradings twice, live (rule 902359124 measured
    confirm_count 2.0 from one grading, 2026-09-19)."""

    def setUp(self):
        super().setUp()
        from memory_store.server.daemon import RecordEmittingTools

        self.tools = RecordEmittingTools(
            self.store, "host-a", self.client, str(self.tmp / "floor.md")
        )

    def _echo(self):
        self.client.push()
        return self.client.pull()

    def test_feedback_self_echo_counts_once(self):
        rule = self.tools.rule_codify(
            situation="s", statement="st", grader="agent", stance="prescriptive"
        )
        self.tools.rule_feedback(rule_id=rule["rule_id"], signal="confirm")
        self.tools.rule_feedback(rule_id=rule["rule_id"], signal="soft", polarity="disconfirm")
        before = self.store.conn.execute(
            "SELECT confirm_count, disconfirm_count FROM situational_rules WHERE id = ?",
            (rule["rule_id"],),
        ).fetchone()
        self.assertEqual((before["confirm_count"], before["disconfirm_count"]), (1.0, 0.25))
        self._echo()  # the hub relays both gradings back
        after = self.store.conn.execute(
            "SELECT confirm_count, disconfirm_count FROM situational_rules WHERE id = ?",
            (rule["rule_id"],),
        ).fetchone()
        self.assertEqual(
            (after["confirm_count"], after["disconfirm_count"]),
            (before["confirm_count"], before["disconfirm_count"]),
            "self-echo must not re-apply an already-applied grading",
        )
        self._echo()  # and again, repeatedly
        self.assertEqual(
            self.store.conn.execute(
                "SELECT confirm_count FROM situational_rules WHERE id = ?",
                (rule["rule_id"],),
            ).fetchone()["confirm_count"],
            1.0,
        )

    def test_memory_self_echo_idempotent(self):
        self.tools.memory_remember(app="test", content="echo probe fact", source="fact")
        for _ in range(2):
            self._echo()
        self.assertEqual(
            self.store.conn.execute(
                "SELECT COUNT(*) AS n FROM agent_memory WHERE content = 'echo probe fact'"
            ).fetchone()["n"],
            1,
        )

    def test_rule_self_echo_idempotent(self):
        rule = self.tools.rule_codify(
            situation="committing",
            statement="run pre-commit",
            grader="agent",
            stance="prescriptive",
        )
        for _ in range(2):
            self._echo()
        self.assertEqual(
            self.store.conn.execute(
                "SELECT COUNT(*) AS n FROM situational_rules WHERE id = ?",
                (rule["rule_id"],),
            ).fetchone()["n"],
            1,
        )


class HubDisabledTests(unittest.TestCase):
    """A machine keeping its own store configures no hub. Nothing may queue,
    no cycle may reach the network, and no cycle may raise."""

    @classmethod
    def setUpClass(cls):
        cls._saved = os.environ.pop("MEMORY_DISABLE_EMBEDDINGS", None)
        os.environ["MEMORY_DISABLE_EMBEDDINGS"] = "1"

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("MEMORY_DISABLE_EMBEDDINGS", None)
        if cls._saved is not None:
            os.environ["MEMORY_DISABLE_EMBEDDINGS"] = cls._saved

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.store = Store(str(self.tmp / "client.db"))
        self.queue_dir = str(self.tmp / "queue")
        self.client = SyncClient(self.store, "", "host-a", queue_dir=self.queue_dir)

    def tearDown(self):
        self.store.close()

    def test_disabled_without_hub_url(self):
        self.assertFalse(self.client.enabled)

    def test_enabled_with_hub_url(self):
        self.assertTrue(
            SyncClient(
                self.store, "http://127.0.0.1:1/", "host-a", queue_dir=self.queue_dir
            ).enabled
        )

    def test_enqueue_writes_no_queue_file(self):
        for _ in range(3):
            self.client.enqueue("capture", {"id": "x", "content": "turn"})
        self.assertFalse(os.path.exists(os.path.join(self.queue_dir, "outbound.jsonl")))

    def test_enqueue_still_returns_a_record_id(self):
        record_id = self.client.enqueue("feedback", {"rule_id": 1}, record_id="bound-id")
        self.assertEqual(record_id, "bound-id")
        self.assertTrue(self.client.enqueue("memory", {"id": "y"}))

    def test_push_and_pull_are_no_ops(self):
        self.assertEqual(self.client.push(), {"pushed": 0})
        self.assertEqual(self.client.pull(), {"applied": 0, "by_kind": {}})

    def test_run_cycle_does_not_raise(self):
        # A bare hub_url would make this a request against "/records"; the
        # daemon swallows the exception, so an ungated cycle fails silently
        # every interval instead of surfacing.
        self.assertEqual(self.client.run_cycle(), {"pushed": 0, "applied": 0, "by_kind": {}})


if __name__ == "__main__":
    unittest.main()
