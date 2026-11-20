"""Cursor client tests: what gets captured, what gets delivered and when, and
what the hook does when the daemon is unreachable.

The hook runs as a fresh process per event with no state but the queue
directory, so every test points MEMORY_QUEUE_DIR at a temp dir and reloads
the module to pick it up.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below

# The hook is loaded by file path: the cursor client's home is the memory
# product's cursor-client/ (not a python package of the app), so there is no
# importable module name to reload. Fresh execution per load is what
# importlib.reload gave — every load re-reads the module constants from the
# patched environment.
CURSOR_HOOK_PATH = Path(__file__).resolve().parents[3] / "cursor-client" / "hook.py"


def load_hook():
    spec = importlib.util.spec_from_file_location("cursor_hook_under_test", CURSOR_HOOK_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["cursor_hook_under_test"] = module
    spec.loader.exec_module(module)
    return module


class FakeDaemon:
    """The routes the hook calls, each returning a canned body and recording
    what it was sent."""

    def __init__(self, status=200):
        self.requests = []  # (path, body), every route
        self.compliance_response = {"status": "ok", "reminder": "", "section": ""}
        self.session_open_response = {"doc": None}
        self.moment_response = {"held": False, "error": None, "deliveries": []}
        self.status = status
        daemon = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                request = json.loads(self.rfile.read(length) or b"{}")
                daemon.requests.append((self.path, request))
                body = json.dumps(daemon.reply(self.path)).encode()
                self.send_response(daemon.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def reply(self, path):
        if path.endswith("/compliance"):
            return dict(self.compliance_response)
        if path.endswith("/session-open"):
            return dict(self.session_open_response)
        if path.endswith("/tool-moment"):
            return dict(self.moment_response)
        return {}

    def sent(self, route):
        return [body for path, body in self.requests if path.endswith(route)]

    @property
    def paths(self):
        return [path for path, _ in self.requests]

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


KB_REPLY = {
    "doc": "## Standing doc\n\nthe drain classifies captures before consolidation",
    "project": "some-repo",
    "doc_created_at": "2026-11-08T12:00:00Z",
    "inputs_count": 42,
    "facts_pending": 2,
}

DELIVERY = {
    "rule_id": 3,
    "tool_id": 1,
    "key": ["gcloud"],
    "scope": "project",
    "project": "some-repo",
    "note": "re-auth with `gcloud auth login` first",
    "held": False,
    "created_at": "2026-11-01T09:00:00Z",
    "section": "## Tool note",
}


class _HookCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.daemon = FakeDaemon()
        self._env = mock.patch.dict(
            os.environ,
            {
                "MEMORY_QUEUE_DIR": str(self.tmp / "queue"),
                "MEMORY_DAEMON_URL": self.daemon.url,
            },
        )
        self._env.start()
        self.hook = load_hook()

    def tearDown(self):
        self._env.stop()
        self.daemon.stop()

    def run_hook(self, payload):
        """Drive main() the way Cursor does: JSON on stdin, JSON on stdout."""
        out = io.StringIO()
        with (
            mock.patch("sys.stdin", io.StringIO(json.dumps(payload))),
            mock.patch("sys.stdout", out),
        ):
            self.hook.main()
        return json.loads(out.getvalue() or "{}")

    def declines(self, payload):
        """The hook has no opinion: it exits 1 and writes nothing, which
        Cursor's permission hooks treat as the call's normal path."""
        out = io.StringIO()
        with (
            mock.patch("sys.stdin", io.StringIO(json.dumps(payload))),
            mock.patch("sys.stdout", out),
            self.assertRaises(SystemExit) as refused,
        ):
            self.hook.main()
        self.assertEqual(refused.exception.code, 1)
        self.assertEqual(out.getvalue(), "")

    def queued(self):
        path = Path(self.hook.QUEUE_FILE)
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


class CaptureTests(_HookCase):
    def test_user_prompt_is_queued_with_cursor_provenance(self):
        self.run_hook(
            {
                "hook_event_name": "beforeSubmitPrompt",
                "prompt": "why does the drain re-run the same batch?",
                "workspace_roots": ["/tmp/some-repo"],
                "conversation_id": "conv-abcdef123456",
            }
        )
        (record,) = self.queued()
        self.assertEqual(record["role"], "user")
        self.assertEqual(record["app"], "cursor")
        self.assertEqual(record["cwd"], "/tmp/some-repo")
        self.assertEqual(record["conversation_id"], "conv-abcdef123456")

    def test_trivial_prompts_are_not_queued(self):
        for prompt in ("yes", "ok", "/compact", ""):
            self.run_hook({"hook_event_name": "beforeSubmitPrompt", "prompt": prompt})
        self.assertEqual(self.queued(), [])

    def test_assistant_turn_is_queued_when_substantial(self):
        self.run_hook({"hook_event_name": "afterAgentResponse", "text": "x" * 150})
        (record,) = self.queued()
        self.assertEqual(record["role"], "assistant")

    def test_short_and_preamble_assistant_turns_are_dropped(self):
        self.run_hook({"hook_event_name": "afterAgentResponse", "text": "Done."})
        self.run_hook(
            {"hook_event_name": "afterAgentResponse", "text": "I'll run the tests now. " + "y" * 90}
        )
        self.assertEqual(self.queued(), [])

    def test_unknown_event_passes_through(self):
        self.assertEqual(self.run_hook({"hook_event_name": "somethingElse"}), {"continue": True})

    def test_malformed_stdin_does_not_block_the_turn(self):
        out = io.StringIO()
        with mock.patch("sys.stdin", io.StringIO("not json")), mock.patch("sys.stdout", out):
            self.hook.main()
        self.assertEqual(json.loads(out.getvalue()), {"continue": True})


class CompactionTests(_HookCase):
    def test_compaction_queues_a_marker(self):
        self.run_hook(
            {"hook_event_name": "preCompact", "conversation_id": "conv1", "trigger": "auto"}
        )
        (marker,) = self.queued()
        self.assertEqual(marker["kind"], "compaction")
        self.assertEqual(marker["conversation_id"], "conv1")
        self.assertEqual(marker["trigger"], "auto")


class SessionStartTests(_HookCase):
    """The session-start delivery on a conversation's first prompt: the
    standing doc inline, and the facts matched to the opening request left
    with the daemon for a knowledge_read fetch, so the block stays inside the
    characters Cursor inlines."""

    def _prompt(self, text="how does the drain classify captures?", conversation_id="conv1"):
        return self.run_hook(
            {
                "hook_event_name": "beforeSubmitPrompt",
                "prompt": text,
                "conversation_id": conversation_id,
                "workspace_roots": ["/tmp/some-repo"],
            }
        )

    def test_the_first_prompt_asks_for_the_session_open(self):
        self._prompt()
        (request,) = self.daemon.sent("/session-open")
        self.assertEqual(
            request,
            {
                "prompt": "how does the drain classify captures?",
                "cwd": "/tmp/some-repo",
                "conversation_id": "conv1",
                "app": "cursor",
                "defer_facts": True,
            },
        )

    def test_the_block_carries_the_doc_and_the_fetch_instruction(self):
        self.daemon.session_open_response = KB_REPLY
        context = self._prompt()["additional_context"]
        self.assertIn(
            "Project knowledge: some-repo — composed 2026-11-08T12:00:00Z, "
            "folded from 42 recorded row(s).",
            context,
        )
        self.assertIn(KB_REPLY["doc"], context)
        self.assertIn(
            "2 stored fact(s) match this request. Before anything else, call "
            "knowledge_read with no arguments",
            context,
        )
        self.assertTrue(context.endswith(self.hook.SESSION_CLOSING))

    def test_the_closing_matches_the_opencode_plugin(self):
        plugin = (Path(__file__).resolve().parents[3] / "opencode-client" / "memory.ts").read_text()
        self.assertIn(self.hook.SESSION_CLOSING, plugin)

    def test_no_facts_means_no_fetch_instruction(self):
        self.daemon.session_open_response = dict(KB_REPLY, facts_pending=0)
        context = self._prompt()["additional_context"]
        self.assertIn(KB_REPLY["doc"], context)
        self.assertNotIn("stored fact(s)", context)

    def test_a_doc_at_its_cap_fits_cursors_inline_limit(self):
        # Cursor 3.29.9 inlines up to 10,000 characters summed over every
        # hook on beforeSubmitPrompt; the KB doc is capped at 6,000.
        reminder = "## Memory nudge\n\n" + "r" * 300
        self.daemon.compliance_response = {"status": "ok", "section": reminder}
        self.daemon.session_open_response = dict(
            KB_REPLY, project="p" * 100, doc="x" * 6000, facts_pending=5
        )
        context = self._prompt()["additional_context"]
        self.assertIn("x" * 6000, context)
        self.assertLess(len(context), 7500)

    def test_it_is_delivered_once_per_conversation(self):
        self.daemon.session_open_response = KB_REPLY
        self.assertIn("additional_context", self._prompt())
        self.assertNotIn("additional_context", self._prompt("and the length penalty?"))
        self.assertEqual(len(self.daemon.sent("/session-open")), 1)
        self.assertIn("additional_context", self._prompt(conversation_id="conv2"))

    def test_a_project_with_no_knowledge_base_is_settled_too(self):
        self.assertNotIn("additional_context", self._prompt())
        self._prompt("and the length penalty?")
        self.assertEqual(len(self.daemon.sent("/session-open")), 1)

    def test_a_trivial_opening_still_gets_the_block(self):
        self.daemon.session_open_response = KB_REPLY
        self.assertIn(KB_REPLY["doc"], self._prompt("continue")["additional_context"])

    def test_a_failed_fetch_backs_off_rather_than_retrying_every_prompt(self):
        self.daemon.status = 503
        self.assertEqual(self._prompt(), {"continue": True})
        self._prompt("and the length penalty?")
        self.assertEqual(len(self.daemon.sent("/session-open")), 1)
        self.daemon.status = 200
        self.daemon.session_open_response = KB_REPLY
        with mock.patch.object(
            self.hook.time,
            "time",
            return_value=self.hook.time.time() + self.hook.SESSION_OPEN_BACKOFF_SECS + 1,
        ):
            self.assertIn("knowledge_read", self._prompt("third try")["additional_context"])

    def test_an_unreachable_daemon_costs_context_not_the_turn(self):
        self.daemon.stop()
        self.assertEqual(self._prompt(), {"continue": True})
        self.assertEqual(len(self.queued()), 1)


class NoPerMessageDeliveryTests(_HookCase):
    """ADR 20261104-retire-per-message-delivery: no stored content rides a
    prompt, so a prompt after the first carries nothing unless the
    compliance ladder speaks."""

    def test_later_prompts_inject_nothing_and_ask_for_nothing(self):
        self.daemon.session_open_response = KB_REPLY
        for text in ("first real question here", "second real question", "third one"):
            self.run_hook(
                {"hook_event_name": "beforeSubmitPrompt", "prompt": text, "conversation_id": "c"}
            )
        later = self.run_hook(
            {"hook_event_name": "beforeSubmitPrompt", "prompt": "fourth", "conversation_id": "c"}
        )
        self.assertEqual(later, {"continue": True})
        self.assertEqual({path for path in self.daemon.paths}, {"/compliance", "/session-open"})


class DebugSinkTests(_HookCase):
    """Where a debug line goes, and what it says about the payload.

    Cursor owns this process's stderr and writes it nowhere a reader can
    reach, so a line that goes only there is readable by running the hook by
    hand against a payload someone already has — which is the thing that was
    missing when a window turned out to resolve no directory.
    """

    def _event(self, payload):
        log = Path(self.hook.DEBUG_LOG)
        if log.exists():
            log.unlink()  # one invocation per read, or assertIn matches an older line
        with mock.patch.object(self.hook, "DEBUGGING", True):
            with contextlib.redirect_stderr(io.StringIO()):
                self.run_hook(payload)
        return log.read_text()

    BASE = {"hook_event_name": "beforeSubmitPrompt", "prompt": "p", "conversation_id": "c1"}

    def test_the_three_root_shapes_read_apart(self):
        # Absent, present-and-empty, and present-with-a-path are three
        # different facts about the window, and only the last is the hook's
        # to use. Collapsed to a bare string they are the same line.
        self.assertIn("roots=null", self._event(dict(self.BASE)))
        self.assertIn("roots=[]", self._event(dict(self.BASE, workspace_roots=[])))
        self.assertIn(
            'roots=["/tmp/some-repo"]',
            self._event(dict(self.BASE, workspace_roots=["/tmp/some-repo"])),
        )

    def test_the_fields_cursor_sent_are_named(self):
        self.assertIn("keys=conversation_id,hook_event_name,prompt", self._event(dict(self.BASE)))

    def test_the_session_open_is_observable(self):
        self.assertIn("op=session.open conversation=c1 doc=0", self._event(dict(self.BASE)))

    def test_nothing_is_written_below_debug(self):
        with mock.patch.object(self.hook, "DEBUGGING", False):
            with contextlib.redirect_stderr(io.StringIO()) as quiet:
                self.run_hook(dict(self.BASE))
        self.assertFalse(Path(self.hook.DEBUG_LOG).exists())
        self.assertEqual(quiet.getvalue(), "")


class ToolProvenanceTests(_HookCase):
    """What preToolUse adds to a memory tool's arguments.

    The daemon never fabricates a repo or a session, so a write arriving
    without them is stored unattributed. The OpenCode plugin adds both to
    the memory calls from its own hook; Cursor's MCP arguments have no such
    channel, so the hook rewrites them on the way past.
    """

    def _tool(self, name, arguments, roots=("/tmp/some-repo",), conversation_id=None):
        payload = {
            "hook_event_name": "preToolUse",
            "tool_name": name,
            "tool_input": arguments,
            "workspace_roots": list(roots),
        }
        if conversation_id:
            payload["conversation_id"] = conversation_id
        return self.run_hook(payload)

    def test_a_memory_write_is_told_where_and_when_it_happened(self):
        self.assertEqual(
            self._tool("MCP:memory_remember", {"content": "a fact"}, conversation_id="conv1"),
            {
                "permission": "allow",
                "updated_input": {
                    "content": "a fact",
                    "cwd": "/tmp/some-repo",
                    "conversation_id": "conv1",
                },
            },
        )

    def test_each_tool_gets_the_stamps_it_takes(self):
        # Measured rather than documented: an MCP tool arrives as
        # `MCP:<bare name>`, carrying Cursor's own prefix and not the server
        # key this deployment registered.
        for tool in self.hook.CWD_TOOLS | self.hook.CONVERSATION_TOOLS:
            with self.subTest(tool=tool):
                stamped = self._tool("MCP:" + tool, {}, conversation_id="conv1")["updated_input"]
                self.assertEqual("cwd" in stamped, tool in self.hook.CWD_TOOLS)
                self.assertEqual("conversation_id" in stamped, tool in self.hook.CONVERSATION_TOOLS)

    def test_the_tool_rule_verbs_are_stamped(self):
        stamped = self._tool("MCP:tool_rule_add", {}, conversation_id="conv1")
        self.assertEqual(
            stamped["updated_input"], {"cwd": "/tmp/some-repo", "conversation_id": "conv1"}
        )

    def test_a_value_the_model_supplied_is_replaced(self):
        # Where the window is and which conversation it holds are the two
        # things the model cannot observe, so its guess does not get to
        # outrank the client's.
        self.assertEqual(
            self._tool(
                "MCP:memory_remember",
                {"content": "a fact", "cwd": "/tmp/somewhere-else", "conversation_id": "x"},
                conversation_id="conv1",
            )["updated_input"],
            {"content": "a fact", "cwd": "/tmp/some-repo", "conversation_id": "conv1"},
        )

    def test_a_window_with_no_root_adds_nothing(self):
        # A saved multi-root workspace reports no roots at all, so there is
        # nothing to attribute the write to and a fabricated directory would
        # tag it with the wrong repo.
        self.assertEqual(
            self._tool("MCP:memory_remember", {"content": "a fact"}, roots=()),
            {"permission": "allow"},
        )

    def test_arguments_in_an_unexpected_shape_pass_through_untouched(self):
        self.assertEqual(
            self._tool("MCP:memory_recall", '{"query": "a question"}'),
            {"permission": "allow"},
        )

    def test_a_tool_call_is_not_a_captured_turn(self):
        self._tool("MCP:memory_remember", {"content": "a fact"}, conversation_id="conv1")
        self.assertEqual(self.queued(), [])

    def test_a_tool_outside_the_set_is_neither_approved_nor_blocked(self):
        """Both obvious answers are wrong here. preToolUse is a permission
        hook, so a response Cursor cannot validate blocks the call, and a
        bare allow would approve a tool this hook has no opinion about —
        past whatever gating the user has in front of it. Failing is the
        documented outcome that does neither, which is what makes a matcher
        registered wider than intended cost a process and not a decision."""
        for name in ("Shell", "MCP:memory_get"):
            with self.subTest(tool=name):
                self.declines(
                    {
                        "hook_event_name": "preToolUse",
                        "tool_name": name,
                        "tool_input": {"command": "rm -rf /"},
                    }
                )


class ShellMomentTests(_HookCase):
    """Tool moments for a shell command.

    Denying is the only channel out of beforeShellExecution: `agent_message`
    is accepted, validated and then never delivered, while `user_message` on
    a deny arrives as the tool's own result. So a held rule refuses the
    command, and an informational one waits for postToolUse, whose
    additional_context reaches the model beside the result.
    """

    def _shell(self, command, conversation="conv1", tool_use_id="tu-1"):
        payload = {
            "hook_event_name": "beforeShellExecution",
            "command": command,
            "conversation_id": conversation,
            "workspace_roots": ["/tmp/some-repo"],
        }
        if tool_use_id:
            payload["tool_use_id"] = tool_use_id
        return payload

    def _after(self, command, conversation="conv1", tool_use_id="tu-1"):
        payload = {
            "hook_event_name": "postToolUse",
            "tool_name": "Shell",
            "tool_input": {"command": command},
            "conversation_id": conversation,
        }
        if tool_use_id:
            payload["tool_use_id"] = tool_use_id
        return self.run_hook(payload)

    def test_the_command_is_reported_as_a_moment(self):
        self.declines(self._shell("cd example && gcloud auth login"))
        (request,) = self.daemon.sent("/tool-moment")
        self.assertEqual(
            request,
            {
                "app": "cursor",
                "conversation_id": "conv1",
                "cwd": "/tmp/some-repo",
                "event": {"kind": "command", "command": "cd example && gcloud auth login"},
            },
        )

    def test_a_held_call_is_refused_with_the_daemons_text(self):
        self.daemon.moment_response = {
            "held": True,
            "error": "held: re-auth first, then run the command again",
            "deliveries": [dict(DELIVERY, held=True)],
        }
        self.assertEqual(
            self.run_hook(self._shell("gcloud auth login")),
            {
                "permission": "deny",
                "user_message": "held: re-auth first, then run the command again",
            },
        )

    def test_an_informational_note_arrives_beside_the_result(self):
        self.daemon.moment_response = {"held": False, "error": None, "deliveries": [DELIVERY]}
        self.declines(self._shell("gcloud auth login"))
        context = self._after("gcloud auth login")["additional_context"]
        self.assertTrue(context.startswith("## Tool note"))
        self.assertIn("re-auth with `gcloud auth login` first (rule 3)", context)
        self.assertIn("[2026-11-01T09:00:00Z] (project: some-repo)", context)

    def test_a_note_is_delivered_once(self):
        self.daemon.moment_response = {"held": False, "error": None, "deliveries": [DELIVERY]}
        self.declines(self._shell("gcloud auth login"))
        self.assertIn("additional_context", self._after("gcloud auth login"))
        self.assertEqual(self._after("gcloud auth login"), {})

    def test_a_note_pairs_with_its_own_call(self):
        self.daemon.moment_response = {"held": False, "error": None, "deliveries": [DELIVERY]}
        self.declines(self._shell("gcloud auth login", tool_use_id="tu-1"))
        self.assertEqual(self._after("ls", tool_use_id="tu-2"), {})
        self.assertIn("additional_context", self._after("gcloud auth login", tool_use_id="tu-1"))

    def test_a_call_without_an_id_pairs_on_the_command(self):
        # beforeShellExecution occasionally arrives without a tool_use_id
        # while postToolUse carries one; the command is the fallback key.
        self.daemon.moment_response = {"held": False, "error": None, "deliveries": [DELIVERY]}
        self.declines(self._shell("gcloud auth login", tool_use_id=None))
        self.assertIn("additional_context", self._after("gcloud auth login", tool_use_id="tu-9"))

    def test_each_conversation_keeps_its_own_notes(self):
        self.daemon.moment_response = {"held": False, "error": None, "deliveries": [DELIVERY]}
        self.declines(self._shell("gcloud auth login", conversation="conv-one"))
        self.assertEqual(self._after("gcloud auth login", conversation="conv-two"), {})

    def test_a_command_no_rule_speaks_for_runs(self):
        self.declines(self._shell("ls -la"))
        self.assertEqual(self._after("ls -la"), {})

    def test_an_unreachable_daemon_lets_the_command_through(self):
        self.daemon.stop()
        self.declines(self._shell("gcloud auth login"))

    def test_a_busy_daemon_lets_the_command_through(self):
        self.daemon.status = 503
        self.declines(self._shell("gcloud auth login"))

    def test_a_held_command_is_not_a_captured_turn(self):
        self.daemon.moment_response = {"held": True, "error": "held", "deliveries": [DELIVERY]}
        self.run_hook(self._shell("gcloud auth login"))
        self.assertEqual(self.queued(), [])


class McpMomentTests(_HookCase):
    """Tool moments for an MCP call, reported under the name Cursor sends:
    the daemon resolves `MCP:` through its cursor prefix alias."""

    def _call(self, name="MCP:deploy_service", arguments=None):
        return {
            "hook_event_name": "preToolUse",
            "tool_name": name,
            "tool_input": arguments if arguments is not None else {"service": "api"},
            "tool_use_id": "tu-1",
            "conversation_id": "conv1",
            "workspace_roots": ["/tmp/some-repo"],
        }

    def test_the_call_is_reported_with_its_decorated_name(self):
        self.declines(self._call())
        (request,) = self.daemon.sent("/tool-moment")
        self.assertEqual(request["event"], {"kind": "mcp", "tool": "MCP:deploy_service"})
        self.assertEqual(request["cwd"], "/tmp/some-repo")

    def test_a_held_call_is_refused_on_both_channels(self):
        self.daemon.moment_response = {"held": True, "error": "held: not yet", "deliveries": []}
        self.assertEqual(
            self.run_hook(self._call()),
            {
                "permission": "deny",
                "user_message": "held: not yet",
                "agent_message": "held: not yet",
            },
        )

    def test_an_informational_note_arrives_beside_the_result(self):
        self.daemon.moment_response = {"held": False, "error": None, "deliveries": [DELIVERY]}
        self.declines(self._call())
        after = self.run_hook(
            {
                "hook_event_name": "postToolUse",
                "tool_name": "MCP:deploy_service",
                "tool_input": {"service": "api"},
                "tool_use_id": "tu-1",
                "conversation_id": "conv1",
            }
        )
        self.assertIn("re-auth with", after["additional_context"])

    def test_a_memory_tool_still_gets_its_stamps(self):
        self.daemon.moment_response = {"held": False, "error": None, "deliveries": [DELIVERY]}
        result = self.run_hook(self._call("MCP:memory_remember", {"content": "a fact"}))
        self.assertEqual(result["permission"], "allow")
        self.assertEqual(result["updated_input"]["conversation_id"], "conv1")


class StateLockTests(_HookCase):
    """Parallel tool calls run their hooks at once, each in its own process,
    and each parks its moment by loading, changing and saving one file."""

    def test_concurrent_parks_all_land(self):
        import time

        path = self.hook._state_path("conv1")

        def park(key):
            with self.hook._locked_state(path) as state:
                # Widen the window between load and save that an unlocked
                # write would lose another park in.
                time.sleep(0.02)
                state["moments"][key] = f"note for {key}"

        threads = [threading.Thread(target=park, args=(f"k{i}",)) for i in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        with self.hook._locked_state(path) as state:
            self.assertEqual(sorted(state["moments"]), [f"k{i}" for i in range(8)])

    def test_an_unchanged_state_is_not_rewritten(self):
        path = self.hook._state_path("conv1")
        with self.hook._locked_state(path) as state:
            state["facts_pending"] = 1
        before = os.stat(path).st_mtime_ns
        with self.hook._locked_state(path):
            pass
        self.assertEqual(os.stat(path).st_mtime_ns, before)


class DeferredFactsGateTests(_HookCase):
    """The first-tool hold while the session-start facts sit unfetched.

    Built-in tools ask the daemon only while this conversation's facts are
    pending, so a settled conversation costs a process and nothing more.
    Cursor delivers user_message on a built-in tool's deny, so that is
    where the refusal text goes."""

    HELD = "Held by the memory store: call knowledge_read first."

    def _open(self, pending=2, conversation_id="conv1"):
        self.daemon.session_open_response = dict(KB_REPLY, facts_pending=pending)
        self.run_hook(
            {
                "hook_event_name": "beforeSubmitPrompt",
                "prompt": "how does the drain classify captures?",
                "conversation_id": conversation_id,
                "workspace_roots": ["/tmp/some-repo"],
            }
        )

    def _tool(self, name, arguments=None, conversation_id="conv1"):
        return {
            "hook_event_name": "preToolUse",
            "tool_name": name,
            "tool_input": arguments if arguments is not None else {},
            "tool_use_id": "tu-1",
            "conversation_id": conversation_id,
            "workspace_roots": ["/tmp/some-repo"],
        }

    def test_the_first_built_in_tool_is_asked_about_and_refused(self):
        self._open()
        self.daemon.moment_response = {
            "held": True,
            "error": self.HELD,
            "deliveries": [],
            "facts_gate": "held",
        }
        self.assertEqual(
            self.run_hook(self._tool("Read", {"path": "/tmp/x"})),
            {"permission": "deny", "user_message": self.HELD, "agent_message": self.HELD},
        )
        (request,) = self.daemon.sent("/tool-moment")
        self.assertEqual(request["event"], {"kind": "tool", "tool": "Read"})

    def test_after_the_first_built_in_tool_nothing_is_asked(self):
        self._open()
        self.daemon.moment_response = {"held": False, "deliveries": [], "facts_gate": "clear"}
        self.declines(self._tool("Read"))
        self.declines(self._tool("Grep"))
        self.assertEqual(len(self.daemon.sent("/tool-moment")), 1)

    def test_no_pending_facts_means_built_in_tools_never_ask(self):
        self._open(pending=0)
        self.declines(self._tool("Read"))
        self.declines(self._tool("Shell", {"command": "ls"}))
        self.assertEqual(self.daemon.sent("/tool-moment"), [])

    def test_the_fetch_settles_it_locally(self):
        self._open()
        stamped = self.run_hook(self._tool("MCP:knowledge_read"))
        self.assertEqual(stamped["updated_input"], {"conversation_id": "conv1"})
        self.declines(self._tool("Read"))
        self.assertEqual(
            [body["event"]["kind"] for body in self.daemon.sent("/tool-moment")], ["mcp"]
        )

    def test_an_mcp_hold_for_the_facts_settles_it(self):
        self._open()
        self.daemon.moment_response = {
            "held": True,
            "error": self.HELD,
            "deliveries": [],
            "facts_gate": "held",
        }
        self.assertEqual(self.run_hook(self._tool("MCP:deploy"))["permission"], "deny")
        self.declines(self._tool("Read"))
        self.assertEqual(len(self.daemon.sent("/tool-moment")), 1)

    def test_a_binding_hold_on_an_mcp_tool_leaves_the_facts_pending(self):
        self._open()
        self.daemon.moment_response = {"held": True, "error": "held: not yet", "deliveries": []}
        self.run_hook(self._tool("MCP:deploy"))
        self.daemon.moment_response = {"held": False, "deliveries": [], "facts_gate": "clear"}
        self.declines(self._tool("Read"))
        self.assertEqual(len(self.daemon.sent("/tool-moment")), 2)

    def test_a_failing_daemon_costs_one_try_per_conversation(self):
        self._open()
        self.daemon.status = 503
        self.declines(self._tool("Read"))
        self.declines(self._tool("Grep"))
        self.assertEqual(len(self.daemon.sent("/tool-moment")), 1)


class SystemInterpreterTests(unittest.TestCase):
    """The hook has to run under the interpreter Cursor hands it.

    Cursor invokes hooks with /usr/bin/python3, which on macOS is 3.9,
    while this suite runs under 3.12. Nothing else here would notice the
    hook using a newer stdlib name: `from datetime import UTC` passed every
    test and broke the hook outright on every real prompt.
    """

    def test_the_hook_runs_under_the_system_interpreter(self):
        interpreter = "/usr/bin/python3"
        if not os.path.exists(interpreter):
            self.skipTest(f"{interpreter} is absent")
        tmp = Path(tempfile.mkdtemp())
        config = tmp / "client.json"
        config.write_text(
            json.dumps({"daemon_url": "http://127.0.0.1:1", "queue_dir": str(tmp / "q")})
        )
        hook = Path(__file__).resolve().parents[3] / "cursor-client" / "hook.py"
        # A daemon URL pointing at nothing: the hook must still answer, and
        # any traceback here is a break in the hook rather than the daemon.
        result = subprocess.run(
            [interpreter, str(hook)],
            input=json.dumps(
                {
                    "hook_event_name": "beforeSubmitPrompt",
                    "prompt": "a prompt long enough to be worth recalling against",
                    "conversation_id": "interpreter-check",
                }
            ),
            capture_output=True,
            text=True,
            timeout=60,
            env={**os.environ, "MEMORY_CLIENT_CONFIG": str(config)},
        )
        self.assertNotIn("Traceback", result.stderr, result.stderr)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"continue"', result.stdout)


class ClientConfigTests(unittest.TestCase):
    """Where the hook gets the daemon's address when nothing is in the env.

    Cursor runs hooks with a login environment, so the settings the launchd
    agent was given never reach them. A deployment that moved the daemon off
    the default port and had no other channel talked to the wrong port on
    every prompt and returned nothing, with no error anywhere. Hence the
    refusal: no location here has a fallback worth having.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.config = self.tmp / "client.json"

    def _load(self, env):
        env = dict(env, MEMORY_CLIENT_CONFIG=str(self.config))
        for key in ("MEMORY_DAEMON_URL", "MEMORY_MCP_PORT", "MEMORY_QUEUE_DIR"):
            env.setdefault(key, "")
        with mock.patch.dict(os.environ, {k: v for k, v in env.items() if v}, clear=False):
            for key, value in env.items():
                if not value:
                    os.environ.pop(key, None)
            return load_hook()

    def test_config_file_supplies_the_port_and_queue(self):
        self.config.write_text(
            json.dumps({"daemon_url": "http://127.0.0.1:17174", "queue_dir": str(self.tmp / "q")})
        )
        hook = self._load({})
        self.assertEqual(hook.SESSION_OPEN_URL, "http://127.0.0.1:17174/session-open")
        self.assertEqual(hook.QUEUE_DIR, str(self.tmp / "q"))

    def test_environment_wins_over_the_config_file(self):
        self.config.write_text(
            json.dumps({"daemon_url": "http://127.0.0.1:17174", "queue_dir": str(self.tmp / "q")})
        )
        hook = self._load({"MEMORY_DAEMON_URL": "http://127.0.0.1:19999"})
        self.assertEqual(hook.TOOL_MOMENT_URL, "http://127.0.0.1:19999/tool-moment")

    def test_a_missing_or_corrupt_config_refuses_to_run(self):
        with self.assertRaises(SystemExit) as absent:
            self._load({})
        self.assertIn("no queue_dir", str(absent.exception))

        self.config.write_text("{ not json")
        with self.assertRaises(SystemExit) as corrupt:
            self._load({})
        self.assertIn("no queue_dir", str(corrupt.exception))

    def test_a_config_naming_only_the_queue_refuses_to_run(self):
        self.config.write_text(json.dumps({"queue_dir": str(self.tmp / "q")}))
        with self.assertRaises(SystemExit) as refused:
            self._load({})
        self.assertIn("no daemon_url", str(refused.exception))


class ComplianceTests(_HookCase):
    """The compliance ladder's client half (PRD-179): the hook only reports.

    A turn on every non-trivial prompt and a pull when the agent executes a
    reading verb. The reminder is the one thing that can ride a later
    prompt, and on the first it leads the session-start block."""

    def _real_prompt(self, conversation_id="conv1"):
        return self.run_hook(
            {
                "hook_event_name": "beforeSubmitPrompt",
                "prompt": "how does the drain classify captures?",
                "conversation_id": conversation_id,
            }
        )

    def test_a_real_prompt_reports_a_turn(self):
        self._real_prompt()
        (event,) = self.daemon.sent("/compliance")
        self.assertEqual(event["type"], "turn")
        self.assertEqual(event["app"], "cursor")
        self.assertEqual(event["conversation_id"], "conv1")
        self.assertNotIn("prompt", event, "the report counts; text stays local")

    def test_trivial_prompts_report_nothing(self):
        for prompt in ("yes", "ok", "/compact", ""):
            self.run_hook({"hook_event_name": "beforeSubmitPrompt", "prompt": prompt})
        self.assertEqual(self.daemon.sent("/compliance"), [])

    def test_a_fired_tier_leads_the_session_block(self):
        self.daemon.compliance_response = {
            "status": "ok",
            "reminder": "Memory note, level 1 of 3: gone quiet too long.",
            "section": "## Memory nudge\n\nMemory note, level 1 of 3: gone quiet too long.",
        }
        self.daemon.session_open_response = KB_REPLY
        context = self._real_prompt()["additional_context"]
        self.assertTrue(context.startswith("## Memory nudge"))
        self.assertLess(
            context.index("## Memory nudge"), context.index("Project knowledge: some-repo")
        )

    def test_a_fired_tier_speaks_on_its_own(self):
        self.daemon.compliance_response = {"status": "ok", "section": "## Memory nudge\n\nNote."}
        self.assertEqual(self._real_prompt()["additional_context"], "## Memory nudge\n\nNote.")

    def test_a_reading_verb_reports_a_pull(self):
        self.run_hook(
            {
                "hook_event_name": "preToolUse",
                "tool_name": "MCP:memory_recall",
                "tool_input": {"query": "drain"},
                "conversation_id": "conv1",
            }
        )
        (event,) = self.daemon.sent("/compliance")
        self.assertEqual(event["type"], "pull")
        self.assertEqual(event["tool"], "memory_recall")
        self.assertEqual(event["app"], "cursor")

    def test_the_knowledge_base_read_is_a_pull(self):
        self.run_hook(
            {
                "hook_event_name": "preToolUse",
                "tool_name": "MCP:knowledge_read",
                "tool_input": {"project": "some-repo"},
                "conversation_id": "conv1",
            }
        )
        (event,) = self.daemon.sent("/compliance")
        self.assertEqual(event["tool"], "knowledge_read")

    def test_other_tools_are_not_pulls(self):
        self.declines(
            {
                "hook_event_name": "preToolUse",
                "tool_name": "Shell",
                "tool_input": {"command": "git status"},
                "conversation_id": "conv1",
            }
        )
        result = self.run_hook(
            {
                "hook_event_name": "preToolUse",
                "tool_name": "MCP:memory_remember",
                "tool_input": {"content": "a fact"},
                "workspace_roots": ["/tmp/some-repo"],
                "conversation_id": "conv1",
            }
        )
        self.assertEqual(result["permission"], "allow")
        self.assertEqual(self.daemon.sent("/compliance"), [])


if __name__ == "__main__":
    unittest.main()
