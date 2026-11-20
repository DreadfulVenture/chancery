"""Hub integration: the real HTTP relay against a temp database — asserts
validation, auth, idempotent append, and cursor paging (the sync PRD's
hub-side contract, as a test). Consolidation lives on the clients; the hub
holds no mirror and produces no records."""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import HTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../..")

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.server import hub_server  # noqa: E402


class HubFixture:
    """Real relay server on temp dirs; one helper port; one api key."""

    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="hub-test-")
        self.data_dir = os.path.join(self.tmp, "data")
        os.makedirs(self.data_dir)
        self.api_key = "test-key"
        self.record_db = os.path.join(self.data_dir, "records.db")
        hub_server.initialize_hub(self.record_db)
        handler = type(
            "TestHubHandler",
            (hub_server.HubHTTPHandler,),
            {"api_key": self.api_key, "db_path": self.record_db},
        )
        self.server = HTTPServer(("127.0.0.1", 0), handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"

    def push(self, records):
        request = urllib.request.Request(
            f"{self.url}/records",
            data=json.dumps({"records": records}).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())

    def pull(self, cursor=0, limit=100):
        request = urllib.request.Request(
            f"{self.url}/records?cursor={cursor}&limit={limit}",
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())

    def close(self):
        self.server.shutdown()
        self.thread.join(timeout=5)


class HubIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.hub = HubFixture()

    def tearDown(self):
        self.hub.close()

    def _capture(self, record_id, content, source="cursor:example:s1"):
        return {
            "record_id": record_id,
            "kind": "capture",
            "machine_id": "host-a",
            "occurred_at": "2026-09-16T12:00:00Z",
            "payload": {"id": f"cap-{record_id}", "content": content, "source": source},
        }

    def test_push_validates_and_rejects(self):
        bad = dict(self._capture("r0", "hello"), machine_id="Host A")
        result = self.hub.push([bad])
        self.assertEqual(result["rejected"][0]["index"], 0)
        self.assertEqual(result["accepted"], 0)

        good = self._capture("r1", "hello")
        result = self.hub.push([good])
        self.assertEqual(result["accepted"], 1)
        self.assertEqual(result["rejected"], [])

        # Duplicate id: relay is idempotent.
        result = self.hub.push([good])
        self.assertEqual(result["duplicates"], 1)

    def test_rejected_records_are_kept_with_their_reason(self):
        """Rejection used to drop the record, which destroyed the evidence
        at the moment it was created — the 2026-09-19 drift was rejected
        correctly and invisibly for days. The row survives for an audit
        pass, and rides the pull so it is visible away from the hub's
        disk."""
        self.hub.push([dict(self._capture("r1", "hello"), machine_id="Host A")])
        records = self.hub.pull()["records"]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["record_id"], "r1")
        self.assertIn("machine_id must contain only", records[0]["invalid_reason"])

    def test_rejections_say_the_record_was_kept(self):
        """`kept` is what lets a pushing client drain the record instead
        of blocking its queue behind it. Sent per record rather than
        implied by the hub's version, so the client never has to guess
        which hub it reached."""
        result = self.hub.push([dict(self._capture("r4", "hello"), machine_id="Host A")])
        self.assertTrue(result["rejected"][0]["kept"])

    def test_re_pushing_a_marked_record_still_says_kept(self):
        """A client retrying before it learned better must get the same
        answer, or it would treat the retry as a reason to keep the
        record and block its queue again."""
        bad = dict(self._capture("r5", "hello"), machine_id="Host A")
        self.hub.push([bad])
        result = self.hub.push([bad])
        self.assertTrue(result["rejected"][0]["kept"])
        self.assertEqual(result["duplicates"], 1)

    def test_an_unknown_kind_relays_unmarked(self):
        """A machine upgraded ahead of the hub writes a kind the hub has
        never heard of. Marking it would make every client step past it,
        so the record would never reach a machine that can apply it."""
        record = dict(self._capture("r6", "hello"), kind="sighting", payload={"op": "create"})
        result = self.hub.push([record])
        self.assertEqual((result["accepted"], result["rejected"]), (1, []))
        served = self.hub.pull()["records"]
        self.assertEqual([r["kind"] for r in served], ["sighting"])
        self.assertNotIn("invalid_reason", served[0])
        self.assertEqual(served[0]["payload"], {"op": "create"})

    def test_an_unknown_kind_is_logged_once_however_often_it_is_pushed(self):
        """A client re-sends an unacked batch every cycle; the log line
        belongs to the record landing, not to each retry."""
        record = dict(self._capture("r8", "hello"), kind="sighting", payload={"op": "create"})
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.hub.push([record])
            self.hub.push([record])
        self.assertEqual(output.getvalue().count("relaying unknown kind"), 1)

    def test_an_unknown_kind_with_a_bad_envelope_is_still_marked(self):
        record = dict(self._capture("r7", "hello"), kind="sighting", occurred_at="whenever")
        result = self.hub.push([record])
        self.assertEqual(result["accepted"], 0)
        self.assertIn("occurred_at must be ISO 8601", result["rejected"][0]["error"])
        self.assertIn("occurred_at", self.hub.pull()["records"][0]["invalid_reason"])

    def test_valid_records_carry_no_reason(self):
        self.hub.push([self._capture("r2", "hello")])
        self.assertNotIn("invalid_reason", self.hub.pull()["records"][0])

    def test_a_marked_id_is_still_taken(self):
        """Marking occupies the record_id. Origins generate a fresh id per
        emit, so a corrected resend never reuses one — but a retry of the
        same bad record is a duplicate rather than a second row."""
        bad = dict(self._capture("r3", "hello"), machine_id="Host A")
        self.hub.push([bad])
        result = self.hub.push([bad])
        self.assertEqual(result["duplicates"], 1)
        self.assertEqual(len(self.hub.pull()["records"]), 1)

    def test_an_unreadable_record_is_kept_rather_than_lost(self):
        """The fallbacks exist because a record invalid enough to reject
        may be too malformed to read columns off, and losing it is the one
        outcome the change is against."""
        result = self.hub.push([{"payload": {"nested": [1, 2]}}])
        self.assertEqual(len(result["rejected"]), 1)
        records = self.hub.pull()["records"]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["kind"], "unknown")
        self.assertTrue(records[0]["record_id"].startswith("invalid-"))
        self.assertIn("fields must be exactly", records[0]["invalid_reason"])

    def test_the_invalid_column_is_added_to_an_existing_log(self):
        """Deployed hubs predate the column; initialize_hub runs CREATE
        TABLE IF NOT EXISTS, which would leave them without it."""
        import sqlite3

        legacy = os.path.join(self.hub.data_dir, "legacy.db")
        connection = sqlite3.connect(legacy)
        connection.executescript(
            """
            CREATE TABLE hub_records (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                record_id TEXT NOT NULL UNIQUE,
                direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
                kind TEXT NOT NULL,
                machine_id TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                payload TEXT NOT NULL,
                mirrored INTEGER NOT NULL DEFAULT 0
            );
            """
        )
        connection.close()
        hub_server.initialize_hub(legacy)
        connection = sqlite3.connect(legacy)
        columns = {row[1] for row in connection.execute("PRAGMA table_info(hub_records)")}
        connection.close()
        self.assertIn("invalid_reason", columns)

    def test_auth_required(self):
        request = urllib.request.Request(
            f"{self.hub.url}/records",
            data=json.dumps({"records": [self._capture("r2", "x")]}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            urllib.request.urlopen(request, timeout=10)
            self.fail("expected 401")
        except urllib.error.HTTPError as error:
            self.assertEqual(error.code, 401)

    def test_relay_is_pull_shaped_no_mirror(self):
        """The hub stores records verbatim and manufactures nothing: a pushed
        capture stays a log row; no working-memory mirror, no episodic."""
        records = [
            self._capture("r3", "[USER] we deploy with make targets", "cursor:sample:s1"),
            self._capture("r4", "[AGENT] ran make test-memory", "cursor:example:s1"),
        ]
        result = self.hub.push(records)
        self.assertEqual(result["accepted"], 2)
        self.assertEqual(result.get("mirrored", 0), 0)
        pull = self.hub.pull()
        kinds = {r["kind"] for r in pull["records"]}
        self.assertEqual(kinds, {"capture"})
        self.assertEqual(len(pull["records"]), 2)

    def test_pull_paging(self):
        records = [self._capture(f"p{i}", f"turn {i}") for i in range(5)]
        self.hub.push(records)
        page1 = self.hub.pull(cursor=0, limit=3)
        self.assertEqual(len(page1["records"]), 3)
        self.assertTrue(page1["has_more"])
        page2 = self.hub.pull(cursor=page1["next_cursor"], limit=3)
        self.assertEqual(len(page2["records"]), 2)
        self.assertFalse(page2["has_more"])


if __name__ == "__main__":
    unittest.main()
