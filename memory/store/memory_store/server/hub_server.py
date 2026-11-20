"""Memory-store hub server: the record log relay.

One stdlib HTTP server, one SQLite database (the record log; single writer —
the server itself appends, WAL + busy timeout absorb concurrency). No
mnemosyne package code runs here.

Endpoints:
  POST /records  — authenticated batch push (dumb relay: validate, append)
  GET  /records   — cursor-paged pull for machines (outbound = everything
                   appended inbound)

The hub never interprets record semantics beyond validation — convergence
logic lives in the clients' idempotent apply.
"""

from __future__ import annotations

import hmac
import json
import os
import sqlite3
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit

# The record contract lives in store: origins validate against it before a
# record leaves, and the hub applies the same definition as a backstop.
from memory_store.store import RECORD_KINDS, validate_record


def _text(value):
    return value if isinstance(value, str) and value else ""


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def initialize_hub(db_path):
    connection = sqlite3.connect(db_path, timeout=10)
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS hub_records (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                record_id TEXT NOT NULL UNIQUE,
                direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
                kind TEXT NOT NULL,
                machine_id TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                payload TEXT NOT NULL,
                mirrored INTEGER NOT NULL DEFAULT 0,
                -- NULL for a record that satisfies the contract. A record
                -- that does not is kept with the reason rather than
                -- dropped: dropping destroyed the evidence at the moment
                -- it was created, which is why the 2026-09-19 vocabulary
                -- drift was invisible for days. Marked records are served
                -- on pull so an audit pass can find them, and clients skip
                -- them instead of applying them.
                invalid_reason TEXT
            );
            CREATE INDEX IF NOT EXISTS hub_records_pull
                ON hub_records(direction, seq);
            CREATE TABLE IF NOT EXISTS hub_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        columns = {row[1] for row in connection.execute("PRAGMA table_info(hub_records)")}
        if "invalid_reason" not in columns:
            connection.execute("ALTER TABLE hub_records ADD COLUMN invalid_reason TEXT")
    finally:
        connection.close()


class HubHTTPHandler(BaseHTTPRequestHandler):
    # Bound by main(): api_key, db_path
    api_key = None
    db_path = None

    def _authorized(self):
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {self.api_key}"
        return hmac.compare_digest(supplied, expected)

    def _send_json(self, status, value):
        body = json.dumps(value, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "Invalid Content-Length"})
            return None
        if length <= 0:
            self._send_json(400, {"error": "Request body required"})
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": "Invalid JSON body"})
            return None

    def _append_records(self, records):
        """Insert each record into the log. Idempotent on record_id — a
        client retry pushes a duplicate and is ignored. The hub is
        relay-only: it holds no working-memory mirror and interprets no
        record semantics.

        A record that fails validation is still reported as rejected, and
        is also kept with its reason. Origins validate before sending, so
        anything reaching this branch is a bug somewhere, and a bug with
        no evidence is the one we spend days not finding.

        A kind the hub does not know is not such a bug: it is a machine
        upgraded ahead of this one, and marking it invalid would strand
        the record forever, since clients step their cursor past marked
        records. The envelope is checked for every record and the payload
        only for known kinds, so the record relays unmarked and each
        client decides whether it can apply it.

        Each rejection carries `kept`, which tells the pushing client the
        record is logged here and re-sending it would achieve nothing. It
        is how a client decides to drain the record instead of blocking
        its queue behind it, and it is sent per record rather than implied
        by the hub's version so the client never has to guess which hub it
        is talking to. An already-logged id counts as kept: the row is
        here either way, which is the whole question the client is
        asking."""
        accepted = duplicates = 0
        rejected = []
        for index, record in enumerate(records):
            error = validate_record(record, allow_unknown_kinds=True)
            inserted = self._insert(record, error)
            # Only a new row: a client re-sends an unacked batch every cycle,
            # and the line was already printed when the record first landed.
            if inserted and not error and record.get("kind") not in RECORD_KINDS:
                print(
                    f"hub: relaying unknown kind {record.get('kind')!r} "
                    f"(record {record.get('record_id')!r})",
                    flush=True,
                )
            if error:
                rejected.append({"index": index, "error": error, "kept": True})
            if not inserted:
                duplicates += 1
            elif not error:
                accepted += 1
        return {
            "accepted": accepted,
            "duplicates": duplicates,
            "rejected": rejected,
        }

    def _insert(self, record, invalid_reason):
        """Append one record, marked with its reason when invalid. Returns
        False if the record_id is already logged. An invalid record may be
        unreadable in ways that defeat the column extraction, so those
        fields fall back to placeholders rather than losing the row —
        keeping it is the entire point."""
        if not isinstance(record, dict):
            record = {"payload": record}
        try:
            payload_json = json.dumps(record.get("payload"), separators=(",", ":"), default=str)
        except (TypeError, ValueError):
            payload_json = json.dumps({"unserializable": repr(record.get("payload"))})
        with sqlite3.connect(self.db_path, timeout=10) as connection:
            try:
                connection.execute(
                    "INSERT INTO hub_records "
                    "(record_id, direction, kind, machine_id, occurred_at, payload, "
                    "invalid_reason) VALUES (?, 'inbound', ?, ?, ?, ?, ?)",
                    (
                        _text(record.get("record_id")) or f"invalid-{uuid.uuid4().hex}",
                        _text(record.get("kind")) or "unknown",
                        _text(record.get("machine_id")) or "unknown",
                        _text(record.get("occurred_at")) or _now(),
                        payload_json,
                        invalid_reason,
                    ),
                )
            except sqlite3.IntegrityError:
                return False
        return True

    def do_POST(self):
        path = urlsplit(self.path).path.rstrip("/") or "/"
        if path != "/records":
            self._send_json(404, {"error": "not found"})
            return
        if not self._authorized():
            self._send_json(401, {"error": "unauthorized"})
            return
        body = self._read_body()
        if body is None:
            return
        records = body.get("records") if isinstance(body, dict) else None
        if not isinstance(records, list):
            self._send_json(400, {"error": "records must be a list"})
            return
        self._send_json(200, self._append_records(records))

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path.rstrip("/") != "/records":
            self._send_json(404, {"error": "not found"})
            return
        if not self._authorized():
            self._send_json(401, {"error": "unauthorized"})
            return
        query = parse_qs(parsed.query)
        try:
            cursor = int(query.get("cursor", ["0"])[0])
            limit = int(query.get("limit", ["100"])[0])
        except ValueError:
            self._send_json(400, {"error": "cursor and limit must be integers"})
            return
        if cursor < 0 or limit < 1:
            self._send_json(400, {"error": "cursor must be non-negative and limit positive"})
            return
        with sqlite3.connect(self.db_path, timeout=10) as connection:
            rows = connection.execute(
                "SELECT seq, record_id, kind, machine_id, occurred_at, payload, invalid_reason "
                "FROM hub_records WHERE direction = 'inbound' AND seq > ? "
                "ORDER BY seq LIMIT ?",
                (cursor, limit + 1),
            ).fetchall()
        has_more = len(rows) > limit
        rows = rows[:limit]
        records = []
        for row in rows:
            # Marked records ride the pull so they are visible to an audit
            # pass rather than only existing on the hub's disk. The key is
            # present only when set: a client applies anything without it.
            record = {
                "seq": row[0],
                "record_id": row[1],
                "kind": row[2],
                "machine_id": row[3],
                "occurred_at": row[4],
                "payload": json.loads(row[5]),
            }
            if row[6]:
                record["invalid_reason"] = row[6]
            records.append(record)
        self._send_json(
            200,
            {
                "records": records,
                "next_cursor": records[-1]["seq"] if records else cursor,
                "has_more": has_more,
            },
        )


def main():
    data_dir = os.environ.get("MEMORY_DATA_DIR", "/var/lib/memory")
    record_db = os.path.join(data_dir, "records.db")
    port = int(os.environ.get("MEMORY_HUB_PORT", "8767"))
    api_key_file = os.environ["MEMORY_API_KEY_FILE"]
    os.makedirs(data_dir, exist_ok=True)
    initialize_hub(record_db)

    with open(api_key_file, encoding="utf-8") as key_file:
        api_key = key_file.read().strip()

    handler = type(
        "BoundHubHTTPHandler",
        (HubHTTPHandler,),
        {"api_key": api_key, "db_path": record_db},
    )
    server = HTTPServer(("127.0.0.1", port), handler)
    print(f"memory-store hub listening on 127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
