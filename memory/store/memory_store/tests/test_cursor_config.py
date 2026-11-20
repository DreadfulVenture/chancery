"""Activation-time merge into Cursor's mutable config.

hooks.json and mcp.json are shared with every other tool the user installs,
so the contract is: touch your own keys, leave everything else byte-identical.
The server and the client's hook events are registered here directly, which
is what makes them survive an extension host restart.
"""

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location(
    "cursor_config", ROOT.parent.parent / "nix" / "cursor-config.py"
)
cursor_config = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cursor_config)

SUFFIXES = ["/bin/memory-store-register-plugin", "/clients/cursor/hook"]
HOOK = "/checkout/clients/cursor/hook"
URL = "http://127.0.0.1:17174/mcp?app=cursor"
EVENTS = ("beforeSubmitPrompt", "afterAgentResponse", "preCompact", "preToolUse")
MATCHERS = {"preToolUse": ".*(memory_remember|memory_recall|rule_codify).*"}


class CursorConfigTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="cursor-config-")

    def _run(self, command=HOOK, events=EVENTS, url=URL, matchers=None, daemon_events=()):
        cursor_config.main_with_args(
            cursor_dir=self.dir,
            server_name="memory",
            server_url=url,
            hook_command=command,
            owned_suffixes=SUFFIXES,
            events=list(events),
            matchers=MATCHERS if matchers is None else matchers,
            daemon_events=daemon_events,
        )

    def _hooks(self):
        with open(os.path.join(self.dir, "hooks.json"), encoding="utf-8") as handle:
            return json.load(handle)["hooks"]

    def _write_mcp(self, servers):
        with open(os.path.join(self.dir, "mcp.json"), "w", encoding="utf-8") as handle:
            json.dump({"mcpServers": servers}, handle)

    def _mcp(self):
        with open(os.path.join(self.dir, "mcp.json"), encoding="utf-8") as handle:
            return json.load(handle)

    def test_registers_the_capture_events(self):
        self._run()
        self.assertEqual(sorted(self._hooks()), sorted(EVENTS))
        for event in EVENTS:
            self.assertEqual([entry["command"] for entry in self._hooks()[event]], [HOOK])

    def test_a_matcher_scopes_only_the_event_it_names(self):
        """Unmatched, preToolUse starts a process in front of every tool the
        agent calls, so the regex is the difference between a hook on three
        memory tools and a hook on all of them. The conversation events take
        none: they are about the prompt, which has nothing to filter on."""
        self._run()
        (tool_entry,) = self._hooks()["preToolUse"]
        self.assertEqual(tool_entry["matcher"], MATCHERS["preToolUse"])
        for event in ("beforeSubmitPrompt", "afterAgentResponse", "preCompact"):
            self.assertNotIn("matcher", self._hooks()[event][0])

    def test_dropping_a_matcher_rewrites_the_entry(self):
        # The entry is replaced wholesale rather than merged, so narrowing or
        # widening the regex cannot leave the previous one behind.
        self._run()
        self._run(matchers={})
        self.assertEqual(self._hooks()["preToolUse"], [{"command": HOOK}])

    def test_an_event_we_stop_answering_takes_its_matcher_with_it(self):
        self._run()
        self._run(events=[event for event in EVENTS if event != "preToolUse"])
        self.assertNotIn("preToolUse", self._hooks())

    def test_an_event_the_daemon_owns_is_left_exactly_as_found(self):
        """The tool-time matchers are the tools the store has rules bound
        to, which the daemon rewrites whenever one is enrolled. A build-time
        value would be stale by the next enrolment, and pruning what this
        script did not write would delete the daemon's entry on every
        rebuild."""
        theirs = {"command": HOOK, "matcher": "(gcloud|kubectl)"}
        with open(os.path.join(self.dir, "hooks.json"), "w", encoding="utf-8") as handle:
            json.dump({"version": 1, "hooks": {"beforeShellExecution": [theirs]}}, handle)
        self._run(daemon_events=["beforeShellExecution"])
        self.assertEqual(self._hooks()["beforeShellExecution"], [theirs])

    def test_a_daemon_event_is_not_registered_here_either(self):
        self._run(
            events=list(EVENTS) + ["beforeShellExecution"],
            daemon_events=["beforeShellExecution"],
        )
        self.assertNotIn("beforeShellExecution", self._hooks())

    def test_a_regex_may_contain_an_equals_sign(self):
        self.assertEqual(
            cursor_config.parse_matchers(["preToolUse=a=b", "stop=Stop"]),
            {"preToolUse": "a=b", "stop": "Stop"},
        )

    def test_a_matcher_without_its_event_is_refused(self):
        with self.assertRaises(SystemExit):
            cursor_config.parse_matchers(["justaregex"])

    def test_registers_the_server(self):
        self._run()
        self.assertEqual(
            self._mcp()["mcpServers"]["memory"],
            {"type": "streamable-http", "url": URL},
        )

    def test_rerunning_changes_nothing(self):
        self._run()
        before = [Path(self.dir, name).read_text() for name in ("hooks.json", "mcp.json")]
        self._run()
        self.assertEqual(
            [Path(self.dir, name).read_text() for name in ("hooks.json", "mcp.json")], before
        )

    def test_a_moved_checkout_replaces_the_previous_registration(self):
        """Ownership is by the tail of the command, so a hook whose directory
        has moved is recognised as ours and replaced rather than left firing
        alongside the current one from a path that may no longer exist."""
        self._run(command="/old-checkout/clients/cursor/hook")
        self._run()
        self.assertEqual(
            [entry["command"] for entry in self._hooks()["beforeSubmitPrompt"]],
            [HOOK],
        )

    def test_the_superseded_plugin_registrar_is_removed(self):
        """The workspaceOpen registrar pointed Cursor at a plugin directory.
        Left behind it registers a second copy of the server and the rule on
        every workspace open."""
        with open(os.path.join(self.dir, "hooks.json"), "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "version": 1,
                    "hooks": {
                        "workspaceOpen": [
                            {"command": "/nix/store/aaaa-plugin/bin/memory-store-register-plugin"}
                        ]
                    },
                },
                handle,
            )
        self._run()
        self.assertNotIn("workspaceOpen", self._hooks())

    def test_a_port_change_rewrites_the_url(self):
        self._run(url="http://127.0.0.1:17173/mcp?app=cursor")
        self._run()
        self.assertEqual(self._mcp()["mcpServers"]["memory"]["url"], URL)

    def test_other_tools_survive(self):
        with open(os.path.join(self.dir, "hooks.json"), "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "version": 1,
                    "hooks": {"beforeSubmitPrompt": [{"command": "/elsewhere/other-tool"}]},
                },
                handle,
            )
        self._write_mcp({"graphite": {"command": "gt"}})
        self._run()
        self.assertEqual(
            [entry["command"] for entry in self._hooks()["beforeSubmitPrompt"]],
            ["/elsewhere/other-tool", HOOK],
        )
        self.assertEqual(self._mcp()["mcpServers"]["graphite"], {"command": "gt"})


if __name__ == "__main__":
    unittest.main()
