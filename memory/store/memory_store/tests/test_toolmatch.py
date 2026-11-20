"""The token matcher against the PRD's edge list, plus the tokenizer's
tolerance contract. One matcher definition, both clients — these cases
are the definition."""

from __future__ import annotations

import unittest

from memory_store import toolmatch


def fires(command: str, key: list[str]) -> bool:
    return toolmatch.command_matches(command, key)


class TokenizerTests(unittest.TestCase):
    def test_quoted_prose_is_one_token(self):
        self.assertEqual(
            toolmatch.tokenize('echo "git push is ready"'), ["echo", "git push is ready"]
        )

    def test_malformed_quoting_falls_back_to_whitespace(self):
        # Never raise: the fallback splits on whitespace, which can only
        # cost a match, never a crash.
        self.assertEqual(
            toolmatch.tokenize('git commit -m "unterminated'),
            ["git", "commit", "-m", '"unterminated'],
        )
        self.assertEqual(
            toolmatch.tokenize("git push && echo 'open"), ["git", "push", "&&", "echo", "'open"]
        )

    def test_punctuation_trims_from_edges(self):
        self.assertEqual(toolmatch.tokenize("$(git push)"), ["git", "push"])
        self.assertEqual(
            toolmatch.tokenize("(git push; git status)"), ["git", "push", "git", "status"]
        )
        self.assertEqual(toolmatch.tokenize("git push,"), ["git", "push"])
        self.assertEqual(toolmatch.tokenize(">(git push)"), ["git", "push"])

    def test_wrappers_and_assignments_survive_as_tokens(self):
        self.assertEqual(
            toolmatch.tokenize("FOO=bar sudo -u root git push"),
            ["FOO=bar", "sudo", "-u", "root", "git", "push"],
        )


class CommandMatchTests(unittest.TestCase):
    KEY = ["git", "push"]

    def test_plain(self):
        self.assertTrue(fires("git push", self.KEY))
        self.assertTrue(fires("git push origin main", self.KEY))

    def test_wrapper_in_front(self):
        self.assertTrue(fires("sudo git push", self.KEY))
        self.assertTrue(fires("FOO=1 env git push", self.KEY))

    def test_chain(self):
        self.assertTrue(fires("x && git push", self.KEY))
        self.assertTrue(fires("make test && git push && make rehearse", self.KEY))

    def test_subshell(self):
        self.assertTrue(fires("$(git push)", self.KEY))
        self.assertTrue(fires("(cd repo && git push)", self.KEY))

    def test_negative_command(self):
        self.assertFalse(fires("git status", self.KEY))

    def test_regit_never_matches(self):
        self.assertFalse(fires("regit push", self.KEY))
        self.assertFalse(fires("gitx push", self.KEY))

    def test_quoted_prose_never_matches(self):
        self.assertFalse(fires('echo "git push is ready"', self.KEY))
        self.assertFalse(fires("echo 'please git push soon'", self.KEY))

    def test_contiguity_is_required(self):
        # "git" then unrelated token then "push": not a subsequence match.
        self.assertFalse(fires("git remote add origin && push", self.KEY))

    def test_key_fires_anywhere_in_chain_both_legs(self):
        # The PRD's breadth example: a key fires anywhere in the chain,
        # and each occurrence is the same binding firing, not two.
        self.assertTrue(fires("git push --force && git push", self.KEY))

    def test_repeated_key_in_command(self):
        self.assertTrue(fires("git push && git push", self.KEY))

    def test_empty_key_never_fires(self):
        self.assertFalse(fires("git push", []))
        self.assertFalse(fires("git push", [""]))

    def test_key_longer_than_command(self):
        self.assertFalse(fires("git", ["git", "push"]))


class McpMatchTests(unittest.TestCase):
    def test_exact_single_element(self):
        self.assertTrue(toolmatch.mcp_matches("deploy", ["deploy"]))
        self.assertFalse(toolmatch.mcp_matches("deploy", ["deploy", "prod"]))
        self.assertFalse(toolmatch.mcp_matches("deploy_prod", ["deploy"]))
        self.assertFalse(toolmatch.mcp_matches("deploy", ["undeploy"]))

    def test_names_are_whole(self):
        self.assertFalse(toolmatch.mcp_matches("memory_remember", ["memory_recall"]))


class CanonicalNameTests(unittest.TestCase):
    KNOWN = frozenset({"tool_rule_add", "memory_remember"})

    def test_opencode_decoration_strips(self):
        self.assertEqual(
            toolmatch.canonical_mcp_name("opencode", "memory_tool_rule_add", self.KNOWN),
            "tool_rule_add",
        )
        self.assertEqual(
            toolmatch.canonical_mcp_name("opencode", "memory_memory_remember", self.KNOWN),
            "memory_remember",
        )

    def test_undecorated_canonical_passes_through(self):
        # memory_* canonical names collide with the decoration prefix; a
        # wire name that already IS canonical is not stripped.
        self.assertEqual(
            toolmatch.canonical_mcp_name("opencode", "memory_remember", self.KNOWN),
            "memory_remember",
        )

    def test_cursor_prefix_strips(self):
        # Cursor's own prefix, with no server key in it.
        self.assertEqual(
            toolmatch.canonical_mcp_name("cursor", "MCP:deploy_service", self.KNOWN),
            "deploy_service",
        )
        self.assertEqual(
            toolmatch.canonical_mcp_name("cursor", "MCP:memory_remember", self.KNOWN),
            "memory_remember",
        )

    def test_unknown_client_matches_verbatim(self):
        self.assertEqual(
            toolmatch.canonical_mcp_name("zed", "mcp__memory__bind", self.KNOWN),
            "mcp__memory__bind",
        )


if __name__ == "__main__":
    unittest.main()
