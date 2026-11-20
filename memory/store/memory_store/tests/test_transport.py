"""MCP transport: the daemon's tool surface over stateless Streamable HTTP.

The property under test is the one the transport was chosen for — a client
holds no session id, so nothing it cached can go stale when this process
restarts underneath it. Asserted here as its observable consequence: a
tools/call lands cold, with no initialize handshake before it and no
session id on the way back.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../..")

from starlette.testclient import TestClient  # noqa: E402

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.server import daemon  # noqa: E402
from memory_store.server.daemon import build_app  # noqa: E402
from memory_store.store import tool_key_id, tool_rule_id  # noqa: E402
from test_daemon import DaemonFixture  # noqa: E402
from memory_store.tools import ToolError  # noqa: E402

MCP_HEADERS = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream",
}


def tool_call(name: str, arguments: dict, request_id: int = 1) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }


def rpc_result(response) -> dict:
    """Unwrap the JSON-RPC envelope from a Streamable HTTP response, which
    frames its single reply as one SSE event."""
    for line in response.text.splitlines():
        if line.startswith("data: "):
            envelope = json.loads(line[len("data: ") :])
            if "error" in envelope:
                raise AssertionError(f"tool call errored: {envelope['error']}")
            return envelope["result"]
    raise AssertionError(f"no JSON-RPC payload in response: {response.text!r}")


def tool_payload(response) -> dict:
    """The tool's own return value, which rides as JSON text content."""
    return json.loads(rpc_result(response)["content"][0]["text"])


class StatelessTransportTests(unittest.TestCase):
    def setUp(self):
        self.fixture = DaemonFixture()
        self.client = TestClient(build_app(self.fixture.state))
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.addCleanup(self.fixture.store.close)

    def test_session_open_answers_with_the_standing_doc(self):
        fixture = self.fixture
        fixture.store.upsert_kb(
            {
                "id": "kb:example:1:a",
                "project": "example",
                "doc": "The deploy gate is on.",
                "inputs": [],
                "build_seq": 1,
                "created_at": "2026-11-05T00:00:00Z",
            }
        )
        with mock.patch.object(
            fixture.store, "embed", side_effect=lambda texts, origin=None: [[1.0] for _ in texts]
        ):
            response = self.client.post(
                "/session-open",
                json={"prompt": "how does the deploy gate work?", "workspace": "example"},
            )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["project"], "example")
        self.assertEqual(body["doc"], "The deploy gate is on.")

    def test_session_open_answers_a_repo_without_a_doc_in_silence(self):
        response = self.client.post(
            "/session-open",
            json={"prompt": "anything", "workspace": "nowhere"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["doc"])

    def test_session_open_refuses_when_the_scorer_gate_is_held(self):
        gate = self.fixture.state.nudge_gate
        self.assertTrue(gate.acquire(blocking=False))
        try:
            response = self.client.post(
                "/session-open",
                json={"prompt": "anything", "workspace": "example"},
            )
        finally:
            gate.release()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["Retry-After"], "2")

    def test_tool_call_lands_without_a_handshake(self):
        response = self.client.post(
            "/mcp?app=test",
            headers=MCP_HEADERS,
            json=tool_call("memory_remember", {"content": "cold call", "source": "fact"}),
        )
        self.assertEqual(response.status_code, 200)
        written = tool_payload(response)
        row = self.fixture.store.conn.execute(
            "SELECT content FROM agent_memory WHERE id = ?", (written["id"],)
        ).fetchone()
        self.assertEqual(row["content"], "cold call")

    def test_the_connection_names_the_client(self):
        response = self.client.post(
            "/mcp?app=cursor",
            headers=MCP_HEADERS,
            json=tool_call("memory_remember", {"content": "stamped write", "source": "fact"}),
        )
        written = tool_payload(response)
        row = self.fixture.store.conn.execute(
            "SELECT app FROM agent_memory WHERE id = ?", (written["id"],)
        ).fetchone()
        self.assertEqual(row["app"], "cursor")

    def test_the_payload_cannot_claim_a_client(self):
        # Provenance comes off the connection, so a client naming itself in
        # the arguments is overruled rather than believed.
        response = self.client.post(
            "/mcp?app=cursor",
            headers=MCP_HEADERS,
            json=tool_call(
                "memory_remember",
                {"content": "impersonation attempt", "source": "fact", "app": "opencode"},
            ),
        )
        written = tool_payload(response)
        row = self.fixture.store.conn.execute(
            "SELECT app FROM agent_memory WHERE id = ?", (written["id"],)
        ).fetchone()
        self.assertEqual(row["app"], "cursor")

    def test_an_unnamed_connection_is_refused(self):
        # Storing a row under a guessed client is worse than not storing it:
        # nothing downstream can tell an assumed name from a real one.
        response = self.client.post(
            "/mcp",
            headers=MCP_HEADERS,
            json=tool_call("memory_remember", {"content": "anonymous write", "source": "fact"}),
        )
        with self.assertRaises(AssertionError) as caught:
            tool_payload(response)
        self.assertIn("declares no client", str(caught.exception))
        self.assertEqual(
            self.fixture.store.conn.execute("SELECT count(*) AS n FROM working_memory").fetchone()[
                "n"
            ],
            0,
        )

    def test_no_session_id_is_issued(self):
        response = self.client.post(
            "/mcp?app=test",
            headers=MCP_HEADERS,
            json=tool_call("memory_recall", {"query": "anything"}),
        )
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("mcp-session-id", response.headers)

    def test_each_request_stands_alone(self):
        # The reload property: a second request succeeds knowing nothing of
        # the first, so a client that cached its connection is served by
        # whatever process is listening when it next posts.
        for index in range(2):
            response = self.client.post(
                "/mcp?app=test",
                headers=MCP_HEADERS,
                json=tool_call(
                    "memory_remember",
                    {"content": f"independent {index}", "source": "fact"},
                    request_id=index + 1,
                ),
                # No cookies, no session header, nothing carried over.
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(tool_payload(response)["id"])

    def test_tools_are_listed_over_the_same_endpoint(self):
        response = self.client.post(
            "/mcp?app=test",
            headers=MCP_HEADERS,
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
        )
        self.assertEqual(response.status_code, 200)
        names = {tool["name"] for tool in rpc_result(response)["tools"]}
        self.assertIn("memory_recall", names)
        self.assertIn("memory_find_conversations", names)
        self.assertIn("memory_list", names)
        self.assertIn("persona_codify", names)

    def test_the_endpoint_answers_without_a_redirect(self):
        # A mounted app would 307 this to /mcp/, and the client posting here
        # is under no obligation to follow that.
        response = self.client.post(
            "/mcp?app=test",
            headers=MCP_HEADERS,
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            follow_redirects=False,
        )
        self.assertEqual(response.status_code, 200)

    def test_the_session_bound_sse_route_is_gone(self):
        self.assertEqual(self.client.get("/sse").status_code, 404)
        self.assertEqual(self.client.post("/messages/", json={}).status_code, 404)


class ToolMomentRouteTests(unittest.TestCase):
    """The /tool-moment HTTP surface: validation errors, the held flag's
    wire shape, and silence over the wire."""

    def setUp(self):
        self.fixture = DaemonFixture()
        self.client = TestClient(build_app(self.fixture.state))
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)
        self.addCleanup(self.fixture.store.close)

    def _bind(self, note="Run make test before pushing."):
        tool = {
            "id": tool_key_id("command", ["git", "push"]),
            "kind": "command",
            "key": ["git", "push"],
            "created_by": "testbox",
            "created_at": "2026-11-05T00:00:00Z",
        }
        rule = {
            "id": tool_rule_id(
                {"tool_id": tool["id"], "note": note, "scope": "global", "project": ""}
            ),
            "tool_id": tool["id"],
            "note": note,
            "scope": "global",
            "project": "",
            "created_by": "testbox",
            "created_at": "2026-11-05T00:00:00Z",
        }
        self.fixture.store.bind_tool(tool, rule)

    def test_moment_delivers_over_the_wire(self):
        self._bind()
        with mock.patch.object(daemon, "TOOL_HOLDS", False):
            response = self.client.post(
                "/tool-moment",
                json={
                    "app": "opencode",
                    "conversation_id": "c1",
                    "cwd": "/tmp/anything",
                    "event": {"kind": "command", "command": "sudo git push"},
                },
            )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["held"])
        self.assertEqual(len(body["deliveries"]), 1)
        self.assertEqual(body["deliveries"][0]["note"], "Run make test before pushing.")

    def test_moment_is_silent_for_an_unbound_command(self):
        response = self.client.post(
            "/tool-moment",
            json={
                "app": "opencode",
                "conversation_id": "c1",
                "cwd": "/tmp/anything",
                "event": {"kind": "command", "command": "ls"},
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["deliveries"], [])

    def test_moment_rejects_an_event_without_a_kind(self):
        response = self.client.post(
            "/tool-moment",
            json={"app": "opencode", "conversation_id": "c1", "event": {"command": "ls"}},
        )
        self.assertEqual(response.status_code, 400)

    def test_add_rides_the_mcp_surface_with_schema_and_validation(self):
        # The tool list endpoint is MCP-framed; exercise the validation
        # path through call_tool, which is what backs it.
        ok = self.fixture.state.call_tool(
            "tool_rule_add",
            {
                "kind": "command",
                "key": "docker compose down",
                "note": "Check the volumes list before tearing down.",
                "cwd": "/tmp/example",
                "conversation_id": "c9",
            },
            app="opencode",
        )
        self.assertEqual(ok["status"], "ok")
        self.assertEqual(ok["key"], ["docker", "compose", "down"])
        self.assertEqual(ok["scope"], "project")
        bindings = self.fixture.store.tool_bindings()
        self.assertEqual(len(bindings), 1)
        self.assertEqual(bindings[0]["note"], "Check the volumes list before tearing down.")
        # The project resolved from cwd, not from a client claim.
        self.assertEqual(bindings[0]["project"], "example")
        # The enrolling session rides for the provenance walk.
        self.assertEqual(bindings[0]["conversation_id"], "c9")
        with self.assertRaises(ToolError):
            self.fixture.state.call_tool(
                "tool_rule_add",
                {"kind": "command", "key": "git push", "note": "x", "scope": "bogus"},
                app="opencode",
            )


if __name__ == "__main__":
    unittest.main()
