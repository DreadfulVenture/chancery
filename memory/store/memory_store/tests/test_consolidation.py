"""Tests for the hub consolidation loop: claim/release, exclusion, alarm."""

from __future__ import annotations

import tempfile
import time
import unittest
import os
from unittest import mock
from pathlib import Path

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.consolidation.consolidation import (
    SLEEP_PROMPT,
    consolidate_group,
    next_consolidation_group,
    pending_backlog,
    summarize_via_llm,
)
from memory_store.store import Store


def always_summarize(lines, source):
    return f"Summary of {len(lines)} turns about {lines[0][:30]}."


def never_summarize(lines, source):
    return None


class ConsolidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "h.db")
        self.store.upsert_capture(
            {
                "id": "s1",
                "content": "[USER] we decided gateway ownership",
                "source": "",
                "kind": "speech",
                "session_id": "ses_a",
                "repo": "example",
                "origin": "capture",
                "app": "opencode",
            }
        )
        self.store.upsert_capture(
            {
                "id": "s2",
                "content": "[AGENT] the drop-in owns the overrides",
                "source": "",
                "kind": "speech",
                "session_id": "ses_a",
                "repo": "example",
                "origin": "capture",
                "app": "opencode",
            }
        )
        self.store.upsert_capture(
            {
                "id": "x1",
                "content": "[USER] <chat-history-summary> nested content",
                "source": "",
                "kind": "fork_summary",
                "session_id": "ses_c",
                "repo": "example",
                "origin": "capture",
                "app": "opencode",
            }
        )
        self.store.upsert_capture(
            {
                "id": "x2",
                "content": "[USER] boot log wall [ OK ]",
                "source": "",
                "kind": "exhibit",
                "session_id": "ses_d",
                "repo": "example",
                "origin": "capture",
                "app": "opencode",
            }
        )

    def tearDown(self):
        self.store.close()

    def test_grouping_excludes_non_speech(self):
        groups = next_consolidation_group(self.store)
        self.assertEqual(list(groups), ["ses_a"])
        self.assertEqual(groups["ses_a"], ["s1", "s2"])

    def test_consolidate_writes_episodic_and_marks(self):
        result = consolidate_group(self.store, "ses_a", ["s1", "s2"], summarizer=always_summarize)
        self.assertEqual(result["status"], "ok")
        marked = self.store.conn.execute(
            """SELECT consolidated_at, consolidation_claimed_at FROM working_memory
               WHERE id = 's1'"""
        ).fetchone()
        self.assertIsNotNone(marked["consolidated_at"])
        self.assertIsNotNone(marked["consolidation_claimed_at"])
        episodic = self.store.conn.execute("SELECT COUNT(*) AS n FROM episodic_memory").fetchone()[
            "n"
        ]
        self.assertEqual(episodic, 1)
        # Provenance columns: the summary names its producer and carries the
        # structured source-conversation link (summary_of).
        ep = self.store.conn.execute(
            """SELECT repo, origin, app, summary_of FROM episodic_memory LIMIT 1"""
        ).fetchone()
        self.assertEqual(ep["repo"], "example")
        self.assertEqual(ep["origin"], "consolidated")
        self.assertEqual(ep["app"], "memory-store")
        self.assertEqual(ep["summary_of"], "ses_a")
        self.assertEqual(
            self.store.conn.execute(
                "SELECT consolidator_version FROM working_memory WHERE id = 's1'"
            ).fetchone()["consolidator_version"],
            "",
        )

    def test_the_times_written_are_utc_as_the_z_claims(self):
        """The summary's own timestamp is the only record of when the
        conversation it covers happened, and it is written with a Z."""
        original = os.environ.get("TZ")
        os.environ["TZ"] = "America/New_York"
        time.tzset()
        try:
            before = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            consolidate_group(self.store, "ses_a", ["s1", "s2"], summarizer=always_summarize)
            after = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        finally:
            if original is None:
                del os.environ["TZ"]
            else:
                os.environ["TZ"] = original
            time.tzset()
        stamped = self.store.conn.execute(
            "SELECT timestamp FROM episodic_memory LIMIT 1"
        ).fetchone()["timestamp"]
        claimed = self.store.conn.execute(
            "SELECT consolidated_at FROM working_memory WHERE id = 's1'"
        ).fetchone()["consolidated_at"]
        self.assertTrue(before <= stamped <= after, f"{stamped} not in [{before}, {after}]")
        self.assertTrue(before <= claimed <= after, f"{claimed} not in [{before}, {after}]")

    def test_claim_records_consolidator_version(self):
        result = consolidate_group(
            self.store,
            "ses_a",
            ["s1", "s2"],
            consolidator_version="rev:abc123",
            summarizer=always_summarize,
        )
        self.assertEqual(result["status"], "ok")
        claimed = self.store.conn.execute(
            "SELECT consolidator_version FROM working_memory WHERE id = 's1'"
        ).fetchone()
        self.assertEqual(claimed["consolidator_version"], "rev:abc123")
        self.assertEqual(result["episodic"]["metadata"]["consolidator_version"], "rev:abc123")

    def test_owner_selector_ignores_other_hosts(self):
        self.store.conn.execute(
            "UPDATE working_memory SET captured_by = 'host-a' WHERE id IN ('s1', 's2')"
        )
        self.assertEqual(next_consolidation_group(self.store, captured_by="host-b"), {})
        self.assertEqual(
            list(next_consolidation_group(self.store, captured_by="host-a")), ["ses_a"]
        )

    def test_failure_releases_claim(self):
        result = consolidate_group(self.store, "ses_a", ["s1", "s2"], summarizer=never_summarize)
        self.assertEqual(result["status"], "released")
        self.assertEqual(result["reason"], "llm-unavailable")
        rows = self.store.conn.execute(
            """SELECT consolidated_at, consolidation_claimed_at FROM working_memory
               WHERE id IN ('s1','s2')"""
        ).fetchall()
        for row in rows:
            self.assertIsNone(row["consolidated_at"])
            self.assertIsNone(row["consolidation_claimed_at"])
        # Retry succeeds once the LLM returns.
        retry = consolidate_group(self.store, "ses_a", ["s1", "s2"], summarizer=always_summarize)
        self.assertEqual(retry["status"], "ok")

    def test_released_rows_stay_in_backlog(self):
        consolidate_group(self.store, "ses_a", ["s1", "s2"], summarizer=never_summarize)
        self.assertEqual(pending_backlog(self.store), 2)

    def test_backlog_excludes_non_speech_and_consolidated(self):
        self.assertEqual(pending_backlog(self.store), 2)
        consolidate_group(self.store, "ses_a", ["s1", "s2"], summarizer=always_summarize)
        self.assertEqual(pending_backlog(self.store), 0)

    def test_backlog_with_an_empty_string_scope_scopes_the_count(self):
        # An empty string is a real scope — the caller named one
        # conversation whose id is "" — so the clause keys on
        # `is not None`, never truthiness: a truthy test would answer an
        # empty-string scope with the global backlog (review 267, count 3).
        self.assertEqual(pending_backlog(self.store, "ses_a"), 2)
        self.assertEqual(pending_backlog(self.store, ""), 0)
        self.assertEqual(pending_backlog(self.store), 2)

    def test_double_claim_is_contested(self):
        first = consolidate_group(self.store, "ses_a", ["s1", "s2"], summarizer=always_summarize)
        self.assertEqual(first["status"], "ok")
        again = consolidate_group(self.store, "ses_a", ["s1", "s2"], summarizer=always_summarize)
        self.assertIn(again["status"], ("contested", "empty"))


class SummarizerEnvTests(unittest.TestCase):
    def test_prompt_caps_summary_length(self):
        self.assertIn("Keep each summary under 1200 characters.", SLEEP_PROMPT)

    def test_missing_config_returns_none(self):
        import os

        saved = (
            os.environ.pop("MEMORY_LLM_BASE_URL", None),
            os.environ.pop("MEMORY_LLM_MODEL", None),
        )
        try:
            self.assertIsNone(summarize_via_llm(["line"], "src"))
        finally:
            for key, value in zip(("MEMORY_LLM_BASE_URL", "MEMORY_LLM_MODEL"), saved, strict=True):
                if value is not None:
                    os.environ[key] = value

    def test_llm_proxy_key_adds_bearer_header(self):
        response = mock.MagicMock()
        response.read.return_value = b'{"choices":[{"message":{"content":"summary"}}]}'
        context = mock.MagicMock()
        context.__enter__.return_value = response
        with (
            mock.patch.dict(
                os.environ,
                {
                    "MEMORY_LLM_BASE_URL": "https://llm.example/v1",
                    "MEMORY_LLM_MODEL": "hindsight",
                    "LLM_PROXY_API_KEY": "test-key",
                },
                clear=False,
            ),
            mock.patch("urllib.request.urlopen", return_value=context) as urlopen,
        ):
            self.assertEqual(summarize_via_llm(["line"], "src"), "summary")
        self.assertEqual(urlopen.call_args.args[0].get_header("Authorization"), "Bearer test-key")


if __name__ == "__main__":
    unittest.main()
