"""Tests for capture classification and repo resolution."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.capture import (
    capture_source,
    classify_capture,
    deliberate_source,
    detect_repo,
    is_title_gen_template,
    resolve_workspace,
)


class ClassifyTests(unittest.TestCase):
    def test_fork_summary_marker(self):
        content = "<chat-history-summary>\nChat history from a prior voice/capture tool session."
        self.assertEqual(classify_capture(content), "fork_summary")

    def test_plain_speech(self):
        self.assertEqual(classify_capture("What's the status of the deploy?"), "speech")

    def test_fenced_log_is_exhibit(self):
        content = (
            "Here's the boot log:\n```\n"
            + "[ 0.000000] EFI: reserved mem: failed to allocate\n" * 30
            + "\n```"
        )
        self.assertEqual(classify_capture(content), "exhibit")

    def test_short_inline_code_is_speech(self):
        self.assertEqual(classify_capture("Check `memory.js:90` for the filter"), "speech")

    def test_unfenced_log_defaults_speech(self):
        content = "[ OK ] Listening on Journal Sockets.\n" * 40
        self.assertEqual(classify_capture(content), "speech")

    def test_nested_fences_outer_wins(self):
        # Markdown-about-markdown: ``` blocks inside a ```` wrapper. The outer
        # run-length fence governs; the whole thing is one exhibit block.
        inner = "```js\n" + "console.log('a log line');\n" * 40 + "```"
        content = "````markdown\n" + inner + "\n````"
        self.assertEqual(classify_capture(content), "exhibit")

    def test_unclosed_fence_errs_exhibit(self):
        content = "prose intro\n```\n" + "some pasted content line\n" * 30
        self.assertEqual(classify_capture(content), "exhibit")

    def test_title_gen_template(self):
        content = (
            "Generate a title and a git branch name for a coding agent from the "
            "user prompt and attachments."
        )
        self.assertTrue(is_title_gen_template(content))
        self.assertEqual(classify_capture(content), "exhibit")

    def test_speech_with_small_fence_stays_speech(self):
        content = "I looked at the config:\n```\nport = 443\n```\nand the port looks right."
        self.assertEqual(classify_capture(content), "speech")


class SourceGrammarTests(unittest.TestCase):
    def test_capture_source_uses_resolved_repo(self):
        self.assertEqual(capture_source("example", "ses_abc12345"), "cursor:example:ses_abc1")

    def test_compound_deliberate_source(self):
        self.assertEqual(deliberate_source("convention", "example"), "convention:example")
        self.assertEqual(deliberate_source("correction"), "correction")


class DetectRepoTests(unittest.TestCase):
    def test_plain_directory_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(detect_repo(tmp), os.path.basename(tmp))

    def test_git_repo_without_remote_uses_common_dir(self):
        import subprocess

        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["git", "init", "-q"], cwd=tmp, check=True)
            self.assertEqual(detect_repo(tmp), os.path.basename(tmp))

    def test_worktree_resolves_to_main_repo_name(self):
        import subprocess

        with tempfile.TemporaryDirectory() as base:
            main = Path(base) / "myrepo"
            main.mkdir()
            subprocess.run(["git", "init", "-q"], cwd=main, check=True)
            subprocess.run(["git", "config", "user.email", "t@t"], cwd=main, check=True)
            subprocess.run(["git", "config", "user.name", "t"], cwd=main, check=True)
            (main / "f").write_text("x")
            subprocess.run(["git", "add", "."], cwd=main, check=True)
            # --no-gpg-sign: a developer with commit.gpgsign set globally
            # otherwise gets a signing prompt inside the test run.
            subprocess.run(["git", "commit", "-qm", "init", "--no-gpg-sign"], cwd=main, check=True)
            subprocess.run(
                ["git", "worktree", "add", "-q", str(Path(base) / "wt-main-xyz")],
                cwd=main,
                check=True,
            )
            # The worktree's basename is junk; detect_repo must find myrepo.
            self.assertEqual(detect_repo(str(Path(base) / "wt-main-xyz")), "myrepo")

    def test_no_directory_resolves_to_nothing(self):
        # The daemon serves every session from cwd '/', so resolving the
        # process directory for a turn whose client sent none stamped it
        # with the basename of '/' — empty, rendered as the literal name
        # 'unknown' and then boosted as if it were a real workspace.
        with mock.patch.object(os, "getcwd", side_effect=AssertionError("asked the process")):
            self.assertEqual(detect_repo(None), "")
            self.assertEqual(detect_repo(""), "")
            self.assertEqual(resolve_workspace(None), "")
            self.assertEqual(resolve_workspace(""), "")

    def test_a_rootless_directory_is_not_named_unknown(self):
        # '/' has no basename. The fallback used to substitute the string
        # 'unknown', which reads as a repo name and matches the boost.
        self.assertEqual(detect_repo("/"), "")


if __name__ == "__main__":
    unittest.main()
