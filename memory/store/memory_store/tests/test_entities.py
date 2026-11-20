"""The entity directory's storage layer (PRD 20261023-entity-directory).

Every test here works at the record level, the way sync.apply reaches the
store: the tools that will build these records do not exist yet, and the
property the design rests on — same rows, same state, whatever order they
arrived in — belongs to this layer rather than to them.
"""

from __future__ import annotations

import random
import tempfile
import time
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest import mock

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store.store import ENTITY_MATERIALIZED_TABLES, Store


_EPOCH = datetime(2026, 10, 23, tzinfo=UTC)


def _stamp(seconds: int) -> str:
    """A wire timestamp. Explicit per row: created_at decides which of two
    conflicting rows wins, so a test that leaves it to the clock is a test
    whose outcome depends on how fast it ran."""
    return (_EPOCH + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


def _session(machine: str = "host-a", conversation: str = "conv-1") -> dict:
    return {"machine": machine, "tool": "cursor", "conversation_id": conversation, "project": ""}


class _EntityCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = Store(Path(self.tmp) / "test.db")

    def tearDown(self):
        self.store.close()

    # --- record builders ------------------------------------------------

    def create(self, entity_id: str, kind: str, at: int = 1, machine: str = "host-a") -> dict:
        return {
            "op": "create",
            "id": entity_id,
            "kind": kind,
            "session": _session(machine),
            "created_at": _stamp(at),
        }

    def rename(self, row_id: str, entity_id: str, name: str, at: int = 2) -> dict:
        return {
            "op": "rename",
            "id": row_id,
            "entity_id": entity_id,
            "display_name": name,
            "session": _session(),
            "created_at": _stamp(at),
        }

    def relate(self, row_id: str, subject: str, verb: str, obj: str, at: int = 3) -> dict:
        return {
            "op": "relate",
            "id": row_id,
            "subject_id": subject,
            "verb": verb,
            "object_id": obj,
            "session": _session(),
            "created_at": _stamp(at),
        }

    def unrelate(self, row_id: str, at: int = 9) -> dict:
        return {"op": "unrelate", "id": row_id, "deleted_at": _stamp(at)}

    def alias_add(
        self,
        row_id: str,
        entity_id: str,
        alias_type: str,
        value: str,
        instance: str | None = "",
        at: int = 4,
        machine: str = "host-a",
    ) -> dict:
        record = {
            "op": "alias_add",
            "id": row_id,
            "entity_id": entity_id,
            "type": alias_type,
            "value": value,
            "session": _session(machine),
            "created_at": _stamp(at),
        }
        if instance is not None:
            record["instance"] = instance
        return record

    def alias_remove(self, row_id: str, at: int = 9) -> dict:
        return {"op": "alias_remove", "id": row_id, "deleted_at": _stamp(at)}

    def observe(self, row_id: str, entity_id: str, content: str = "", at: int = 5) -> dict:
        return {
            "op": "observe",
            "id": row_id,
            "entity_id": entity_id,
            "content": content or f"observation {row_id}",
            "session": _session(),
            "created_at": _stamp(at),
        }

    def unobserve(self, row_id: str, at: int = 9) -> dict:
        return {"op": "unobserve", "id": row_id, "deleted_at": _stamp(at)}

    def restore(self, forget_id: str, at: int = 9) -> dict:
        return {"op": "restore", "id": forget_id, "deleted_at": _stamp(at)}

    # --- helpers ---------------------------------------------------------

    def forget(self, entity_id: str, forget_id: str, at: int = 10) -> None:
        self.store.forget_entity(
            entity_id, forget_id=forget_id, created_at=_stamp(at), session=_session()
        )

    def observations(self, entity_id: str) -> list[str]:
        return [row["id"] for row in self.store.entity_observations(entity_id)]

    def current(self, table: str) -> list[tuple]:
        return [
            tuple(row)
            for row in self.store.conn.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
        ]

    def entity(self, entity_id: str) -> dict | None:
        row = self.store.conn.execute(
            "SELECT * FROM current_entities WHERE id = ?", (entity_id,)
        ).fetchone()
        return dict(row) if row else None

    def alias_owner(self, value: str) -> list[str]:
        return [
            row["entity_id"]
            for row in self.store.conn.execute(
                "SELECT entity_id FROM current_aliases WHERE value = ? ORDER BY entity_id",
                (value,),
            )
        ]


class ApplyTests(_EntityCase):
    def test_an_insert_registers_the_session_that_wrote_it(self):
        self.store.apply_entity(self.create("e1", "human"))
        row = self.store.conn.execute(
            "SELECT s.machine, s.tool, s.client_conversation_id "
            "FROM entities e JOIN session s ON s.id = e.session_id"
        ).fetchone()
        self.assertEqual(tuple(row), ("host-a", "cursor", "conv-1"))

    def test_an_insert_replayed_changes_nothing(self):
        """The hub relays a machine's own records back to it."""
        record = self.create("e1", "human")
        self.store.apply_entity(record)
        self.store.apply_entity(dict(record, session=_session("host-b")))
        rows = self.store.conn.execute(
            "SELECT s.machine FROM entities e JOIN session s ON s.id = e.session_id"
        ).fetchall()
        self.assertEqual([row["machine"] for row in rows], ["host-a"])

    def test_a_removal_for_a_row_that_has_not_arrived_raises(self):
        """The caller defers the record and retries it once the row lands."""
        with self.assertRaisesRegex(ValueError, "not here yet"):
            self.store.apply_entity(self.alias_remove("a1"))

    def test_two_removals_of_one_row_keep_the_earliest(self):
        self.store.apply_entity(self.create("e1", "human"))
        self.store.apply_entity(self.alias_add("a1", "e1", "github", "jdoe"))
        for first, second in ((7, 9), (9, 7)):
            self.store.apply_entity(self.alias_remove("a1", at=first))
            self.store.apply_entity(self.alias_remove("a1", at=second))
            stored = self.store.conn.execute(
                "SELECT deleted_at FROM entity_aliases WHERE id = 'a1'"
            ).fetchone()
            self.assertEqual(stored["deleted_at"], _stamp(min(first, second)))
            self.store.conn.execute("UPDATE entity_aliases SET deleted_at = NULL WHERE id = 'a1'")

    def test_an_unknown_op_raises(self):
        with self.assertRaisesRegex(ValueError, "unknown entity op"):
            self.store.apply_entity({"op": "teleport", "id": "x1"})


class NameAndKindTests(_EntityCase):
    def test_the_newest_name_wins(self):
        self.store.apply_entity(self.create("e1", "human"))
        self.store.apply_entity(self.rename("n2", "e1", "Jane Roe", at=30))
        self.store.apply_entity(self.rename("n1", "e1", "Jane Doe", at=20))
        self.assertEqual(self.entity("e1")["display_name"], "Jane Roe")

    def test_a_kind_this_version_does_not_know_is_skipped(self):
        """Materialization, not the wire, is where an unknown value stops —
        which is what lets a later version add one without a hub-first
        deploy."""
        self.store.apply_entity(self.create("e1", "spaceship"))
        self.assertIsNone(self.entity("e1"))
        self.assertEqual(
            self.store.conn.execute("SELECT COUNT(*) AS n FROM entities").fetchone()["n"], 1
        )


class RelationTests(_EntityCase):
    def setUp(self):
        super().setUp()
        self.store.apply_entity(self.create("human1", "human"))
        self.store.apply_entity(self.create("human2", "human"))
        self.store.apply_entity(self.create("agent1", "agent"))

    def test_acts_for_resolves(self):
        self.store.apply_entity(self.relate("r1", "agent1", "acts_for", "human1"))
        self.assertEqual(self.entity("agent1")["acts_for"], "human1")

    def test_two_acts_for_rows_keep_the_newer(self):
        """Two machines can each point one agent at a different human."""
        self.store.apply_entity(self.relate("r1", "agent1", "acts_for", "human1", at=10))
        self.store.apply_entity(self.relate("r2", "agent1", "acts_for", "human2", at=20))
        self.assertEqual(self.entity("agent1")["acts_for"], "human2")
        rows = self.current("current_relations")
        self.assertEqual([row[0] for row in rows], ["r2"])

    def test_acts_for_between_the_wrong_kinds_is_skipped(self):
        self.store.apply_entity(self.relate("r1", "human1", "acts_for", "human2"))
        self.assertIsNone(self.entity("human1")["acts_for"])

    def test_ending_the_relation_clears_it(self):
        self.store.apply_entity(self.relate("r1", "agent1", "acts_for", "human1"))
        self.store.apply_entity(self.unrelate("r1"))
        self.assertIsNone(self.entity("agent1")["acts_for"])

    def test_a_verb_this_version_does_not_know_is_skipped(self):
        self.store.apply_entity(self.relate("r1", "agent1", "reports_to", "human1"))
        self.assertEqual(self.current("current_relations"), [])


class MergeTests(_EntityCase):
    def setUp(self):
        super().setUp()
        for n in (1, 2, 3):
            self.store.apply_entity(self.create(f"e{n}", "human"))

    def test_a_chain_resolves_to_its_end(self):
        self.store.apply_entity(self.relate("m1", "e1", "merged_into", "e2", at=10))
        self.store.apply_entity(self.relate("m2", "e2", "merged_into", "e3", at=20))
        self.assertEqual(self.entity("e1")["final_id"], "e3")
        self.assertEqual(self.entity("e2")["final_id"], "e3")
        self.assertEqual(self.entity("e3")["final_id"], "e3")

    def test_undoing_a_merge_splits_the_chain(self):
        self.store.apply_entity(self.relate("m1", "e1", "merged_into", "e2", at=10))
        self.store.apply_entity(self.relate("m2", "e2", "merged_into", "e3", at=20))
        self.store.apply_entity(self.unrelate("m2"))
        self.assertEqual(self.entity("e1")["final_id"], "e2")
        self.assertEqual(self.entity("e2")["final_id"], "e2")

    def test_aliases_follow_the_merge_and_come_back_when_it_is_undone(self):
        self.store.apply_entity(self.alias_add("a1", "e1", "github", "jdoe"))
        self.store.apply_entity(self.relate("m1", "e1", "merged_into", "e2", at=10))
        self.assertEqual(self.alias_owner("jdoe"), ["e2"])
        row = self.store.conn.execute(
            "SELECT owner_id FROM current_aliases WHERE id = 'a1'"
        ).fetchone()
        self.assertEqual(row["owner_id"], "e1")

        self.store.apply_entity(self.unrelate("m1"))
        self.assertEqual(self.alias_owner("jdoe"), ["e1"])

    def test_mutual_merges_keep_the_newer(self):
        """Each machine merged the other's entry into its own."""
        self.store.apply_entity(self.relate("m1", "e1", "merged_into", "e2", at=10))
        self.store.apply_entity(self.relate("m2", "e2", "merged_into", "e1", at=20))
        # m2 is the newer row, so e2 is the one that folds away.
        self.assertEqual(self.entity("e1")["final_id"], "e1")
        self.assertEqual(self.entity("e2")["final_id"], "e1")
        self.assertEqual([row[0] for row in self.current("current_relations")], ["m2"])

    def test_a_merge_across_kinds_is_skipped(self):
        self.store.apply_entity(self.create("bot1", "bot"))
        self.store.apply_entity(self.relate("m1", "bot1", "merged_into", "e1"))
        self.assertEqual(self.entity("bot1")["final_id"], "bot1")

    def test_a_merge_into_a_forgotten_entry_is_skipped(self):
        self.forget("e2", "f1")
        self.store.apply_entity(self.relate("m1", "e1", "merged_into", "e2", at=20))
        self.assertEqual(self.entity("e1")["final_id"], "e1")


class AliasTests(_EntityCase):
    def setUp(self):
        super().setUp()
        self.store.apply_entity(self.create("e1", "human"))
        self.store.apply_entity(self.create("e2", "human"))

    def test_one_alias_on_two_entries_is_kept_not_resolved(self):
        """Two machines each gave github:jdoe to a different entry before
        they synced. Apply takes both; the collision shows up at lookup."""
        self.store.apply_entity(self.alias_add("a1", "e1", "github", "jdoe", machine="host-a"))
        self.store.apply_entity(self.alias_add("a2", "e2", "github", "jdoe", machine="host-b"))
        self.assertEqual(self.alias_owner("jdoe"), ["e1", "e2"])

    def test_removing_one_alias_leaves_the_others(self):
        self.store.apply_entity(self.alias_add("a1", "e1", "github", "jdoe"))
        self.store.apply_entity(self.alias_add("a2", "e1", "email", "jdoe@example.com"))
        self.store.apply_entity(self.alias_remove("a1"))
        self.assertEqual(self.alias_owner("jdoe"), [])
        self.assertEqual(self.alias_owner("jdoe@example.com"), ["e1"])

    def test_an_alias_type_this_version_does_not_know_is_skipped(self):
        self.store.apply_entity(self.alias_add("a1", "e1", "carrier_pigeon", "jdoe"))
        self.assertEqual(self.current("current_aliases"), [])

    def test_instance_is_stored_when_given_and_empty_when_omitted(self):
        self.store.apply_entity(self.alias_add("a1", "e1", "slack", "U04ABC", instance="T0123"))
        self.store.apply_entity(self.alias_add("a2", "e1", "email", "j@example.com", instance=None))
        for table in ("entity_aliases", "current_aliases"):
            rows = self.store.conn.execute(
                f"SELECT id, instance FROM {table} ORDER BY id"
            ).fetchall()
            self.assertEqual([tuple(row) for row in rows], [("a1", "T0123"), ("a2", "")], table)

    def test_re_adding_a_removed_alias_is_a_new_row(self):
        self.store.apply_entity(self.alias_add("a1", "e1", "github", "jdoe", at=4))
        self.store.apply_entity(self.alias_remove("a1", at=5))
        self.store.apply_entity(self.alias_add("a2", "e1", "github", "jdoe", at=6))
        self.assertEqual(self.alias_owner("jdoe"), ["e1"])


class ForgetTests(_EntityCase):
    def setUp(self):
        super().setUp()
        self.store.apply_entity(self.create("e1", "human"))
        self.store.apply_entity(self.rename("n1", "e1", "Jane Doe"))
        self.store.apply_entity(self.alias_add("a1", "e1", "github", "jdoe"))

    def test_forgetting_takes_the_entry_and_its_aliases_out(self):
        self.forget("e1", "f1", at=10)
        self.assertIsNone(self.entity("e1"))
        self.assertEqual(self.alias_owner("jdoe"), [])

    def test_the_rows_themselves_survive_a_forget(self):
        """A restore has nothing to restore from otherwise."""
        self.forget("e1", "f1", at=10)
        for table in ("entities", "entity_names", "entity_aliases"):
            count = self.store.conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]
            self.assertEqual(count, 1, table)

    def test_restoring_brings_the_entry_and_its_aliases_back(self):
        self.forget("e1", "f1", at=10)
        self.store.apply_entity(self.restore("f1", at=20))
        self.assertEqual(self.entity("e1")["display_name"], "Jane Doe")
        self.assertEqual(self.alias_owner("jdoe"), ["e1"])

    def test_forgetting_again_is_a_second_row(self):
        self.forget("e1", "f1", at=10)
        self.store.apply_entity(self.restore("f1", at=20))
        self.forget("e1", "f2", at=30)
        self.assertIsNone(self.entity("e1"))
        count = self.store.conn.execute("SELECT COUNT(*) AS n FROM entity_forgets").fetchone()["n"]
        self.assertEqual(count, 2)

    def test_a_replayed_forget_changes_nothing(self):
        self.forget("e1", "f1", at=10)
        self.forget("e1", "f1", at=30)
        row = self.store.conn.execute("SELECT created_at FROM entity_forgets").fetchone()
        self.assertEqual(row["created_at"], _stamp(10))


class ObservationTests(_EntityCase):
    def setUp(self):
        super().setUp()
        self.store.apply_entity(self.create("jane", "human"))
        self.store.apply_entity(self.create("agent1", "agent"))
        self.store.apply_entity(self.relate("r1", "agent1", "acts_for", "jane"))

    def test_an_observation_before_its_entry_shows_once_the_entry_lands(self):
        self.store.apply_entity(self.observe("o1", "later"))
        self.assertEqual(self.observations("later"), [])
        self.store.apply_entity(self.create("later", "human", at=20))
        self.assertEqual(self.observations("later"), ["o1"])

    def test_newest_first(self):
        self.store.apply_entity(self.observe("o1", "jane", at=5))
        self.store.apply_entity(self.observe("o2", "jane", at=6))
        self.assertEqual(self.observations("jane"), ["o2", "o1"])

    def test_a_merge_moves_observations_and_undoing_it_moves_them_back(self):
        self.store.apply_entity(self.create("dupe", "human"))
        self.store.apply_entity(self.observe("o1", "dupe"))
        self.store.apply_entity(self.relate("m1", "dupe", "merged_into", "jane", at=10))
        self.assertEqual(self.observations("jane"), ["o1"])
        self.store.apply_entity(self.unrelate("m1", at=11))
        self.assertEqual(self.observations("jane"), [])
        self.assertEqual(self.observations("dupe"), ["o1"])

    def test_forgetting_the_entry_hides_them_and_restoring_brings_them_back(self):
        self.store.apply_entity(self.observe("o1", "jane"))
        self.forget("jane", "f1")
        self.assertEqual(self.observations("jane"), [])
        self.store.apply_entity(self.restore("f1", at=20))
        self.assertEqual(self.observations("jane"), ["o1"])

    def test_a_humans_read_includes_their_agents(self):
        self.store.apply_entity(self.observe("o1", "jane", at=5))
        self.store.apply_entity(self.observe("o2", "agent1", at=6))
        self.assertEqual(self.observations("jane"), ["o2", "o1"])

    def test_an_agents_read_excludes_their_human(self):
        self.store.apply_entity(self.observe("o1", "jane", at=5))
        self.store.apply_entity(self.observe("o2", "agent1", at=6))
        self.assertEqual(self.observations("agent1"), ["o2"])

    def test_a_merged_away_agent_does_not_bring_its_target_to_the_old_human(self):
        """Who a merged agent acts for is its target's relation; the
        merged-away entry's own acts_for row stays on it but says nothing."""
        self.store.apply_entity(self.create("john", "human"))
        self.store.apply_entity(self.create("agent2", "agent"))
        self.store.apply_entity(self.relate("r2", "agent2", "acts_for", "john"))
        self.store.apply_entity(self.relate("m1", "agent1", "merged_into", "agent2", at=10))
        self.store.apply_entity(self.observe("o1", "agent2", at=5))
        self.assertEqual(self.observations("jane"), [])
        self.assertEqual(self.observations("john"), ["o1"])

    def test_an_unobserve_that_arrives_first_defers_then_converges(self):
        with self.assertRaisesRegex(ValueError, "not here yet"):
            self.store.apply_entity(self.unobserve("o1"))
        self.store.apply_entity(self.observe("o1", "jane"))
        self.store.apply_entity(self.unobserve("o1"))
        self.assertEqual(self.observations("jane"), [])

    def test_an_observation_never_lands_in_agent_memory(self):
        """Observations stay out of the project knowledge base, whose build
        reads agent_memory."""
        self.store.apply_entity(self.observe("o1", "jane"))
        count = self.store.conn.execute("SELECT COUNT(*) AS n FROM agent_memory").fetchone()["n"]
        self.assertEqual(count, 0)


class RebuildTests(_EntityCase):
    def _populate(self) -> None:
        self.store.apply_entity(self.create("e1", "human"))
        self.store.apply_entity(self.create("e2", "human"))
        self.store.apply_entity(self.create("a1", "agent"))
        self.store.apply_entity(self.rename("n1", "e1", "Jane Doe"))
        self.store.apply_entity(self.relate("r1", "a1", "acts_for", "e1"))
        self.store.apply_entity(self.relate("m1", "e2", "merged_into", "e1", at=10))
        self.store.apply_entity(self.alias_add("al1", "e2", "github", "jdoe"))
        self.store.apply_entity(self.observe("o1", "e2"))

    def _snapshot(self) -> dict[str, list]:
        snapshot: dict[str, list] = {
            table: self.current(table) for table in ENTITY_MATERIALIZED_TABLES
        }
        snapshot["observations"] = self.store.entity_observations("e1")
        return snapshot

    def _reopen(self) -> None:
        path = self.store.path
        self.store.close()
        self.store = Store(path)

    def test_a_version_change_rebuilds_the_same_state(self):
        self._populate()
        before = self._snapshot()
        self.store._meta_set("entity_materialized_version", "0")
        self.store.conn.commit()
        self._reopen()
        self.assertEqual(self._snapshot(), before)

    def test_a_missing_table_rebuilds_the_same_state(self):
        self._populate()
        before = self._snapshot()
        self.store.conn.execute("DROP TABLE current_aliases")
        self.store.conn.commit()
        self._reopen()
        self.assertEqual(self._snapshot(), before)

    def test_reopening_an_up_to_date_store_leaves_it_alone(self):
        self._populate()
        before = self._snapshot()
        self._reopen()
        self.assertEqual(self._snapshot(), before)


class ConvergenceTests(_EntityCase):
    """The property the append-only design exists for: the same records,
    applied in any order, leave every machine in the same state. Order is
    not hypothetical — a record whose row has not arrived is deferred and
    retried later, so apply order is not log order."""

    def _records(self) -> list[dict]:
        return [
            self.create("jane", "human", at=1),
            self.create("dupe", "human", at=2),
            self.create("bot", "agent", at=3),
            self.rename("n1", "jane", "Jane Doe", at=4),
            self.rename("n2", "jane", "Jane Roe", at=5),
            self.rename("n3", "dupe", "J. Doe", at=6),
            self.relate("r1", "bot", "acts_for", "jane", at=7),
            self.alias_add("a1", "jane", "github", "jdoe", instance="github.com", at=8),
            self.alias_add("a2", "dupe", "slack", "U04ABC", instance="T0123", at=9),
            self.alias_add("a3", "jane", "email", "jane@example.com", at=10),
            self.alias_remove("a3", at=11),
            self.relate("m1", "dupe", "merged_into", "jane", at=12),
            self.observe("o1", "dupe", at=13),
            self.observe("o2", "bot", at=14),
            self.observe("o3", "bot", at=15),
            self.unobserve("o3", at=16),
            self.relate("m2", "jane", "merged_into", "dupe", at=17),
            self.relate("r2", "bot", "acts_for", "dupe", at=18),
            self.create("gone", "human", at=19),
            self.alias_add("a4", "gone", "github", "gone", at=20),
            self.observe("o4", "gone", at=21),
            {"forget": "gone", "id": "f1", "at": 22},
            {"forget": "bot", "id": "f2", "at": 23},
            self.restore("f2", at=24),
        ]

    def _apply_in_order(self, records: list[dict]) -> None:
        """Apply what can be applied, deferring the rest, until nothing
        moves — the shape SyncClient.pull plus retry_deferred produces.
        A forget rides its own record kind, so it goes to forget_entity
        the way sync.apply routes it."""
        pending = list(records)
        while pending:
            progressed = False
            still_pending = []
            for record in pending:
                if "forget" in record:
                    self.forget(record["forget"], record["id"], at=record["at"])
                    progressed = True
                    continue
                try:
                    self.store.apply_entity(record)
                except ValueError:
                    still_pending.append(record)
                    continue
                progressed = True
            if not progressed:
                self.fail(f"no record could apply: {[r['id'] for r in still_pending]}")
            pending = still_pending

    def _state(self) -> dict[str, list]:
        state: dict[str, list] = {
            table: self.current(table) for table in ENTITY_MATERIALIZED_TABLES
        }
        state["observations"] = {
            entity: self.store.entity_observations(entity)
            for entity in ("jane", "dupe", "bot", "gone")
        }
        return state

    def test_every_order_reaches_the_same_state(self):
        records = self._records()
        self._apply_in_order(records)
        expected = self._state()
        # The fixture has to exercise what it claims to: a state with no
        # entries would converge trivially.
        self.assertTrue(expected["current_entities"])
        self.assertTrue(expected["current_aliases"])
        self.assertTrue(expected["observations"]["dupe"])
        # One forget stands and the other is restored, so both outcomes are
        # in the state every order has to reach.
        entries = {row[0] for row in expected["current_entities"]}
        self.assertNotIn("gone", entries)
        self.assertIn("bot", entries)
        self.assertEqual(expected["observations"]["gone"], [])
        # The instance column has to survive apply, not just converge: a
        # dropped instance converges just as well, on '' everywhere.
        instances = {row[0]: row[4] for row in expected["current_aliases"]}
        self.assertEqual(instances, {"a1": "github.com", "a2": "T0123"})

        for seed in range(20):
            with self.subTest(seed=seed):
                self.tearDown()
                self.setUp()
                shuffled = list(records)
                random.Random(seed).shuffle(shuffled)
                self._apply_in_order(shuffled)
                self.assertEqual(self._state(), expected)


class RecomputeCostTests(_EntityCase):
    def test_a_recompute_over_a_few_thousand_rows_stays_bounded(self):
        """Recomputing the whole directory per apply is only reasonable
        while the directory is people-sized. The bound is a smoke check
        sized for that, not a benchmark: it is generous enough that a
        loaded runner passes and a recompute gone quadratic does not."""
        for n in range(500):
            self.store.apply_entity(self.create(f"e{n}", "human", at=n))
            self.store.apply_entity(self.rename(f"n{n}", f"e{n}", f"Person {n}", at=n))
            self.store.apply_entity(self.alias_add(f"a{n}", f"e{n}", "github", f"person{n}", at=n))
        started = time.monotonic()
        self.store.apply_entity(self.create("last", "human", at=999))
        self.assertLess(time.monotonic() - started, 5.0)

    def test_observations_recompute_nothing(self):
        """Observations outnumber entries, so writing one must not pay for a
        directory recompute."""
        self.store.apply_entity(self.create("e1", "human"))
        with mock.patch.object(self.store, "_materialize_entities") as recompute:
            self.store.apply_entity(self.observe("o1", "e1"))
            self.store.apply_entity(self.unobserve("o1"))
        recompute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
