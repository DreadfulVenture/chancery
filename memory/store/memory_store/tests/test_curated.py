"""Tests for the curated machinery: matcher, suppression, floor render."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.curated import refresh_projection, render_floor, rule_search
from memory_store.store import Store


def vec_of(text):
    vocabulary = ["commit", "deploy", "review", "zebra"]
    low = text.lower()
    return [float(low.count(w)) for w in vocabulary]


class MatcherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "c.db")
        self.store.upsert_situational(
            {
                "id": 1,
                "situation": "about to commit changes to the repo",
                "statement": "run the checks before committing",
                "grader": "agent",
                "stance": "prescriptive",
            }
        )
        self.store.upsert_situational(
            {
                "id": 2,
                "situation": "deploying to production host",
                "statement": "ask before deploying",
                "grader": "agent",
                "stance": "prescriptive",
            }
        )
        # Sibling duplicate of rule 1 (as if codified offline on another machine).
        self.store.upsert_situational(
            {
                "id": 3,
                "situation": "about to commit changes to the repository",
                "statement": "run checks before you commit",
                "grader": "agent",
                "stance": "prescriptive",
            }
        )

    def tearDown(self):
        self.store.close()

    def _search(self, situation, **kwargs):
        with mock.patch.object(
            self.store, "embed", side_effect=lambda texts, origin=None: [vec_of(t) for t in texts]
        ):
            return rule_search(self.store, situation, **kwargs)

    def test_matching_rule_returns(self):
        results = self._search("I am about to commit changes")
        self.assertTrue(any(r["id"] == 1 for r in results))

    def test_duplicate_situations_collapse(self):
        # Rules 1 and 3 have near-identical situations; only the strongest surfaces.
        results = self._search("about to commit changes to the repo", limit=5)
        surfaced_ids = {r["id"] for r in results}
        self.assertFalse(surfaced_ids == {1, 3})

    def test_non_matching_situation_returns_nothing(self):
        self.assertEqual(self._search("zebra crossing photography"), [])


class FloorRenderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "f.db")

    def tearDown(self):
        self.store.close()

    def _add(self, rule_id, statement, status="active", topic=""):
        self.store.upsert_persona(
            {"id": rule_id, "statement": statement, "status": status, "topic": topic}
        )

    def test_only_active_renders(self):
        self._add(1, "answer the question asked", status="active")
        self._add(2, "withdrawn rule", status="retired")
        floor = render_floor(self.store)
        self.assertIn("answer the question asked", floor)
        self.assertNotIn("withdrawn rule", floor)

    def test_rules_render_under_their_topic_alphabetically(self):
        self._add(1, "no history in comments", topic="comments")
        self._add(2, "answer the question asked", topic="communication")
        self._add(3, "branches are prefixed operator/", topic="git")
        self._add(4, "durable comments only", topic="comments")
        floor = render_floor(self.store)
        self.assertEqual(
            [line for line in floor.splitlines() if line.startswith("## ")],
            ["## Comments", "## Communication", "## Git"],
        )
        # Within a topic, id order.
        comments = floor.split("## Comments")[1].split("## Communication")[0]
        self.assertLess(comments.index("no history"), comments.index("durable comments"))

    def test_untopiced_rules_get_the_default_heading(self):
        self._add(1, "some standing rule")
        self.assertIn("## General", render_floor(self.store))

    def test_topic_case_and_spacing_fold_to_one_heading(self):
        self._add(1, "first", topic="Code  Review")
        self._add(2, "second", topic="code review")
        floor = render_floor(self.store)
        self.assertEqual(
            [line for line in floor.splitlines() if line.startswith("## ")], ["## Code Review"]
        )

    def test_render_is_deterministic(self):
        self._add(1, "rule one")
        self._add(2, "rule two")
        self._add(3, "rule three")
        first = render_floor(self.store)
        second = render_floor(self.store)
        self.assertEqual(first, second)

    def test_projection_writes_floor_and_rows(self):
        self._add(1, "projected rule")
        report = refresh_projection(self.store, str(Path(self.tmp) / "backup"))
        self.assertGreater(report["floor_chars"], 0)
        floor_path = Path(self.tmp) / "backup" / "memory-floor.md"
        self.assertIn("projected rule", floor_path.read_text())
        records = json.loads((Path(self.tmp) / "backup" / "curated-records.json").read_text())
        self.assertEqual(len(records["persona"]), 1)
        # Telemetry stays out of the projection.
        self.assertNotIn("apply_count", records["persona"][0])


if __name__ == "__main__":
    unittest.main()


class PullSearchTests(unittest.TestCase):
    """The agent-invoked ask (PRJ-172): pull-shaped gates on the same
    engine — borderline pairs still return, quiet rules surfaced, no
    telemetry written on a read."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "c.db")
        self.store.upsert_situational(
            {
                "id": 1,
                "situation": "about to commit changes to the repo",
                "statement": "run the checks before committing",
                "grader": "agent",
                "stance": "prescriptive",
            }
        )
        # A low-confidence rule: disconfirm-heavy grading.
        self.store.upsert_situational(
            {
                "id": 2,
                "situation": "deploying to production host",
                "statement": "ask before deploying",
                "grader": "agent",
                "stance": "prescriptive",
            }
        )
        self.store.apply_feedback(2, "situational", "disconfirm", 6)
        self.store.apply_feedback(2, "situational", "confirm", 1)

    def tearDown(self):
        self.store.close()

    def _search(self, situation, **kwargs):
        with mock.patch.object(
            self.store, "embed", side_effect=lambda texts, origin=None: [vec_of(t) for t in texts]
        ):
            return rule_search(self.store, situation, **kwargs)

    def test_pull_surfaces_low_confidence_marked_quiet(self):
        # Disconfirm-heavy rule 2 rides the pull marked quiet: low
        # confidence ranks it rather than dropping it.
        rules = self._search("deploying to production host")
        self.assertTrue(any(r["id"] == 2 and r["quiet"] for r in rules))
        row = self.store.conn.execute(
            "SELECT fire_count FROM situational_rules WHERE id = 2"
        ).fetchone()
        self.assertEqual(row["fire_count"], 0)

    def test_borderline_pairs_still_return(self):
        # A borderline pair just under the sibling-reconcile bar still
        # returns: relevance stays the caller's judgment.
        rules = self._search("commit changes", threshold=0.45)
        self.assertTrue(any(r["id"] == 1 for r in rules))

    def test_scope_boost_ranks_in_project_first(self):
        self.store.upsert_situational(
            {
                "id": 4,
                "situation": "about to commit changes to the repository now",
                "statement": "example-specific staging rule",
                "grader": "agent",
                "stance": "prescriptive",
                "scope": "example",
            }
        )
        rules = self._search("about to commit changes", limit=5, workspace="example")
        self.assertEqual(rules[0]["id"], 4)
        self.assertTrue(all(r.get("scope") is not None for r in rules))
