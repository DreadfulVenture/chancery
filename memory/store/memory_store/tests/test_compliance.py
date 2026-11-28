"""Compliance ladder (PRD 20261104, PRJ-179): the daemon owns every
decision from two thin events — an active turn arrived, or the agent
pulled. The state machine is turn arithmetic only, so the tests never
pass prompt text: a body with none behaves identically to one with any,
which is the nothing-content-matched constraint made structural. The
journal records every escalation with its outcome, and the aggregates
are what the operator's tier-removal review reads."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.server import daemon  # noqa: E402
from memory_store import spans  # noqa: E402
from memory_store.server.daemon import DaemonState, RecordEmittingTools  # noqa: E402
from memory_store.store import Store  # noqa: E402
from memory_store.sync import SyncClient  # noqa: E402
from memory_store.tools import ToolError, Tools  # noqa: E402


class ComplianceFixture:
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="compliance-test-")
        self.store = Store(os.path.join(self.tmp, "memory.db"))
        self.store.vec_available = False
        self.sync = SyncClient(
            self.store,
            "http://hub.invalid",
            "test-machine",
            queue_dir=os.path.join(self.tmp, "queue"),
        )
        self.tools = RecordEmittingTools(
            self.store, "test-machine", self.sync, os.path.join(self.tmp, "floor.md")
        )
        self.state = DaemonState(self.store, self.tools, self.sync)
        self.report_tools = Tools(self.store, "test-machine")


def events(store: Store) -> list[dict]:
    return [
        dict(row)
        for row in store.conn.execute("SELECT * FROM compliance_events ORDER BY id").fetchall()
    ]


class LadderTests(unittest.TestCase):
    def setUp(self):
        self.fixture = ComplianceFixture()
        self.store = self.fixture.store
        self.state = self.fixture.state

    def tearDown(self):
        self.store.close()

    def turns(self, conversation_id, n, body=None):
        """Drive n active turns, returning the replies."""
        base = {"type": "turn", "app": "opencode", "conversation_id": conversation_id}
        if body:
            base.update(body)
        return [self.state.compliance(dict(base)) for _ in range(n)]

    def pull(self, conversation_id, tool="memory_recall"):
        return self.state.compliance(
            {
                "type": "pull",
                "app": "opencode",
                "conversation_id": conversation_id,
                "tool": tool,
            }
        )

    def test_the_first_tier_fires_only_at_the_threshold(self):
        replies = self.turns("conv1", daemon.LADDER_FIRST_AT)
        before = [reply for reply in replies[:-1]]
        fired = replies[-1]
        self.assertTrue(all(not reply["reminder"] for reply in before))
        self.assertIn(f"level 1 of {len(daemon.COMPLIANCE_TIERS)}", fired["reminder"])
        self.assertEqual(fired["level"], 1)
        self.assertIn(daemon.COMPLIANCE_HEADING, fired["section"])

    def test_fewer_than_threshold_turns_stay_silent(self):
        replies = self.turns("conv1", daemon.LADDER_FIRST_AT - 1)
        self.assertTrue(all(not reply["reminder"] for reply in replies))
        self.assertEqual(events(self.store), [])

    def test_silence_escalates_through_the_tiers(self):
        replies = self.turns("conv1", daemon.LADDER_FIRST_AT + 2 * daemon.LADDER_EVERY)
        levels = [reply["level"] for reply in replies]
        fired = [levels[i] for i in range(len(levels)) if levels[i] > (levels[i - 1] if i else 0)]
        self.assertEqual(fired, [1, 2, 3], "each tier fired exactly once, in order")
        self.assertEqual(max(levels), 3)

    def test_past_the_last_tier_the_ladder_goes_quiet(self):
        replies = self.turns("conv1", 40)
        levels = [reply["level"] for reply in replies]
        fired = [levels[i] for i in range(len(levels)) if levels[i] > (levels[i - 1] if i else 0)]
        self.assertEqual(fired, [1, 2, 3])
        # The counter keeps counting honestly, but nothing more arrives.
        last = replies[-1]
        self.assertEqual(last["active_turns"], 40)
        self.assertFalse(last["reminder"])

    def test_a_plain_pull_resets_the_ladder(self):
        self.turns("conv1", daemon.LADDER_FIRST_AT)
        self.pull("conv1")
        state = self.store.compliance_state_for("conv1")
        self.assertEqual(state["active_turns"], 0)
        self.assertEqual(state["total_pulls"], 1)
        self.assertEqual(state["level"], 0)
        # A fresh stretch of silence starts the ladder over.
        replies = self.turns("conv1", daemon.LADDER_FIRST_AT)
        self.assertEqual([reply["level"] for reply in replies if reply["level"]], [1])
        self.assertEqual([event["level"] for event in events(self.store)], [1, 1])

    def test_the_pull_closes_pending_escalations_with_their_time_to_recall(self):
        # Two turns of silence past the tier-1 fire, then the pull: the
        # escalation waited two active turns.
        self.turns("conv1", daemon.LADDER_FIRST_AT + 2)
        self.pull("conv1")
        (event,) = events(self.store)
        self.assertEqual(event["outcome"], "recalled")
        self.assertEqual(event["turns_after"], 2)
        self.assertTrue(event["recalled_at"])
        state = self.store.compliance_state_for("conv1")
        self.assertEqual(state["total_turns"], 8)

    def test_an_ignored_escalation_expires_when_the_next_one_fires(self):
        replies = self.turns("conv1", daemon.LADDER_FIRST_AT + daemon.LADDER_EVERY)
        replies[-1]  # tier 2 fires at 12; tier 1's window closed the same turn
        by_level = {event["level"]: event["outcome"] for event in events(self.store)}
        self.assertEqual(by_level, {1: "expired", 2: "pending"})

    def test_a_pull_with_no_escalations_still_counts(self):
        self.turns("conv1", 2)
        self.pull("conv1")
        self.assertEqual(events(self.store), [])
        state = self.store.compliance_state_for("conv1")
        self.assertEqual(state["total_pulls"], 1)
        self.assertEqual(state["active_turns"], 0)

    def test_the_parity_of_window_and_interval_is_deliberate(self):
        # With the outcome window equal to the escalation interval, an
        # ignored tier 1 expires exactly when tier 2 fires — at most one
        # escalation is ever pending per conversation. The pull that closes
        # tier 2 records zero turns after it: the recall landed on the same
        # turn the escalation fired.
        self.turns("conv1", daemon.LADDER_FIRST_AT + daemon.LADDER_EVERY)
        self.pull("conv1")
        by_level = {event["level"]: event for event in events(self.store)}
        self.assertEqual(by_level[1]["outcome"], "expired")
        self.assertEqual(by_level[2]["outcome"], "recalled")
        self.assertEqual(by_level[2]["turns_after"], 0)

    def test_the_pull_set_matches_the_daemons_definition(self):
        # A write is not a pull: the daemon re-validates membership on the
        # canonical name, so a client cannot widen the set in a payload.
        self.turns("conv1", 2)
        self.pull("conv1", tool="memory_remember")
        state = self.store.compliance_state_for("conv1")
        self.assertEqual(state["total_pulls"], 0)
        self.assertEqual(state["active_turns"], 2, "silence kept counting")
        self.assertEqual(state["last_pull_at"], None)

    def test_the_canonical_name_rides_behind_the_client_decoration(self):
        self.state.compliance(
            {
                "type": "pull",
                "app": "opencode",
                "conversation_id": "conv-decorated",
                "tool": "memory_memory_recall",
            }
        )
        self.assertEqual(self.store.compliance_state_for("conv-decorated")["total_pulls"], 1)

    def test_the_route_requires_an_event_kind_and_a_conversation(self):
        with self.assertRaises(ToolError):
            self.state.compliance({"type": "nudge", "conversation_id": "c"})
        with self.assertRaises(ToolError):
            self.state.compliance({"type": "turn"})

    def test_decisions_never_depend_on_content(self):
        # The bodies carry no prompt field — the contract is turn counts in,
        # tier timing out. Sending extra text changes nothing, which is the
        # nothing-content-matched constraint asserted, not documented.
        contentful = {"prompt": "the drain re-runs batch 7 and wedges", "cwd": "/tmp"}
        replies_a = [r["level"] for r in self.turns("conv-a", 12)]
        replies_b = [r["level"] for r in self.turns("conv-b", 12, body=contentful)]
        self.assertEqual(replies_a, replies_b)

    def test_the_turn_decision_is_observable_at_debug(self):
        # The span is the audit receipt: what the conversation had reached,
        # what expired, what fired — with no content in it, because nothing
        # content-shaped ever entered the decision.
        lines: list[str] = []
        spans.sink(lines.append)
        try:
            with mock.patch.object(spans, "MIN_LEVEL", spans._LEVELS["debug"]):
                self.turns("conv1", daemon.LADDER_FIRST_AT)
        finally:
            spans.pop_sink(lines.append)
        decisions = [line for line in lines if "op=compliance" in line]
        self.assertTrue(any("kind=turn" in line for line in decisions), lines)
        self.assertTrue(any("level=1" in line for line in decisions), decisions)

    def test_turns_never_grow_an_unbounded_process_state(self):
        # The ladder's whole state is the store: nothing per conversation
        # lives on the DaemonState, so long-running process memory stays flat.
        before = set(vars(self.state))
        for index in range(600):
            self.turns(f"conv{index}", 1)
        self.assertEqual(set(vars(self.state)), before)

    def test_the_ladder_never_queues_a_sync_record(self):
        # Local-only, the same class as tool_fires: per-machine client
        # conversations are history, not shared row state. Sync is
        # push-by-enqueue, so the exclusion is structural — this asserts it.
        self.turns("conv1", daemon.LADDER_FIRST_AT + daemon.LADDER_EVERY * 2)
        self.pull("conv1")
        self.fixture.report_tools.compliance_report()
        queued = "".join(
            Path(os.path.join(self.fixture.tmp, "queue", name)).read_text()
            for name in os.listdir(os.path.join(self.fixture.tmp, "queue"))
            if name.endswith(".jsonl")
        )
        self.assertEqual(queued, "", "telemetry reached an outbound sync queue")


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.fixture = ComplianceFixture()
        self.store = self.fixture.store
        self.state = self.fixture.state
        self.tools = self.fixture.report_tools

    def tearDown(self):
        self.store.close()

    def test_the_report_surveys_conversations_events_and_levels(self):
        self.state.compliance({"type": "turn", "app": "opencode", "conversation_id": "pulled"})
        self.state.compliance(
            {
                "type": "pull",
                "app": "opencode",
                "conversation_id": "pulled",
                "tool": "memory_recall",
            }
        )
        self.state.compliance({"type": "turn", "app": "cursor", "conversation_id": "silent"})
        for _ in range(daemon.LADDER_FIRST_AT):
            self.state.compliance({"type": "turn", "app": "cursor", "conversation_id": "ladder"})
        self.state.compliance(
            {"type": "pull", "app": "cursor", "conversation_id": "ladder", "tool": "knowledge_read"}
        )
        report = self.tools.compliance_report()
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["conversations"]["observed"], 3)
        self.assertEqual(report["conversations"]["with_pulls"], 2)
        self.assertEqual(report["events"]["total"], 1)
        self.assertEqual(report["events"]["max_level"], 1)
        (level,) = report["by_level"]
        self.assertEqual(level["level"], 1)
        self.assertEqual(level["fired"], 1)
        self.assertEqual(level["recalled"], 1)

    def test_the_window_limits_events_but_not_conversations(self):
        # One event long dead (the journal keeps its escalated_at), two
        # fresh ones from live reporting.
        self.store.conn.execute(
            """INSERT INTO compliance_events
                   (conversation_id, app, machine, level, turns_at_fire, escalated_at)
                   VALUES ('old', 'opencode', 'test-machine', 3, 18, '2020-01-01T00:00:00Z')"""
        )
        for _ in range(daemon.LADDER_FIRST_AT + daemon.LADDER_EVERY):
            self.state.compliance({"type": "turn", "app": "opencode", "conversation_id": "w1"})
        all_time = self.tools.compliance_report()
        self.assertEqual(all_time["events"]["total"], 3)
        self.assertEqual(all_time["events"]["max_level"], 3)
        today = self.tools.compliance_report(window_days=0)
        self.assertEqual(today["events"]["total"], 2)
        self.assertEqual(today["events"]["max_level"], 2)
        self.assertEqual(today["conversations"]["observed"], 1)


if __name__ == "__main__":
    unittest.main()
