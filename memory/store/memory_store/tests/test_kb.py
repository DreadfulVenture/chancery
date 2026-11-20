"""Tests for the knowledge-base build pass (PRJ-175).

The deterministic surface is under test: delta selection, the hard
exclusions (tombstones retroactive, behavioural rows structurally
absent), cursor/debounce gating that makes a no-delta pass spend
nothing, the release contract (prior version stays standing), the
release ladder (each consecutive failure doubles the next wait, capped,
cleared by a landed build) with its deadlock guards (the alarm line and
the no-progress reset), the bounded fold batches (a backlog drains in
character-sized chunks, the cursor advancing per batch, the pass capped),
the composer's bounded compress-to-fit re-asks, and wire-convergence
ordering. Composition is injected at the pass; the composer's own loop
is tested with the route patched out."""

from __future__ import annotations

import calendar
import contextlib
import io
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store import kb
from memory_store.store import Store, validate_record
from memory_store.sync import SyncClient
from memory_store.tools import Tools


def make_store(tmpdir: str) -> Store:
    return Store(Path(tmpdir) / "kb.db")


def _epoch(stamp: str) -> float:
    return calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))


class KbPassTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = make_store(self.tmp)
        self.calls: list[tuple] = []

    def tearDown(self):
        self.store.close()

    def _deliberate(self, row_id: str, project: str, content: str, timestamp: str) -> None:
        session = self.store.get_or_create_session("hal", "opencode", f"ses_{row_id}", project)
        self.store.upsert_agent(
            {
                "id": row_id,
                "session_id": session,
                "content": content,
                "timestamp": timestamp,
                "repo": project,
            }
        )

    def _composer(self, text="Sheet: the deploy gate is on."):
        def compose(project, prior_doc, lines, evictions):
            self.calls.append((project, prior_doc, lines, evictions))
            return text

        return compose

    def test_a_no_delta_pass_spends_nothing(self):
        result = kb.kb_build_pass(
            self.store, summarizer=self._composer(), emit=None, debounce_seconds=0
        )
        self.assertEqual(result, {"built": 0, "deferred": 0, "released": 0, "skipped": 0})
        self.assertEqual(self.calls, [])

    def test_a_build_consumes_the_delta_and_advances_the_cursor(self):
        self._deliberate("m1", "example", "the deploy gate is on", "2026-11-01T00:00:00Z")
        self._deliberate("m2", "example", "store path is not stable", "2026-11-02T00:00:00Z")
        seen: list = []
        result = kb.kb_build_pass(
            self.store,
            summarizer=self._composer(),
            emit=lambda kind, payload, record_id=None: seen.append((kind, payload)),
            debounce_seconds=0,
        )
        self.assertEqual(result["built"], 1)
        self.assertEqual(self.calls[0][0], "example")
        self.assertEqual(self.calls[0][1], "", "the first build has no prior doc")
        doc = self.store.kb_current("example")
        self.assertEqual(len(doc), 1)
        self.assertEqual(doc[0]["build_seq"], 1)
        self.assertEqual(doc[0]["inputs"], ["m1", "m2"], "inputs journal the consumed rows")
        self.assertEqual(self.store._meta_get("kb_cursor:example"), "2026-11-02T00:00:00Z|m2")
        self.assertEqual(seen[0][0], "knowledge_base")
        self.assertEqual(seen[0][1]["id"], doc[0]["id"])

    def test_rows_past_the_cursor_fold_once(self):
        self._deliberate("m1", "example", "first", "2026-11-01T00:00:00Z")
        kb.kb_build_pass(self.store, summarizer=self._composer(), emit=None, debounce_seconds=0)
        self._deliberate("m2", "example", "second", "2026-11-03T00:00:00Z")
        kb.kb_build_pass(self.store, summarizer=self._composer(), emit=None, debounce_seconds=0)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(
            self.calls[1][2],
            ["[2026-11-03T00:00:00Z] second"],
            "the second pass folds only the new delta",
        )
        current = self.store.kb_current("example")
        self.assertEqual(current[0]["build_seq"], 2)
        self.assertEqual(current[0]["inputs"], ["m2"])

    def test_a_forgotten_row_leaves_the_delta_retroactively(self):
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        kb.kb_build_pass(self.store, summarizer=self._composer(), emit=None, debounce_seconds=0)
        self._deliberate("m2", "example", "its correction", "2026-11-02T00:00:00Z")
        self.store.forget("agent_memory", "m1")
        kb.kb_build_pass(self.store, summarizer=self._composer(), emit=None, debounce_seconds=0)
        self.assertEqual(self.calls[1][2], ["[2026-11-02T00:00:00Z] its correction"])

    def test_a_bare_forget_evicts_the_claim_from_the_next_fold(self):
        # The removal path that needs no replacing row: the dead row's
        # text rides its tombstone into the composer as an eviction, and
        # the forget-only delta is enough to trigger the build.
        self._deliberate("m1", "example", "the store path hash is stable", "2026-11-01T00:00:00Z")
        kb.kb_build_pass(self.store, summarizer=self._composer(), emit=None, debounce_seconds=0)
        self.store.forget("agent_memory", "m1")
        result = kb.kb_build_pass(
            self.store, summarizer=self._composer(), emit=None, debounce_seconds=0
        )
        self.assertEqual(result["built"], 1, "a forget-only delta still builds")
        project, prior_doc, lines, evictions = self.calls[1]
        self.assertEqual(lines, [], "no new rows fold with the eviction")
        self.assertEqual(evictions, [("m1", "the store path hash is stable")])
        self.assertTrue(prior_doc, "the standing sheet feeds forward to be cleaned")
        version = self.store.kb_current("example")[0]
        self.assertEqual(version["build_seq"], 2)
        self.assertEqual(version["inputs"], [], "no new content was consumed")

    def test_a_tombstone_without_content_is_skipped(self):
        # Tombstones predating the content column carry NULL; the eviction
        # scan cannot name prose for them and passes them by.
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        kb.kb_build_pass(self.store, summarizer=self._composer(), emit=None, debounce_seconds=0)
        self.store.conn.execute(
            "INSERT OR IGNORE INTO forget_tombstones (table_name, row_id) "
            "VALUES ('agent_memory', 'mX')"
        )
        self.store.conn.commit()
        self.assertEqual(kb.eviction_scan(self.store, "example"), [])

    def test_a_row_forgotten_before_its_build_never_folds(self):
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        self.store.forget("agent_memory", "m1")
        kb.kb_build_pass(self.store, summarizer=self._composer(), emit=None, debounce_seconds=0)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.store.kb_current(), [])

    def test_rows_without_a_repo_stamp_fold_nowhere(self):
        session = self.store.get_or_create_session("hal", "opencode", "ses_g", "")
        self.store.upsert_agent(
            {
                "id": "mG",
                "session_id": session,
                "content": "a global-neutral fact",
                "timestamp": "2026-11-01T00:00:00Z",
                "repo": "",
            }
        )
        result = kb.kb_build_pass(
            self.store, summarizer=self._composer(), emit=None, debounce_seconds=0
        )
        self.assertEqual(result["built"], 0)

    def test_behavioural_rows_cannot_reach_the_fold(self):
        # The hard line as a structural fact: the scan reads agent_memory
        # alone, so its row set is exactly the deliberate rows with a
        # repo stamp — guidance-family rows never enter the query.
        self._deliberate("m1", "example", "a real fact", "2026-11-01T00:00:00Z")
        self._deliberate("m2", "example", "another fact", "2026-11-02T00:00:00Z")
        scan = kb.delta_scan(self.store)
        self.assertEqual([r["id"] for r in scan.get("example", [])], ["m1", "m2"])

    def test_the_debounce_window_defers_a_burst_into_one_build(self):
        self._deliberate("m1", "example", "first", "2026-11-01T00:00:00Z")
        kb.kb_build_pass(self.store, summarizer=self._composer(), emit=None, debounce_seconds=1800)
        self._deliberate("m2", "example", "second", "2026-11-01T00:30:00Z")
        self._deliberate("m3", "example", "third", "2026-11-01T00:31:00Z")
        result = kb.kb_build_pass(
            self.store, summarizer=self._composer(), emit=None, debounce_seconds=1800
        )
        self.assertEqual(result["deferred"], 1)
        self.assertEqual(len(self.calls), 1)
        # The next pass after the window folds the whole burst at once
        # (the stamp moved into the past).
        self.store._meta_set("kb_next_build_at:example", "2020-01-01T00:00:00Z")
        kb.kb_build_pass(self.store, summarizer=self._composer(), emit=None, debounce_seconds=1800)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(len(self.calls[1][2]), 2, "the deferred burst folds whole")

    def test_a_chain_failure_releases_and_keeps_the_prior_version(self):
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        kb.kb_build_pass(self.store, summarizer=self._composer(), emit=None, debounce_seconds=0)
        standing = self.store.kb_current("example")

        def explode(project, prior_doc, lines, evictions):
            raise RuntimeError("route down")

        # The failing pass has a delta to fold: the release is the delta
        # staying unreflected, not an empty scan.
        self._deliberate("m2", "example", "its followup", "2026-11-02T00:00:00Z")
        result = kb.kb_build_pass(self.store, summarizer=explode, emit=None, debounce_seconds=0)
        self.assertEqual(result["released"], 1)
        self.assertEqual(self.store.kb_current("example"), standing)

    def test_an_over_length_doc_releases_instead_of_truncating(self):
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        long_doc = "x" * 7000
        result = kb.kb_build_pass(
            self.store,
            summarizer=self._composer(text=long_doc),
            emit=None,
            debounce_seconds=0,
        )
        self.assertEqual(result["released"], 1)
        self.assertEqual(self.store.kb_current(), [])

    def test_compress_exhaustion_releases_through_the_pass(self):
        # The full production path: the composer's bounded re-asks ran
        # out, the over-length draft came back intact, and the pass
        # released it — nothing shipped, nothing truncated.
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        draft = "x" * 7000
        prompts: list[str] = []
        replies = iter([draft, draft, draft])

        def route(prompt, **kwargs):
            prompts.append(prompt)
            return next(replies)

        with mock.patch.object(kb, "_chat_completion", route):
            result = kb.kb_build_pass(
                self.store, summarizer=kb.compose_via_llm, emit=None, debounce_seconds=0
            )
        self.assertEqual(result["released"], 1)
        self.assertEqual(len(prompts), 3, "the initial fold plus two bounded compress re-asks")
        self.assertEqual(self.store.kb_current(), [])

    def test_a_released_project_sets_its_retry_window(self):
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        kb.kb_build_pass(
            self.store,
            summarizer=lambda *a, **k: None,
            emit=None,
            debounce_seconds=1800,
        )
        self.assertTrue(self.store._meta_get("kb_next_build_at:example"))

    def _ladder_stamp(self, project: str, delay: float, before: float, after: float) -> None:
        # The stamp is authorized anywhere in the pass's own span [before,
        # after], less the second-truncating format: envelope the band so
        # a slow pass cannot flake the assert, a fast one cannot false-pass.
        stamp = _epoch(self.store._meta_get(f"kb_next_build_at:{project}"))
        self.assertTrue(
            before + delay - 2 <= stamp <= after + delay + 1,
            f"waited {stamp - before}, want ~{delay}",
        )

    def test_a_released_project_escalates_its_retry_window(self):
        # The ladder (PRJ-256): the second consecutive failure waits
        # roughly double the first, so an outage slows a project's
        # retries down instead of holding a fixed cadence.
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        before = time.time()
        released = kb.kb_build_pass(
            self.store,
            summarizer=lambda *a, **k: None,
            emit=None,
            debounce_seconds=0,
            retry_base=1800,
            retry_cap=21600,
        )
        after = time.time()
        self.assertEqual(released["released"], 1)
        self._ladder_stamp("example", 1800, before, after)
        # Age the stamp so the next pass may attempt again; the failure
        # streak the stamp rode is untouched.
        self.store._meta_set("kb_next_build_at:example", "2020-01-01T00:00:00Z")
        before = time.time()
        kb.kb_build_pass(
            self.store,
            summarizer=lambda *a, **k: None,
            emit=None,
            debounce_seconds=0,
            retry_base=1800,
            retry_cap=21600,
        )
        after = time.time()
        self._ladder_stamp("example", 3600, before, after)

    def test_the_retry_window_escalates_to_its_cap(self):
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        for delay in (1800, 3600, 3600):
            before = time.time()
            result = kb.kb_build_pass(
                self.store,
                summarizer=lambda *a, **k: None,
                emit=None,
                debounce_seconds=0,
                retry_base=1800,
                retry_cap=3600,
            )
            after = time.time()
            self.assertEqual(result["released"], 1)
            self._ladder_stamp("example", delay, before, after)
            self.store._meta_set("kb_next_build_at:example", "2020-01-01T00:00:00Z")

    def test_a_forged_streak_meets_the_cap_without_overflowing(self):
        # The clamp pins the exponent: a hand-corrupted or stale counter
        # rides the cap instead of overflowing the float multiply.
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        self.store._meta_set("kb_failures:example", "40")
        before = time.time()
        released = kb.kb_build_pass(
            self.store,
            summarizer=lambda *a, **k: None,
            emit=None,
            debounce_seconds=0,
            retry_base=1800,
            retry_cap=3600,
        )
        after = time.time()
        self.assertEqual(released["released"], 1)
        self._ladder_stamp("example", 3600, before, after)

    def test_a_corrupted_counter_falls_to_the_base_window(self):
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        self.store._meta_set("kb_failures:example", "nonsense")
        before = time.time()
        released = kb.kb_build_pass(
            self.store,
            summarizer=lambda *a, **k: None,
            emit=None,
            debounce_seconds=0,
            retry_base=1800,
            retry_cap=21600,
        )
        after = time.time()
        self.assertEqual(released["released"], 1, "corruption must not take the pass down")
        self._ladder_stamp("example", 1800, before, after)
        self.assertEqual(self.store._meta_get("kb_failures:example"), "1")

    def test_a_landed_build_resets_the_failure_streak(self):
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        for _ in range(2):
            kb.kb_build_pass(
                self.store,
                summarizer=lambda *a, **k: None,
                emit=None,
                debounce_seconds=0,
                retry_base=1800,
                retry_cap=21600,
            )
            self.store._meta_set("kb_next_build_at:example", "2020-01-01T00:00:00Z")
        self.assertEqual(self.store._meta_get("kb_failures:example"), "2")
        result = kb.kb_build_pass(
            self.store,
            summarizer=self._composer(),
            emit=None,
            debounce_seconds=0,
            retry_base=1800,
            retry_cap=21600,
        )
        self.assertEqual(result["built"], 1)
        self.assertEqual(self.store._meta_get("kb_failures:example"), "", "the streak clears")
        # A failure after recovery waits the base window again, so a
        # healthy stretch cannot inherit the last outage's cap.
        self._deliberate("m2", "example", "its followup", "2026-11-02T00:00:00Z")
        before = time.time()
        released = kb.kb_build_pass(
            self.store,
            summarizer=lambda *a, **k: None,
            emit=None,
            debounce_seconds=0,
            retry_base=1800,
            retry_cap=21600,
        )
        after = time.time()
        self.assertEqual(released["released"], 1)
        self._ladder_stamp("example", 1800, before, after)

    def test_the_ladder_resets_after_k_releases_without_progress(self):
        # The deadlock guard: a landed build is the only cursor movement
        # and it also clears the failure counter, so the streak IS the
        # no-progress run. Past reset_every consecutive releases the
        # window falls back to base — a stuck project keeps attempting
        # on a sane cadence instead of pinning at the cap — while the
        # counter keeps growing for the alarm.
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        for delay in (1800, 3600, 7200, 14400, 1800):
            before = time.time()
            result = kb.kb_build_pass(
                self.store,
                summarizer=lambda *a, **k: None,
                emit=None,
                debounce_seconds=0,
                retry_base=1800,
                retry_cap=21600,
                reset_every=5,
                alarm_at=100,
            )
            after = time.time()
            self.assertEqual(result["released"], 1)
            self._ladder_stamp("example", delay, before, after)
            self.store._meta_set("kb_next_build_at:example", "2020-01-01T00:00:00Z")
        self.assertEqual(
            self.store._meta_get("kb_failures:example"),
            "5",
            "the counter keeps growing — the alarm reads it",
        )

    def test_the_alarm_names_the_project_and_count_at_the_threshold(self):
        # The pending_backlog lesson: an unwired alarm is how the
        # consolidation freeze hid for 28 days. Below the threshold the
        # pass stays quiet; at it, every release prints a loud line
        # naming the project and its count.
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        for _ in range(2):
            quiet = io.StringIO()
            with contextlib.redirect_stdout(quiet):
                kb.kb_build_pass(
                    self.store,
                    summarizer=lambda *a, **k: None,
                    emit=None,
                    debounce_seconds=0,
                    retry_base=1800,
                    retry_cap=21600,
                    reset_every=100,
                    alarm_at=3,
                )
            self.assertNotIn("KB RELEASE ALARM", quiet.getvalue())
            self.store._meta_set("kb_next_build_at:example", "2020-01-01T00:00:00Z")
        loud = io.StringIO()
        with contextlib.redirect_stdout(loud):
            kb.kb_build_pass(
                self.store,
                summarizer=lambda *a, **k: None,
                emit=None,
                debounce_seconds=0,
                retry_base=1800,
                retry_cap=21600,
                reset_every=100,
                alarm_at=3,
            )
        out = loud.getvalue()
        self.assertIn("KB RELEASE ALARM", out)
        self.assertIn("example", out)
        self.assertIn("3 consecutive", out)

    def test_a_same_second_burst_folds_across_passes(self):
        # The composite cursor (timestamp + row id) makes the chunk cap cut
        # deterministically: rows sharing one timestamp all fold across
        # passes instead of the timestamp-only tail being lost forever.
        # One batch per pass pins the pass-level batching out of the way —
        # this test is the chunk cap's.
        stamp = "2026-11-01T00:00:00Z"
        for i in range(130):
            self._deliberate(f"m{i:03d}", "example", f"fact {i}", stamp)
        first = kb.kb_build_pass(
            self.store,
            summarizer=self._composer(),
            emit=None,
            debounce_seconds=0,
            batch_cap=1,
        )
        second = kb.kb_build_pass(
            self.store,
            summarizer=self._composer(),
            emit=None,
            debounce_seconds=0,
            batch_cap=1,
        )
        self.assertEqual(first["built"], 1)
        self.assertEqual(second["built"], 1)
        covered = []
        for row in self.store.conn.execute(
            "SELECT inputs FROM knowledge_base WHERE project = 'example' ORDER BY build_seq"
        ):
            covered.extend(json.loads(row["inputs"]))
        self.assertEqual(len(covered), 130, "every same-second row folded exactly once")
        self.assertEqual(len(set(covered)), 130)

    def test_the_fold_prompt_respects_its_char_budget(self):
        # The budget lives in the scan and cuts the NEWEST tail: the fold
        # walks a large delta oldest-first, and overflow rows stay fresh
        # for the next pass — lossless. The budget measures row content;
        # the recency prefixes render on top. One batch per pass and the
        # scan-level budget pinned: this test is delta_scan's cut; the
        # pass-level slice and its batching have their own tests.
        big = "y" * 7000
        self._deliberate("m1", "example", big, "2026-11-01T00:00:00Z")
        self._deliberate("m2", "example", big, "2026-11-02T00:00:00Z")
        self._deliberate("m3", "example", "the newest small fact", "2026-11-03T00:00:00Z")
        first = kb.kb_build_pass(
            self.store,
            summarizer=self._composer(),
            emit=None,
            debounce_seconds=0,
            batch_cap=1,
            fold_budget=12000,
        )
        self.assertEqual(first["built"], 1)
        self.assertEqual(self.calls[0][2], [f"[2026-11-01T00:00:00Z] {big}"])
        self.assertEqual(self.store.kb_current("example")[0]["inputs"], ["m1"])
        second = kb.kb_build_pass(
            self.store,
            summarizer=self._composer(),
            emit=None,
            debounce_seconds=0,
            batch_cap=1,
            fold_budget=12000,
        )
        self.assertEqual(second["built"], 1)
        self.assertEqual(
            self.calls[1][2],
            ["[2026-11-02T00:00:00Z] " + big, "[2026-11-03T00:00:00Z] the newest small fact"],
        )
        self.assertEqual(
            self.store.kb_current("example")[0]["inputs"], ["m2", "m3"], "nothing lost"
        )
        third = kb.kb_build_pass(
            self.store,
            summarizer=self._composer(),
            emit=None,
            debounce_seconds=0,
            batch_cap=1,
            fold_budget=12000,
        )
        self.assertEqual(third["built"], 0, "the delta is drained")

    def test_a_long_backlog_folds_in_bounded_batches(self):
        # The compose deadlock (a work deployment, Nov 2026: 365 releases, the
        # cursor pinned at 2026-09-23): one compose call carrying the
        # whole delta over-asks the model, the over-length draft
        # releases, and the ladder backs off forever. Batches: each call
        # folds a character-bounded slice — measured on the rendered
        # lines, not the row count — lands, moves the cursor; the next
        # batch re-scans past it until the delta drains.
        for i in range(30):
            self._deliberate(f"m{i:02d}", "example", "z" * 500, f"2026-11-01T00:{i:02d}:00Z")
        result = kb.kb_build_pass(
            self.store,
            summarizer=self._composer(),
            emit=None,
            debounce_seconds=0,
            fold_budget=4000,
            batch_cap=8,
        )
        self.assertEqual(
            result["built"], 5, "30 rows x 523 rendered chars at 4000/batch: 7+7+7+7+2"
        )
        self.assertEqual(len(self.calls), 5)
        for _, _, lines, _ in self.calls:
            self.assertLessEqual(sum(len(line) for line in lines), 4000)
        covered = []
        for row in self.store.conn.execute(
            "SELECT inputs FROM knowledge_base WHERE project = 'example' ORDER BY build_seq"
        ):
            covered.extend(json.loads(row["inputs"]))
        self.assertEqual(
            covered,
            [f"m{i:02d}" for i in range(30)],
            "every row folded exactly once, oldest first, cursor advancing per batch",
        )
        self.assertEqual(self.store._meta_get("kb_cursor:example"), "2026-11-01T00:29:00Z|m29")

    def test_the_batch_cap_defers_the_drain_to_the_next_pass(self):
        # The cap bounds one pass's LLM spend per project — a month-long
        # backlog must not hold the daemon's tick thread for an hour of
        # compose calls. The cursor keeps every landed batch; the next
        # scheduled pass continues the drain.
        for i in range(30):
            self._deliberate(f"m{i:02d}", "example", "z" * 500, f"2026-11-01T00:{i:02d}:00Z")
        first = kb.kb_build_pass(
            self.store,
            summarizer=self._composer(),
            emit=None,
            debounce_seconds=0,
            fold_budget=4000,
            batch_cap=2,
        )
        self.assertEqual(first["built"], 2, "the pass stops at the cap with backlog standing")
        self.assertEqual(self.store._meta_get("kb_cursor:example"), "2026-11-01T00:13:00Z|m13")
        second = kb.kb_build_pass(
            self.store,
            summarizer=self._composer(),
            emit=None,
            debounce_seconds=0,
            fold_budget=4000,
            batch_cap=2,
        )
        self.assertEqual(second["built"], 2, "the next scheduled pass continues the drain")
        self.assertEqual(len(self.calls), 4)

    def test_a_cap_limited_pass_stamps_no_debounce(self):
        # The debounce protects fresh bursts from over-frequent
        # rebuilds; a pass that ended on the batch cap is mid-drain of
        # old rows, so it stamps nothing — the next scheduler pass
        # continues the drain within a minute instead of waiting the
        # window out. A drained pass stamps as before.
        for i in range(30):
            self._deliberate(f"m{i:02d}", "example", "z" * 500, f"2026-11-01T00:{i:02d}:00Z")
        for expected in (2, 2):
            result = kb.kb_build_pass(
                self.store,
                summarizer=self._composer(),
                emit=None,
                debounce_seconds=1800,
                fold_budget=4000,
                batch_cap=2,
            )
            self.assertEqual(result["built"], expected)
            self.assertIsNone(
                self.store._meta_get("kb_next_build_at:example"),
                "the cap-limited pass stamps no debounce",
            )
        third = kb.kb_build_pass(
            self.store,
            summarizer=self._composer(),
            emit=None,
            debounce_seconds=1800,
            fold_budget=4000,
            batch_cap=2,
        )
        self.assertEqual(third["built"], 1, "the last batch drains")
        self.assertTrue(
            self.store._meta_get("kb_next_build_at:example"),
            "the drained pass stamps the success debounce again",
        )

    def test_a_release_mid_backlog_keeps_the_landed_batches(self):
        # A release then means one small batch failed: batches already
        # landed stand, the retry window stamps, and the rest of the
        # backlog stays past the cursor for the retry.
        for i in range(30):
            self._deliberate(f"m{i:02d}", "example", "z" * 500, f"2026-11-01T00:{i:02d}:00Z")

        def fail_from_the_second_batch(project, prior_doc, lines, evictions):
            self.calls.append((project, prior_doc, lines, evictions))
            if len(self.calls) > 1:
                raise RuntimeError("route down")
            return "sheet one"

        result = kb.kb_build_pass(
            self.store,
            summarizer=fail_from_the_second_batch,
            emit=None,
            debounce_seconds=0,
            fold_budget=4000,
            batch_cap=8,
            retry_base=1800,
            retry_cap=21600,
        )
        self.assertEqual(result["built"], 1)
        self.assertEqual(result["released"], 1)
        standing = self.store.kb_current("example")
        self.assertEqual(len(standing), 1)
        self.assertEqual(standing[0]["inputs"], [f"m{i:02d}" for i in range(7)])
        self.assertEqual(self.store._meta_get("kb_cursor:example"), "2026-11-01T00:06:00Z|m06")
        self.assertEqual(self.store._meta_get("kb_failures:example"), "1")
        self.assertTrue(self.store._meta_get("kb_next_build_at:example"))

    def test_evictions_ride_the_first_batch(self):
        # A landing consumes the evictions it was fed (PRJ-172), so they
        # ride the pass's first batch; later batches fold clean.
        self._deliberate("m1", "example", "the old claim", "2026-10-01T00:00:00Z")
        kb.kb_build_pass(self.store, summarizer=self._composer(), emit=None, debounce_seconds=0)
        self.store.forget("agent_memory", "m1")
        for i in range(10):
            self._deliberate(f"n{i:02d}", "example", "z" * 500, f"2026-11-01T00:{i:02d}:00Z")
        result = kb.kb_build_pass(
            self.store,
            summarizer=self._composer(),
            emit=None,
            debounce_seconds=0,
            fold_budget=2000,
            batch_cap=8,
        )
        self.assertEqual(result["built"], 4, "10 rows x 523 rendered chars at 2000/batch: 3+3+3+1")
        self.assertEqual(
            self.calls[1][3], [("m1", "the old claim")], "the eviction rides the first batch"
        )
        for _, _, _, evictions in self.calls[2:]:
            self.assertEqual(evictions, [], "later batches fold clean")
        self.assertEqual(kb._consumed_evictions(self.store, "example"), {"m1"})

    def test_a_row_over_the_fold_budget_still_folds_alone(self):
        # The slice never strands a row: a single row bigger than the
        # budget folds alone (cutting it would strand its content past
        # the cursor forever), and the loop terminates — the cursor
        # advances past it and the next batch takes the tail.
        self._deliberate("m1", "example", "z" * 9000, "2026-11-01T00:00:00Z")
        self._deliberate("m2", "example", "a small fact", "2026-11-02T00:00:00Z")
        result = kb.kb_build_pass(
            self.store,
            summarizer=self._composer(),
            emit=None,
            debounce_seconds=0,
            fold_budget=100,
            batch_cap=8,
        )
        self.assertEqual(result["built"], 2, "the over-budget row folds alone, then the tail")
        self.assertEqual(self.calls[0][2], ["[2026-11-01T00:00:00Z] " + "z" * 9000])
        self.assertEqual(self.calls[1][2], ["[2026-11-02T00:00:00Z] a small fact"])
        self.assertEqual(self.store._meta_get("kb_cursor:example"), "2026-11-02T00:00:00Z|m2")

    def test_the_standing_doc_covers_a_lost_cursor_full_rescan(self):
        # The cursor is performance-only: deleting it re-folds the whole
        # pool, and the standing doc's coverage only grows — the recovery
        # tool for the documented seq race.
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        kb.kb_build_pass(self.store, summarizer=self._composer(), emit=None, debounce_seconds=0)
        self.store.conn.execute("DELETE FROM store_meta WHERE key = 'kb_cursor:example'")
        self.store.conn.commit()
        kb.kb_build_pass(self.store, summarizer=self._composer(), emit=None, debounce_seconds=0)
        second = self.store.kb_current("example")
        self.assertEqual(second[0]["inputs"], ["m1"], "the full re-scan folds the same pool")
        self.assertEqual(second[0]["build_seq"], 2)

    def test_an_emit_failure_lands_the_version_on_the_pending_list(self):
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")

        def refuse(kind, payload, record_id=None):
            return False

        kb.kb_build_pass(self.store, summarizer=self._composer(), emit=refuse, debounce_seconds=0)
        version = self.store.kb_current("example")[0]
        self.assertEqual(self.store._meta_get("kb_unshipped"), version["id"])
        # The next pass re-emits the standing version and clears the list.
        shipped: list = []

        def accept(kind, payload, record_id=None):
            shipped.append(payload["id"])
            return True

        kb.kb_build_pass(self.store, summarizer=self._composer(), emit=accept, debounce_seconds=0)
        self.assertEqual(shipped, [version["id"]])
        self.assertEqual(self.store._meta_get("kb_unshipped"), "")

    def test_two_machines_converge_on_the_standing_doc(self):
        # Both compose the same seq; the standing-winner rule (newest
        # created_at at the top seq) is deterministic on every machine.
        self._deliberate("m1", "example", "a fact", "2026-11-01T00:00:00Z")
        self.store.upsert_kb(
            {
                "id": "kb:example:1:aaa",
                "project": "example",
                "doc": "sheet from a client host",
                "inputs": ["m1"],
                "build_seq": 1,
                "created_at": "2026-11-01T01:00:00Z",
            }
        )
        self.store.upsert_kb(
            {
                "id": "kb:example:1:bbb",
                "project": "example",
                "doc": "sheet from a second client host",
                "inputs": ["m1"],
                "build_seq": 1,
                "created_at": "2026-11-01T02:00:00Z",
            }
        )
        current = self.store.kb_current("example")
        self.assertEqual(len(current), 1)
        self.assertEqual(
            current[0]["doc"], "sheet from a second client host", "newer composition stands"
        )
        self.assertEqual(current[0]["id"], "kb:example:1:bbb")
        # A lower seq arriving late never displaces the standing doc.
        self.store.upsert_kb(
            {
                "id": "kb:example:0:zzz",
                "project": "example",
                "doc": "stale",
                "inputs": [],
                "build_seq": 0,
                "created_at": "2026-11-01T09:00:00Z",
            }
        )
        self.assertEqual(self.store.kb_current("example")[0]["id"], "kb:example:1:bbb")


class KbComposeTests(unittest.TestCase):
    """compose_via_llm's own surface: the compress-to-fit last resort.
    The pass's injected-summarizer contract stays untouched — these pin
    the real production path with the route patched out."""

    def _route(self, docs: list[str | None]) -> list[str]:
        """Patch the shared route to return `docs` in order and record
        the prompts it was asked."""
        prompts: list[str] = []
        replies = iter(docs)

        def fake(prompt, base_url=None, model=None, timeout=None, label="kb"):
            prompts.append(prompt)
            return next(replies)

        patcher = mock.patch.object(kb, "_chat_completion", fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        return prompts

    def test_an_over_length_draft_is_re_asked_to_fit(self):
        draft = "x" * 7000
        cut = "y" * 5000
        prompts = self._route([draft, cut])
        doc = kb.compose_via_llm("example", "prior", ["[2026-11-01T00:00:00Z] a fact"])
        self.assertEqual(doc, cut)
        self.assertEqual(len(prompts), 2)
        self.assertIn(draft, prompts[1], "the re-ask carries the over-length draft")
        self.assertIn("under 6000", prompts[1], "the re-ask carries the cut-to-N instruction")

    def test_compress_retries_are_bounded_then_the_draft_returns_intact(self):
        draft = "x" * 7000
        prompts = self._route([draft, draft, draft])
        doc = kb.compose_via_llm("example", "", [])
        self.assertEqual(
            doc,
            draft,
            "the over-length draft returns as-is: the pass releases it — truncation never ships",
        )
        self.assertEqual(len(prompts), 3, "the initial fold plus two bounded compress re-asks")

    def test_a_compliant_draft_is_never_re_asked(self):
        prompts = self._route(["the sheet"])
        doc = kb.compose_via_llm("example", "", [])
        self.assertEqual(doc, "the sheet")
        self.assertEqual(len(prompts), 1)


class KnobTests(unittest.TestCase):
    """The knob parsers: malformed, empty, zero and negative values fall
    back to the default loudly, so a set-but-broken knob cannot take the
    pass with a silent no-op or crash it mid-loop; an explicitly-passed
    argument gets the same treatment."""

    NAME = "MEMORY_KB_TEST_KNOB"

    def _knob(self, raw: str | None, default: int, minimum: int = 1) -> tuple[int, str]:
        out = io.StringIO()
        with mock.patch.dict(os.environ), contextlib.redirect_stdout(out):
            if raw is None:
                os.environ.pop(self.NAME, None)
            else:
                os.environ[self.NAME] = raw
            value = kb._int_knob(self.NAME, default, minimum)
        return value, out.getvalue()

    def test_int_knob_falls_back_loudly(self):
        for raw in ("abc", "", "   ", "0", "-4"):
            value, out = self._knob(raw, 8)
            self.assertEqual(value, 8, f"raw={raw!r}")
            self.assertIn(self.NAME, out, f"raw={raw!r}")
            self.assertIn("ignored", out, f"raw={raw!r}")
        value, out = self._knob(None, 8)
        self.assertEqual(value, 8)
        self.assertEqual(out, "", "a missing knob is silent")
        value, out = self._knob(" 7 ", 8)
        self.assertEqual(value, 7)
        self.assertEqual(out, "")

    def test_int_knob_enforces_its_floor(self):
        # MEMORY_KB_RETRY_RESET=1 would flat-line the ladder at the base
        # window — the fixed cadence PRJ-256 exists to prevent — so the
        # reset knob's floor is 2 and values below it fall back loudly.
        value, out = self._knob("1", 5, minimum=2)
        self.assertEqual(value, 5)
        self.assertIn("ignored", out)
        value, out = self._knob("2", 5, minimum=2)
        self.assertEqual(value, 2)
        self.assertEqual(out, "")

    def test_an_explicit_argument_gets_the_same_validation(self):
        for bad, minimum in ((0, 1), (-2, 1), (1, 2), ("8", 1)):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                value = kb._checked_int(bad, self.NAME, 8, minimum=minimum)
            self.assertEqual(value, 8, f"arg={bad!r}")
            self.assertIn("ignored", out.getvalue(), f"arg={bad!r}")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            value = kb._checked_int(3, self.NAME, 8)
        self.assertEqual(value, 3)
        self.assertEqual(out.getvalue(), "")


class KbWireTests(unittest.TestCase):
    def test_a_kb_record_round_trips_validation(self):
        record = {
            "record_id": "r1",
            "machine_id": "hal",
            "kind": "knowledge_base",
            "occurred_at": "2026-11-05T00:00:00Z",
            "payload": {
                "id": "kb:example:1:abc",
                "project": "example",
                "doc": "the sheet",
                "inputs": ["m1"],
                "build_seq": 1,
                "created_at": "2026-11-05T00:00:00Z",
            },
        }
        self.assertIsNone(validate_record(record))

    def test_wire_rejects_malformed_kb_payloads(self):
        base = {
            "record_id": "r1",
            "machine_id": "hal",
            "kind": "knowledge_base",
            "occurred_at": "2026-11-05T00:00:00Z",
        }
        cases = [
            (
                {"doc": "d"},
                "knowledge_base payload must carry an id",
            ),
            (
                {"id": "kb:example:1:a", "doc": "d"},
                "knowledge_base payload must carry a project",
            ),
            (
                {"id": "kb:example:1:a", "project": "example"},
                "knowledge_base payload must carry a doc",
            ),
            (
                {"id": "kb:example:1:a", "project": "example", "doc": "d", "inputs": "m1"},
                "knowledge_base payload inputs must be an array of row ids",
            ),
            (
                {"id": "kb:example:1:a", "project": "example", "doc": "d", "inputs": []},
                "knowledge_base payload build_seq must be a positive integer",
            ),
            (
                {
                    "id": "kb:example:1:a",
                    "project": "example",
                    "doc": "d",
                    "inputs": [],
                    "build_seq": 1,
                },
                "knowledge_base payload created_at must be a non-empty string",
            ),
            (
                {
                    "id": "kb:example:1:a",
                    "project": "example",
                    "doc": "x" * 6001,
                    "inputs": [],
                    "build_seq": 1,
                    "created_at": "2026-11-05T00:00:00Z",
                },
                "knowledge_base payload doc exceeds 6000 characters",
            ),
        ]
        for payload, expected in cases:
            self.assertEqual(validate_record({**base, "payload": payload}), expected, payload)

    def test_a_kb_record_applies_through_the_hub(self):
        # Hub-shaped round trip: a record from another machine lands the
        # version on this machine's table, ready for kb_current.
        store = make_store(tempfile.mkdtemp())
        self.addCleanup(store.close)
        client = SyncClient(
            store,
            hub_url="http://hub.invalid",
            machine_id="hal",
            queue_dir=tempfile.mkdtemp(),
        )
        record = {
            "record_id": "r1",
            "machine_id": "client-host-2",
            "kind": "knowledge_base",
            "occurred_at": "2026-11-05T00:00:00Z",
            "payload": {
                "id": "kb:example:1:abc",
                "project": "example",
                "doc": "the sheet",
                "inputs": ["m1"],
                "build_seq": 1,
                "created_at": "2026-11-05T00:00:00Z",
            },
        }
        client.apply(record)
        current = store.kb_current("example")
        self.assertEqual(current[0]["doc"], "the sheet")
        self.assertEqual(current[0]["inputs"], ["m1"])


class KbReadVerbTests(unittest.TestCase):
    def test_memory_kb_reads_the_standing_doc(self):
        store = make_store(tempfile.mkdtemp())
        self.addCleanup(store.close)
        tools = Tools(store, "testbox")
        session = store.get_or_create_session("hal", "opencode", "ses_1", "example")
        store.upsert_agent(
            {
                "id": "m1",
                "session_id": session,
                "content": "a fact",
                "timestamp": "2026-11-01T00:00:00Z",
                "repo": "example",
            }
        )
        store.upsert_kb(
            {
                "id": "kb:example:1:a",
                "project": "example",
                "doc": "the standing sheet",
                "inputs": ["m1"],
                "build_seq": 1,
                "created_at": "2026-11-05T00:00:00Z",
            }
        )
        got = tools.knowledge_read(project="example")
        self.assertEqual(got["status"], "ok")
        self.assertEqual(got["docs"][0]["doc"], "the standing sheet")
        everything = tools.knowledge_read()
        self.assertEqual([d["project"] for d in everything["docs"]], ["example"])


class EvictionConsumptionTests(unittest.TestCase):
    """An eviction feeds exactly one landed build (PRJ-172): the forget
    that enacts a moved ruling enacts once; without the consumption mark
    a mass tombstone (the correction split) re-feeds every pass and
    keeps every debounce window a non-skip for the project."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = make_store(self.tmp)

    def tearDown(self):
        self.store.close()

    def _build_with_folded_row(self):
        self._deliberate = None
        session = self.store.get_or_create_session("hal", "opencode", "ses_a", "example")
        self.store.upsert_agent(
            {
                "id": "mx1",
                "session_id": session,
                "content": "the deploy gate rides the staging lane",
                "timestamp": "2026-11-01T00:00:00Z",
                "repo": "example",
            }
        )
        # First build folds it; the standing doc carries the claim.
        first = kb.kb_build_pass(
            self.store, summarizer=lambda *a, **k: "gate: staging.", emit=None, debounce_seconds=0
        )
        self.assertEqual(first["built"], 1)
        # The correction split moves the row: tombstone-with-content.
        self.store.forget("agent_memory", "mx1")
        self.store.conn.execute(
            "UPDATE forget_tombstones SET content = ? WHERE row_id = 'mx1'",
            ("the deploy gate rides the staging lane",),
        )
        self.store.conn.commit()

    def test_eviction_feeds_one_build_then_the_pass_skips(self):
        self._build_with_folded_row()
        second = kb.kb_build_pass(
            self.store, summarizer=lambda *a, **k: "gate: gone.", emit=None, debounce_seconds=0
        )
        self.assertEqual(second["built"], 1, "the eviction pass must run once")
        third = kb.kb_build_pass(
            self.store, summarizer=lambda *a, **k: "gate: again?", emit=None, debounce_seconds=0
        )
        self.assertEqual(third["skipped"], 1, "consumed evictions must not re-feed")

    def test_consumption_only_lands_on_a_successful_build(self):
        self._build_with_folded_row()

        # A released eviction (chain failure) must NOT mark consumed.
        def failing(*a, **k):
            raise RuntimeError("chain down")

        released = kb.kb_build_pass(self.store, summarizer=failing, emit=None, debounce_seconds=0)
        self.assertEqual(released["released"], 1)
        still = kb._consumed_evictions(self.store, "example")
        self.assertEqual(still, set())
