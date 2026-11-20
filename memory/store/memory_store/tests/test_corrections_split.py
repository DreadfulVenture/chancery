"""Tests for the correction-split pass (PRJ-172): classification rides an
injected fake, so every rule here is about the pass's mechanical shape —
in-place fact updates that keep ids and created_at, reconcile-before-author,
floor flagging, tombstone-through-forget, manifest reconciliation, and the
apply gate."""

from __future__ import annotations

import tempfile
import unittest
from unittest import mock
from pathlib import Path

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store import corrections_split
from memory_store.store import Store


def make_store(tmpdir: str) -> Store:
    return Store(Path(tmpdir) / "split.db")


def seed_correction(store: Store, row_id: str, repo: str, content: str, created: str) -> str:
    session = store.get_or_create_session("hal", "opencode", f"ses_{row_id}", repo)
    store.upsert_agent(
        {
            "id": row_id,
            "session_id": session,
            "content": content,
            "source": "correction",
            "timestamp": created,
            "repo": repo,
        }
    )
    return row_id


def classifier_of(mapping):
    def classify(rows):
        out = {}
        for row in rows:
            m = mapping.get(row["id"])
            if m is None:
                raise ValueError(f"classifier missing id {row['id']}")
            out[str(row["id"])] = m
        return out

    return classify


class SplitPassTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = make_store(self.tmp)

    def tearDown(self):
        self.store.close()

    def test_dry_run_writes_nothing(self):
        seed_correction(
            self.store,
            "m1",
            "example",
            "actually the deploy gate is the staging lane",
            "2026-10-01T00:00:00Z",
        )
        manifest = corrections_split.run(
            self.store,
            sync=None,
            classifier=classifier_of(
                {
                    "m1": {
                        "kind": "fact",
                        "content": "the deploy gate is the staging lane",
                        "source": "fact",
                    }
                }
            ),
            apply=False,
        )
        self.assertEqual(manifest["totals"], {"fact-update": 1})
        self.assertTrue(manifest["entries"][0]["dry"])
        row = self.store.conn.execute("SELECT content FROM agent_memory WHERE id = 'm1'").fetchone()
        self.assertEqual(
            row["content"],
            "actually the deploy gate is the staging lane",
            "dry run: original text stands",
        )

    def test_fact_update_keeps_id_and_created_at_and_rewords(self):
        seed_correction(
            self.store,
            "m2",
            "example",
            "Correction (the operator): it is the staging lane, not the deploy lane, that gates",
            "2026-10-02T00:00:00Z",
        )
        before = self.store.conn.execute(
            "SELECT created_at FROM agent_memory WHERE id = 'm2'"
        ).fetchone()["created_at"]
        manifest = corrections_split.run(
            self.store,
            apply=True,
            classifier=classifier_of(
                {
                    "m2": {
                        "kind": "fact",
                        "content": "the staging lane gates the deploy",
                        "source": "decision",
                    }
                }
            ),
        )
        self.assertEqual(manifest["totals"], {"fact-update": 1})
        row = self.store.conn.execute(
            "SELECT content, source, created_at FROM agent_memory WHERE id = 'm2'"
        ).fetchone()
        self.assertEqual(row["content"], "the staging lane gates the deploy")
        self.assertEqual(row["source"], "decision")
        self.assertEqual(row["created_at"], before, "created_at must survive the reword")

    def test_rule_authoring_reconciles_with_a_standing_rule(self):
        seed_correction(
            self.store,
            "m3",
            "example",
            "don't push without the explicit word",
            "2026-10-03T00:00:00Z",
        )
        rule_id = int(corrections_split.time.time_ns() % (10**9))
        self.store.upsert_situational(
            {
                "id": rule_id,
                "situation": "about to push any commit",
                "statement": "verify the destination first",
                "grader": "agent",
                "stance": "prescriptive",
                "scope": "example",
            }
        )
        with mock.patch(
            "memory_store.corrections_split.rule_neighbors",
            return_value=[
                {"id": rule_id, "situation": "about to push any commit", "similarity": 0.97}
            ],
        ):
            manifest = corrections_split.run(
                self.store,
                apply=True,
                classifier=classifier_of(
                    {
                        "m3": {
                            "kind": "rule",
                            "situation": "about to push",
                            "statement": "verify the destination first",
                            "floor_candidate": False,
                        }
                    }
                ),
            )
        self.assertEqual(manifest["totals"], {"covered-existing": 1})
        self.assertEqual(manifest["entries"][0]["rule_id"], rule_id)
        rows = self.store.conn.execute("SELECT COUNT(*) AS n FROM situational_rules").fetchone()
        self.assertEqual(rows["n"], 1, "a covered ruling must not clone the standing rule")

    def test_floor_candidate_is_flagged_never_authored(self):
        seed_correction(
            self.store,
            "m4",
            "example",
            "never kill a production service without the word",
            "2026-10-04T00:00:00Z",
        )
        manifest = corrections_split.run(
            self.store,
            apply=True,
            classifier=classifier_of(
                {
                    "m4": {
                        "kind": "rule",
                        "situation": "a live production service must restart",
                        "statement": "stop and ask",
                        "floor_candidate": True,
                    }
                }
            ),
        )
        self.assertEqual(manifest["totals"], {"flagged-floor": 1})
        self.assertEqual(manifest["entries"][0]["outcome"], "flagged-floor")
        rows = self.store.conn.execute("SELECT COUNT(*) AS n FROM situational_rules").fetchone()
        self.assertEqual(rows["n"], 0)

    def test_narration_tombstones_through_the_forget_channel(self):
        seed_correction(
            self.store,
            "m5",
            "example-repo",
            "Investigation receipts from lunar-base session dp1aQom",
            "2026-10-05T00:00:00Z",
        )
        manifest = corrections_split.run(
            self.store,
            apply=True,
            classifier=classifier_of({"m5": {"kind": "narration"}}),
        )
        self.assertEqual(manifest["totals"], {"tombstone": 1})
        row = self.store.conn.execute(
            "SELECT COUNT(*) AS n FROM agent_memory WHERE id = 'm5'"
        ).fetchone()
        self.assertEqual(row["n"], 0, "narration is gone from the pool")
        tomb = self.store.conn.execute(
            "SELECT row_id, table_name FROM forget_tombstones WHERE row_id = 'm5'"
        ).fetchone()
        self.assertEqual(tomb["table_name"], "agent_memory")

    def test_totals_reconcile_every_scanned_row(self):
        seed_correction(self.store, "m6", "example", "factual fix lands", "2026-10-06T00:00:00Z")
        seed_correction(
            self.store, "m7", "example-repo", "pure session narration", "2026-10-07T00:00:00Z"
        )
        manifest = corrections_split.run(
            self.store,
            apply=True,
            classifier=classifier_of(
                {
                    "m6": {"kind": "fact", "content": "the fix lands", "source": "fact"},
                    "m7": {"kind": "narration"},
                }
            ),
        )
        accounted = sum(manifest["totals"].values())
        self.assertEqual(accounted, manifest["scanned"])


if __name__ == "__main__":
    unittest.main()
