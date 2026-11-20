"""Before-use recall: which commands the store elects as tools, the regex
both Cursor and the hook run against a command line, and what comes back
for a tool that is about to be used."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/../..")

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store import toolrecall  # noqa: E402
from memory_store.store import Store  # noqa: E402


class ToolRecallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="toolrecall-test-")
        self.store = Store(os.path.join(self.tmp, "memory.db"))
        self.store.vec_available = False
        self.counter = 0

    def tearDown(self):
        self.store.close()

    def _row(self, content, origin="deliberate", importance=0.8):
        self.counter += 1
        self.store.upsert_capture(
            {
                "id": f"row{self.counter}",
                "content": content,
                "source": "convention" if origin == "deliberate" else "",
                "importance": importance,
                "origin": origin,
                "app": "test",
            }
        )

    def _agent_row(self, content, importance=0.8):
        """Seed a deliberate row into agent_memory, the deliberate pool's
        home."""
        self.counter += 1
        session = self.store.get_or_create_session("hal", "test", f"ses{self.counter}")
        self.store.upsert_agent(
            {
                "id": f"mrow{self.counter}",
                "session_id": session,
                "content": content,
                "source": "convention",
                "importance": importance,
                "app": "test",
            }
        )

    def _rows(self, content, count, **kwargs):
        for _ in range(count):
            self._row(content, **kwargs)

    # --- derivation ---------------------------------------------------

    def test_a_command_named_often_enough_becomes_a_tool(self):
        self._rows("run `gcloud auth login` first", 3)
        self._rows("try `kubectl get pods` here", 2)
        self.assertEqual(toolrecall.derive_tools(self.store), ["gcloud"])

    def test_agent_rows_elect_tools_and_return_rows(self):
        self._agent_row("run `gcloud auth login` first")
        self._agent_row("run `gcloud auth describe-credentials` second")
        self._agent_row("and `gcloud config get-value project` third")
        self.assertEqual(toolrecall.derive_tools(self.store), ["gcloud"])
        rows = toolrecall.recall_for_tools(self.store, ["gcloud"], command="gcloud auth login")
        contents = [r["content"] for r in rows]
        self.assertIn("run `gcloud auth login` first", contents)
        for row in rows:
            for field in (
                "id",
                "content",
                "source",
                "timestamp",
                "created_at",
                "veracity",
                "tier",
                "tool",
                "score",
            ):
                self.assertIn(field, row)
            self.assertEqual(row["tier"], "working")

    def test_one_row_rehearsing_a_command_does_not_elect_it(self):
        """Counted once per row. A single note listing eight `oink`
        invocations is one person mentioning one tool once."""
        self._row("`oink sql`, `oink logs`, `oink flags`, `oink whereis`, `oink gha`")
        self.assertEqual(toolrecall.derive_tools(self.store), [])

    def test_a_bare_name_with_no_arguments_is_a_mention_not_a_command(self):
        self._rows("the `gcloud` SDK is installed", 3)
        self.assertEqual(toolrecall.derive_tools(self.store), [])

    def test_captured_turns_do_not_elect_a_tool(self):
        """A tool elected by transcript chatter has nothing written down to
        show, so the interruption would buy nothing."""
        self._rows("I ran `gcloud auth login` and it worked", 5, origin="capture")
        self.assertEqual(toolrecall.derive_tools(self.store), [])

    def test_shell_grammar_is_not_a_tool(self):
        self._rows("wrap it in `if [ -f x ]` to be safe", 3)
        self._rows("use `source ~/.zshrc` after", 3)
        self.assertEqual(toolrecall.derive_tools(self.store), [])

    def test_quoted_code_is_not_a_command(self):
        """Backticks mark both, and an assignment or an import puts a
        plausible name in front of plausible arguments."""
        self._rows('pin it with `python = "3.11.*"`', 3)
        self._rows("the module wants `from datetime import UTC`", 3)
        self._rows("set `force_destroy = true` on the bucket", 3)
        self.assertEqual(toolrecall.derive_tools(self.store), [])

    # --- the matcher ---------------------------------------------------

    def test_the_tool_is_found_in_command_position(self):
        tools = ["gcloud", "make"]
        for command in (
            "gcloud auth login",
            "cd example && gcloud projects list",
            "export X=1; gcloud projects list",
            'bash -c "gcloud projects list"',
            "$(gcloud config get project)",
            "timeout 60 gcloud logging read x",
            "sudo CLOUDSDK_CORE_PROJECT=p gcloud projects list",
        ):
            self.assertEqual(toolrecall.tools_in_command(command, tools), ["gcloud"], command)

    def test_the_tool_named_as_an_argument_is_not_found(self):
        """The difference between starting the hook on half of all shell
        calls and starting it on nearly all of them: `git`, `go` and `make`
        turn up in paths, grep patterns and prose constantly."""
        tools = ["gcloud", "make", "git"]
        for command in (
            "rg gcloud",
            "echo 'run gcloud auth login'",
            "cat ~/git/notes.md",
            "ls /usr/local/make",
        ):
            self.assertEqual(toolrecall.tools_in_command(command, tools), [], command)

    def test_a_longer_name_starting_with_a_tool_is_not_the_tool(self):
        self.assertEqual(toolrecall.tools_in_command("gofmt ./...", ["go"]), [])
        self.assertEqual(toolrecall.tools_in_command("go-task build", ["go"]), [])
        self.assertEqual(toolrecall.tools_in_command("go test ./...", ["go"]), ["go"])

    def test_every_tool_in_a_joined_command_is_found(self):
        self.assertEqual(
            toolrecall.tools_in_command(
                "kubectl get ns && oink sql --query x | head", ["kubectl", "oink"]
            ),
            ["kubectl", "oink"],
        )

    def test_one_tool_twice_is_reported_once(self):
        self.assertEqual(toolrecall.tools_in_command("git fetch && git rebase", ["git"]), ["git"])

    def test_no_tools_matches_nothing(self):
        self.assertEqual(toolrecall.matcher_pattern([]), "")
        self.assertEqual(toolrecall.tools_in_command("gcloud auth login", []), [])

    # --- recall ---------------------------------------------------------

    def test_the_subcommand_lifts_its_own_rows(self):
        """Importance decides, with a nudge toward what is actually being
        run — enough to order rows the user weighted the same, not enough
        to bury one they weighted higher."""
        self._row("`gcloud auth login` when credentials expire", importance=0.9)
        self._row("`gcloud logging read` needs a resource filter", importance=0.9)
        ranked = toolrecall.recall_for_tools(self.store, ["gcloud"], "gcloud logging read x")
        self.assertIn("logging", ranked[0]["content"])
        ranked = toolrecall.recall_for_tools(self.store, ["gcloud"], "gcloud auth login")
        self.assertIn("auth", ranked[0]["content"])

    def test_importance_outranks_a_matching_subcommand(self):
        self._row("`gcloud auth login` when credentials expire", importance=0.95)
        self._row("`gcloud logging read` needs a resource filter", importance=0.5)
        ranked = toolrecall.recall_for_tools(self.store, ["gcloud"], "gcloud logging read x")
        self.assertIn("auth", ranked[0]["content"])

    def test_only_a_few_rows_come_back_per_tool(self):
        for index in range(8):
            self._row(f"`gcloud projects list` note {index}")
        ranked = toolrecall.recall_for_tools(self.store, ["gcloud"], "gcloud projects list")
        self.assertEqual(len(ranked), toolrecall.ROWS_PER_TOOL)

    def test_captured_turns_are_not_recalled(self):
        self._row("`gcloud auth login` when credentials expire")
        self._rows("I typed `gcloud auth login` and waited", 3, origin="capture")
        ranked = toolrecall.recall_for_tools(self.store, ["gcloud"], "gcloud auth login")
        self.assertEqual([row["id"] for row in ranked], ["row1"])

    def test_a_row_only_mentioning_the_name_is_not_about_the_tool(self):
        self._row("look in `~/git/gcloud-notes.md` for the rest")
        self.assertEqual(
            toolrecall.recall_for_tools(self.store, ["gcloud"], "gcloud auth login"), []
        )

    def test_each_row_says_which_tool_it_answered_for(self):
        self._row("`gcloud auth login` when credentials expire")
        self._row("`kubectl config use-context` first")
        ranked = toolrecall.recall_for_tools(
            self.store, ["gcloud", "kubectl"], "gcloud auth login && kubectl get ns"
        )
        self.assertEqual([row["tool"] for row in ranked], ["gcloud", "kubectl"])


if __name__ == "__main__":
    unittest.main()
