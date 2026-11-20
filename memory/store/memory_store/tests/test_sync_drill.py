"""Convergence drill: two stores exchange records through a fake hub and
must reach identical state — including offline-rejoin, sibling rules, and
delete-after-resurrect ordering (sync PRD success signals, as tests)."""

from __future__ import annotations

import contextlib
import json
import tempfile
import unittest
import urllib.request as machine_urllib
from pathlib import Path
from unittest import mock

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.store import Store
from memory_store.sync import RecordContractError, SyncClient


class _FakeResponse:
    def __init__(self, body):
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeHub:
    """In-memory relay: accepts pushes, serves cursor-paged pulls, exactly
    like the hub's record_log contract (dumb relay, never interprets)."""

    def __init__(self):
        self.log = []
        self.seq = 0

    def receive(self, records):
        for record in records:
            self.seq += 1
            self.log.append({"seq": self.seq, **record})

    def serve(self, cursor, limit):
        rows = [r for r in self.log if r["seq"] > cursor][:limit]
        return {
            "records": rows,
            "next_cursor": rows[-1]["seq"] if rows else cursor,
            "has_more": len(rows) == limit,
        }


def drain(machine: SyncClient, hub: FakeHub, limit=100):
    """Push all, then pull to cursor end — one full convergence pass."""
    path = Path(machine.queue_dir) / "outbound.jsonl"
    if path.exists() and path.stat().st_size:
        with mock.patch.object(
            machine, "_request_records", side_effect=lambda cursor, lim: hub.serve(cursor, lim)
        ):
            with mock.patch.object(
                machine,
                "push",
                side_effect=lambda: _fake_push(machine, hub),
            ):
                machine.push()
            machine.pull(limit)
    else:
        with mock.patch.object(
            machine, "_request_records", side_effect=lambda cursor, lim: hub.serve(cursor, lim)
        ):
            machine.pull(limit)


def _fake_push(machine, hub):
    import os
    import time

    path = os.path.join(machine.queue_dir, "outbound.jsonl")
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return {"pushed": 0}
    processing = f"{path}.{time.time_ns()}.processing"
    os.rename(path, processing)
    with open(processing) as queue:
        records = [json.loads(line) for line in queue if line.strip()]
    hub.receive(records)
    os.unlink(processing)
    return {"pushed": len(records)}


class ConvergenceDrillTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.hub = FakeHub()
        self.a_store = Store(self.tmp / "a.db")
        self.b_store = Store(self.tmp / "b.db")
        self.a = SyncClient(self.a_store, "http://hub", "host-a", queue_dir=str(self.tmp / "qa"))
        self.b = SyncClient(self.b_store, "http://hub", "host-b", queue_dir=str(self.tmp / "qb"))

    def tearDown(self):
        self.a_store.close()
        self.b_store.close()

    def _converge(self):
        """Two full passes so cross-traffic completes: A pushes+pulls, then B
        pushes+pulls (receiving A's), then A pulls again (receiving B's)."""
        drain(self.a, self.hub)
        drain(self.b, self.hub)
        drain(self.a, self.hub)
        drain(self.b, self.hub)

    def test_capture_converges_both_directions(self):
        self.a_store.upsert_capture(
            {"id": "cap1", "content": "[USER] on host-a", "source": "cursor:sample:ses_1"}
        )
        self.b_store.upsert_capture(
            {"id": "cap2", "content": "[USER] on host-b", "source": "cursor:sample:ses_2"}
        )
        self.a.enqueue(
            "capture",
            {"id": "cap1", "content": "[USER] on host-a", "source": "cursor:example:ses_1"},
        )
        self.b.enqueue(
            "capture",
            {"id": "cap2", "content": "[USER] on host-b", "source": "cursor:example:ses_2"},
        )
        self._converge()
        for store in (self.a_store, self.b_store):
            contents = {
                r["content"]
                for r in store.conn.execute("SELECT content FROM working_memory").fetchall()
            }
            self.assertEqual(contents, {"[USER] on host-a", "[USER] on host-b"})

    def test_offline_rejoin_loses_nothing(self):
        # Machine B is offline; A writes and syncs.
        self.a_store.upsert_capture(
            {"id": "o1", "content": "while away", "source": "cursor:example:ses_1"}
        )
        self.a.enqueue(
            "capture", {"id": "o1", "content": "while away", "source": "cursor:example:ses_1"}
        )
        drain(self.a, self.hub)
        # B wrote offline too; its queue drains only on rejoin.
        self.b_store.upsert_capture(
            {"id": "o2", "content": "offline note", "source": "cursor:example:ses_2"}
        )
        self.b.enqueue(
            "capture", {"id": "o2", "content": "offline note", "source": "cursor:example:ses_2"}
        )
        self._converge()
        for store in (self.a_store, self.b_store):
            contents = {
                r["content"]
                for r in store.conn.execute("SELECT content FROM working_memory").fetchall()
            }
            self.assertEqual(contents, {"while away", "offline note"})

    def test_sibling_rules_coexist(self):
        # Both machines codify a similar rule offline; siblings both land.
        for machine, store in ((self.a, self.a_store), (self.b, self.b_store)):
            rule = {
                "id": 42,
                "situation": "about to commit",
                "statement": "run checks",
                "grader": "agent",
                "stance": "prescriptive",
            }
            store.upsert_situational(rule)
            machine.enqueue("rule", dict(rule, target="situational"))
        self._converge()
        count = self.a_store.conn.execute("SELECT COUNT(*) AS n FROM situational_rules").fetchone()[
            "n"
        ]
        self.assertEqual(count, 1)  # same id: last-write-wins, converged
        # Different ids (true siblings) coexist:
        self.a_store.upsert_situational(
            {
                "id": 100,
                "situation": "committing now",
                "statement": "checks",
                "grader": "agent",
                "stance": "prescriptive",
            }
        )
        self.b_store.upsert_situational(
            {
                "id": 200,
                "situation": "committing changes",
                "statement": "run checks first",
                "grader": "agent",
                "stance": "prescriptive",
            }
        )
        self.a.enqueue(
            "rule",
            {
                "id": 100,
                "target": "situational",
                "situation": "committing now",
                "statement": "checks",
                "grader": "agent",
                "stance": "prescriptive",
            },
        )
        self.b.enqueue(
            "rule",
            {
                "id": 200,
                "target": "situational",
                "situation": "committing changes",
                "statement": "run checks first",
                "grader": "agent",
                "stance": "prescriptive",
            },
        )
        self._converge()
        ids = {
            r["id"]
            for r in self.a_store.conn.execute("SELECT id FROM situational_rules").fetchall()
        }
        self.assertEqual(ids, {42, 100, 200})

    def test_feedback_increments_accumulate(self):
        rule = {
            "id": 7,
            "situation": "s",
            "statement": "t",
            "grader": "agent",
            "stance": "prescriptive",
        }
        for machine, store in ((self.a, self.a_store), (self.b, self.b_store)):
            store.upsert_situational(rule)
            machine.enqueue("rule", dict(rule, target="situational"))
        self._converge()
        self.a.enqueue(
            "feedback",
            {"rule_id": 7, "rule_kind": "situational", "signal": "confirm", "delta": 1.0},
        )
        self.b.enqueue(
            "feedback",
            {"rule_id": 7, "rule_kind": "situational", "signal": "confirm", "delta": 1.0},
        )
        self._converge()
        for store in (self.a_store, self.b_store):
            confirm = store.conn.execute(
                "SELECT confirm_count FROM situational_rules WHERE id = 7"
            ).fetchone()["confirm_count"]
            self.assertEqual(confirm, 2.0)

    def test_own_forget_replay_applies_cleanly(self):
        # The hub relays a machine's own outbound records back to it: a
        # forget pushed by A returns to A on pull. The replayed forget must
        # apply without raising (idempotent tombstone) and the pull cursor
        # must advance past it — the UNIQUE violation here poisoned the
        # sync cycle, re-failing every 5 minutes in production because the
        # abort happened before the cursor save.
        self.a_store.upsert_capture(
            {"id": "f2", "content": "doomed", "source": "cursor:example:ses_1"}
        )
        self.a.enqueue("forget", {"table": "working_memory", "id": "f2"})
        # Machine A pushes its forget, then pulls — receiving its own
        # forget record relayed back from the hub.
        drain(self.a, self.hub)
        self.assertTrue(self.a_store.is_tombstoned("working_memory", "f2"))
        row = self.a_store.conn.execute("SELECT 1 FROM working_memory WHERE id = 'f2'").fetchone()
        self.assertIsNone(row)
        # The cursor survived the self-echo (nothing re-fails next cycle):
        with mock.patch.object(
            self.a,
            "_request_records",
            side_effect=lambda cursor, lim: self.hub.serve(cursor, lim),
        ):
            result = self.a.pull()
        self.assertEqual(result["applied"], 0)

    def test_forget_prevents_resurrect(self):
        # A deletes; the original write replays later (delayed queue) and
        # must not resurrect the row.
        self.a_store.upsert_capture(
            {"id": "f1", "content": "doomed", "source": "cursor:example:ses_1"}
        )
        self.a.enqueue(
            "capture", {"id": "f1", "content": "doomed", "source": "cursor:example:ses_1"}
        )
        drain(self.a, self.hub)
        self.a.enqueue("forget", {"table": "working_memory", "id": "f1"})
        drain(self.a, self.hub)
        # Delayed replay of the original write (out-of-order arrival):
        self.b.enqueue(
            "capture", {"id": "f1", "content": "doomed", "source": "cursor:example:ses_1"}
        )
        drain(self.b, self.hub)
        for store in (self.a_store, self.b_store):
            row = store.conn.execute("SELECT 1 FROM working_memory WHERE id = 'f1'").fetchone()
            self.assertIsNone(row)
            self.assertTrue(store.is_tombstoned("working_memory", "f1"))

    def test_episodic_fans_out(self):
        self.a.enqueue(
            "episodic",
            {"id": "ep9", "content": "hub-produced summary", "source": "sleep_consolidation"},
        )
        drain(self.a, self.hub)
        drain(self.b, self.hub)
        row = self.b_store.conn.execute(
            "SELECT content FROM episodic_memory WHERE id = 'ep9'"
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["content"], "hub-produced summary")

    def test_enqueue_stamps_occurred_at(self):
        # The hub validates occurred_at on every record and capture
        # payloads don't carry it; enqueue must stamp it or the hub
        # rejects the record and the push silently loses it.
        import datetime

        self.a.enqueue(
            "capture", {"id": "c9", "content": "stamped", "source": "cursor:example:ses_1"}
        )
        with open(Path(self.a.queue_dir) / "outbound.jsonl") as queue:
            record = json.loads(queue.readline())
        self.assertEqual(
            set(record),
            {"record_id", "kind", "machine_id", "occurred_at", "payload"},
        )
        datetime.datetime.fromisoformat(record["occurred_at"].replace("Z", "+00:00"))

    def test_enqueue_refuses_a_record_that_violates_the_contract(self):
        # Validation belongs where an agent is present to handle it or
        # raise it. The hub rejecting the record is correct and invisible:
        # that is how the 2026-09-19 drift ate every grading for days.
        with self.assertRaises(RecordContractError) as ctx:
            self.a.enqueue("feedback", {"rule_id": 1, "rule_kind": "situational", "delta": 1.0})
        self.assertIn("signal must be one of", str(ctx.exception))
        self.assertFalse((Path(self.a.queue_dir) / "outbound.jsonl").exists())

    def test_enqueue_names_the_kind_it_refused(self):
        with self.assertRaisesRegex(RecordContractError, "^capture record rejected before send"):
            self.a.enqueue("capture", {"id": "c10", "source": "cursor:example:ses_1"})

    def test_push_surfaces_hub_rejections(self):
        # An OLD hub: it reports rejections without saying it kept them,
        # which is what every hub did before the invalid_reason column.
        # Such a hub drops the record, so the push must not look
        # successful and the records must return to the live queue — the
        # pre-restore behavior stranded them in an orphaned .processing
        # file, permanently out of the queue (seven batches deep on
        # host-a by 2026-09-19).
        self.a.enqueue(
            "capture", {"id": "c8", "content": "bad record", "source": "cursor:example:ses_1"}
        )

        def fake_urlopen(request, timeout):
            body = json.dumps(
                {
                    "accepted": 0,
                    "duplicates": 0,
                    "mirrored": 0,
                    "rejected": [
                        {
                            "index": 0,
                            "error": "record fields must be "
                            "exactly record_id, kind, machine_id, "
                            "occurred_at, payload",
                        }
                    ],
                }
            ).encode()
            return contextlib.nullcontext(_FakeResponse(body))

        with mock.patch.object(machine_urllib, "urlopen", side_effect=fake_urlopen):
            with self.assertRaises(RuntimeError):
                self.a.push()
        queue_path = Path(self.a.queue_dir) / "outbound.jsonl"
        self.assertTrue(queue_path.exists(), "records must return to the queue on rejection")
        record = json.loads(queue_path.read_text().splitlines()[0])
        self.assertEqual(record["payload"]["content"], "bad record")
        self.assertEqual(
            list((Path(self.a.queue_dir)).glob("outbound.jsonl.*.processing")),
            [],
            "no orphaned .processing files may survive a failed push",
        )

    def test_a_hub_that_kept_the_record_drains_the_queue(self):
        # The same rejection from a hub that says it kept the record: the
        # record is logged there with its reason, so re-sending it would
        # only earn the same answer while blocking the queue behind it.
        self.a.enqueue(
            "capture", {"id": "c11", "content": "bad record", "source": "cursor:example:ses_1"}
        )

        def fake_urlopen(request, timeout):
            body = json.dumps(
                {
                    "accepted": 0,
                    "duplicates": 0,
                    "mirrored": 0,
                    "rejected": [{"index": 0, "error": "unsupported record kind", "kept": True}],
                }
            ).encode()
            return contextlib.nullcontext(_FakeResponse(body))

        with mock.patch.object(machine_urllib, "urlopen", side_effect=fake_urlopen):
            result = self.a.push()
        self.assertEqual((result["pushed"], result["rejected"]), (1, 1))
        self.assertFalse((Path(self.a.queue_dir) / "outbound.jsonl").exists())
        self.assertEqual(list((Path(self.a.queue_dir)).glob("outbound.jsonl.*.processing")), [])

    def test_push_network_failure_restores_queue(self):
        # A dead hub (the 502 crash-loop era) must not strand the batch:
        # unacked records go back on the queue for the next cycle.
        self.a.enqueue(
            "capture",
            {"id": "c7", "content": "survives the outage", "source": "cursor:example:ses_1"},
        )

        def dead_hub(request, timeout):
            raise machine_urllib.URLError("connection refused")

        with mock.patch.object(machine_urllib, "urlopen", side_effect=dead_hub):
            with self.assertRaises(machine_urllib.URLError):
                self.a.push()
        queue_path = Path(self.a.queue_dir) / "outbound.jsonl"
        self.assertTrue(queue_path.exists())
        record = json.loads(queue_path.read_text().splitlines()[0])
        self.assertEqual(record["payload"]["id"], "c7")
        self.assertEqual(list((Path(self.a.queue_dir)).glob("outbound.jsonl.*.processing")), [])

    def test_push_restores_only_unacked_records(self):
        # Batch 1 acks, batch 2 fails: the acked batch must not re-drain
        # (harmless if it did — the hub dedupes — but the restore is
        # precise), the failed batch must.
        for i in range(150):  # two batches at the 100-record cap
            self.a.enqueue(
                "capture",
                {"id": f"c{i}", "content": f"record {i}", "source": "cursor:example:ses_1"},
            )
        calls = {"n": 0}

        def first_ok_then_dead(request, timeout):
            calls["n"] += 1
            if calls["n"] == 1:
                body = json.dumps({"accepted": 100, "duplicates": 0, "mirrored": 0, "rejected": []})
                return contextlib.nullcontext(_FakeResponse(body))
            raise machine_urllib.URLError("hub fell over mid-push")

        with mock.patch.object(machine_urllib, "urlopen", side_effect=first_ok_then_dead):
            with self.assertRaises(machine_urllib.URLError):
                self.a.push()
        queue_path = Path(self.a.queue_dir) / "outbound.jsonl"
        records = [json.loads(line) for line in queue_path.read_text().splitlines()]
        self.assertEqual(len(records), 50, "only the unacked batch is restored")
        self.assertEqual(records[0]["payload"]["id"], "c100")

    def test_orphaned_processing_swept_into_queue(self):
        # A push that died between rename and unlink (daemon kill mid-POST)
        # strands its batch as outbound.jsonl.<ts>.processing; the next
        # push sweeps it back so the records re-drain (hub dedupes).
        orphan = Path(self.a.queue_dir) / "outbound.jsonl.123.processing"
        orphan.write_text(
            json.dumps(
                {
                    "record_id": "orphan-1",
                    "kind": "capture",
                    "machine_id": "host-a",
                    "occurred_at": "2026-09-19T00:00:00Z",
                    "payload": {
                        "id": "orphan",
                        "content": "stranded",
                        "source": "cursor:example:ses_1",
                    },
                }
            )
            + "\n",
            encoding="utf-8",
        )
        posted: list[list[dict]] = []

        def ok_hub(request, timeout):
            posted.append(json.loads(request.data.decode())["records"])
            body = json.dumps(
                {"accepted": len(posted[-1]), "duplicates": 0, "mirrored": 0, "rejected": []}
            )
            return contextlib.nullcontext(_FakeResponse(body))

        self.a.enqueue(
            "capture", {"id": "fresh", "content": "queued", "source": "cursor:example:ses_1"}
        )
        fresh_id = json.loads(
            (Path(self.a.queue_dir) / "outbound.jsonl").read_text().splitlines()[0]
        )["record_id"]
        with mock.patch.object(machine_urllib, "urlopen", side_effect=ok_hub):
            result = self.a.push()
        self.assertEqual(result["pushed"], 2)
        flattened = [r["record_id"] for batch in posted for r in batch]
        self.assertEqual(sorted(flattened), sorted(["orphan-1", fresh_id]))
        self.assertFalse(orphan.exists())


if __name__ == "__main__":
    unittest.main()
