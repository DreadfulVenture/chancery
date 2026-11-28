"""Correction-row split pass (PRJ-172).

The deliberate pool's `correction` rows conflate two kinds of fix:
factual corrections and conduct rulings, worded as incident narration.
This pass moves each row to the store its fix belongs to — the agent
runs it, sleep never touches behavioural rules (hard line):

- fact        -> reworded to present-tense state, UPDATE in place
                 (id/created_at/session preserved; recall ids and the
                 KB fold journals stay stable), reclassified to a state
                 source, and re-emitted so the fleet converges.
- rule        -> authored as a situational rule ONLY after the store was
                 asked (nearest situation below RECONCILE_THRESHOLD and
                 not flagged floor-worthy); covered rows reconcile to
                 the standing rule instead.
- flagged-floor -> no write: the manifest names the candidate for the
                 operator — floor changes are theirs, never the pass's.
- tombstone   -> narration whose claim already stands elsewhere: forgot
                 through the forget channel (tombstone + delete + the
                 forget record), so every machine converges and a
                 delayed replay of the original write cannot resurrect.

Deterministic where it can: watermark, tombstone exclusion, in-place
fact updates, reconcile thresholds are mechanical; judgment lives in
one injected classifier (LLM batch by default, fake in tests). The
pass is idempotent by construction: facts re-update to the same text,
reconcile refuses clones, forget is tombstone-guarded — a re-run with
the same classification records the same outcomes and spends nothing
new. The manifest is the reconcile artifact: in = fact-updates + rules
+ tombstones + covered + flagged, per row.

--apply is required for every write. Without it the pass classifies
and records only: the manifest for review, the live store untouched.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

from memory_store import store as store_mod
from memory_store.curated import RECONCILE_THRESHOLD, rule_neighbors
from memory_store.consolidation.consolidation import _chat_completion

FACT_SOURCES = {"fact", "decision", "insight", "preference", "convention", "task", "stated"}
DEFAULT_WATERMARK = "9999-12-31T23:59:59Z"
BATCH_ROWS = 12

CLASSIFY_PROMPT = """Split these user-correction memories. Each is an incident note.
Return STRICT JSON (one array, no prose): for every id exactly one object.

- "kind": "fact" (a true-state claim about the world/projects — rewrite
  "content" as present tense, no narration, no dates, no 'the operator said') or
  "rule" (how the agent must behave: give "situation" — when this
  applies, phrased as a moment — and "statement" — what to do) or
  "narration" (only session incident/receipt narrative; its durable
  claim is not stored here).
- "source" (facts only): fact | decision | insight | preference |
  convention | task | stated.
- "floor_candidate" (rules only): true when the ruling is broad enough
  to belong in the always-on floor rather than a project-scoped rule
  (commit gates, deployment boundaries, kill/restart rules, plan-mode
  conduct). false for repo- or tool-specific conduct.
- "reason": <= 12 words.

Rows:
{rows}"""


def classification_batch(rows: list, chain=None) -> dict:
    """One LLM call per batch; returns {id: mapping}. Raises on chain
    failure so the pass releases (a release never writes)."""
    lines = "\n".join(f"- id={r['id']} repo={r['repo']} | {r['content'][:600]}" for r in rows)
    prompt = CLASSIFY_PROMPT.format(rows=lines)
    raw = (chain or _chat_completion)(prompt, label="corrections-split")
    return parse_classification(raw, [r["id"] for r in rows])


def parse_classification(raw: str, ids: list) -> dict:
    try:
        text = raw.strip()
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
        data = json.loads(text)
    except (ValueError, IndexError) as error:
        raise ValueError(f"classifier returned unparseable output: {error!r}") from error
    if not isinstance(data, list):
        raise ValueError("classifier output is not a JSON array")
    out = {}
    for item in data:
        if not isinstance(item, dict) or "id" not in item or "kind" not in item:
            continue
        if str(item["id"]) not in {str(i) for i in ids}:
            continue
        if item["kind"] not in ("fact", "rule", "narration"):
            continue
        out[str(item["id"])] = item
    missing = [str(i) for i in ids if str(i) not in out]
    if missing:
        raise ValueError(f"classifier dropped ids: {missing[:5]}")
    return out


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def fetch_rows(st, watermark: str) -> list:
    """Un-forgotten correction rows up to the watermark, oldest first
    (the pass walks the corpus in creation order; the watermark bounds
    a re-run at a frozen corpus state)."""
    return [
        dict(r)
        for r in st.conn.execute(
            """SELECT id, repo, content, source, created_at
                 FROM agent_memory
                WHERE source = 'correction'
                  AND created_at <= ?
                  AND id NOT IN (SELECT row_id FROM forget_tombstones
                                 WHERE table_name = 'agent_memory')
                ORDER BY created_at, id""",
            (watermark,),
        ).fetchall()
    ]


def rule_authoring(st, situation: str) -> dict:
    """The write asks the store first (PRJ-172): a near-identical
    standing rule covers the candidate — nothing is written. Only a
    moment with no standing neighbor lands as a new row."""
    try:
        neighbors = rule_neighbors(st, situation, limit=1)
    except Exception:
        return {"decision": "embed-unavailable"}
    if neighbors and neighbors[0]["similarity"] >= RECONCILE_THRESHOLD:
        return {"decision": "covered", "rule_id": neighbors[0]["id"]}
    return {"decision": "author"}


def apply_row(st, sync, row: dict, mapping: dict, apply: bool = True) -> dict:
    """One row's writes. Returns the manifest entry; never raises for a
    judgeable shape — classifier contracts raise earlier, at the batch."""
    rid = row["id"]
    kind = mapping.get("kind")
    if kind == "fact":
        content = (mapping.get("content") or "").strip()
        source = mapping.get("source", "fact")
        if source not in FACT_SOURCES:
            source = "fact"
        if not content:
            return {**_entry(row, "held"), "reason": "empty fact content"}
        if not apply:
            return {**_entry(row, "fact-update", content=content, source=source), "dry": True}
        st.conn.execute(
            "UPDATE agent_memory SET content = ?, source = ? WHERE id = ?",
            (content, source, rid),
        )
        st.conn.commit()
        payload = st.agent_record_payload(rid)
        if sync is not None and payload:
            sync.enqueue("agent_memory", payload)
        return _entry(row, "fact-update", content=content, source=source)

    if kind == "rule":
        situation = (mapping.get("situation") or "").strip()
        statement = (mapping.get("statement") or "").strip()
        if not (situation and statement):
            return {**_entry(row, "held"), "reason": "incomplete rule mapping"}
        # Floor flagging precedes the authoring probe: a floor candidate is
        # never authored regardless of what the store answers, so its
        # manifest entry must not depend on embeddings being available.
        if mapping.get("floor_candidate"):
            return _entry(
                row,
                "flagged-floor",
                situation=situation,
                statement=statement,
            )
        asked = rule_authoring(st, situation)
        if asked["decision"] == "covered":
            return _entry(row, "covered-existing", rule_id=asked["rule_id"])
        if asked["decision"] == "embed-unavailable":
            return {**_entry(row, "held"), "reason": "embeddings unavailable"}
        if not apply:
            return {**_entry(row, "rule", situation=situation, statement=statement), "dry": True}
        rule_id = int(time.time_ns() % (10**9))
        st.upsert_situational(
            {
                "id": rule_id,
                "situation": situation,
                "statement": statement,
                "rationale": f"correction row {rid}",
                "grader": "agent",
                "stance": "prescriptive",
                "scope": row["repo"] or "",
                "status": "active",
                "provenance": f"correction-split: {row['created_at']}",
                "origin_machine": st.machine_id,
            }
        )
        if sync is not None:
            synced_row = st.conn.execute(
                "SELECT id, situation, statement, rationale, grader, stance, "
                "scope, status, provenance, origin_machine FROM situational_rules "
                "WHERE id = ?",
                (rule_id,),
            ).fetchone()
            if synced_row:
                payload = dict(synced_row)
                payload["target"] = "situational"
                sync.enqueue("rule", payload)
        return _entry(row, "rule", rule_id=rule_id, situation=situation, statement=statement)

    if kind == "narration":
        if not apply:
            return {**_entry(row, "tombstone"), "dry": True}
        st.forget("agent_memory", rid)
        if sync is not None:
            sync.enqueue("forget", {"table": "agent_memory", "id": rid})
        return _entry(row, "tombstone")

    return {**_entry(row, "held"), "reason": f"unknown kind {kind!r}"}


def _entry(row: dict, outcome: str, **detail) -> dict:
    entry = {
        "id": row["id"],
        "repo": row["repo"],
        "created_at": row["created_at"],
        "excerpt": row["content"][:110],
        "outcome": outcome,
    }
    entry.update(detail)
    return entry


def run(
    st,
    sync=None,
    classifier=classification_batch,
    watermark: str = DEFAULT_WATERMARK,
    limit: int | None = None,
    apply: bool = True,
) -> dict:
    """One pass: scan, classify in batches, apply, reconcile. Returns the
    manifest. A classifier failure releases the whole batch set —
    nothing applies when the judgment layer is down."""
    rows = fetch_rows(st, watermark)
    if limit is not None:
        rows = rows[:limit]
    manifest: list = []
    for index in range(0, len(rows), BATCH_ROWS):
        batch = rows[index : index + BATCH_ROWS]
        try:
            mappings = classifier(batch)
        except ValueError:
            # One retry, then the batch's rows hold rather than release the
            # whole pass: a held row stays 'correction' and re-passes later
            # (the scan excludes nothing it must). A pass that lands with
            # held rows reports them in the totals — the class is not empty
            # until the re-pass empties it.
            try:
                mappings = classifier(batch)
            except ValueError as error:
                for row in batch:
                    manifest.append(
                        {**_entry(row, "held"), "reason": f"classifier: {error!r}"[:180]}
                    )
                continue
        for row in batch:
            manifest.append(apply_row(st, sync, row, mappings[str(row["id"])], apply=apply))
    totals: dict[str, int] = {}
    for entry in manifest:
        totals[entry["outcome"]] = totals.get(entry["outcome"], 0) + 1
    return {
        "watermark": watermark,
        "scanned": len(rows),
        "totals": totals,
        "entries": manifest,
        "finished_at": _now(),
    }


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("db", help="store db path (a COPY for dry-runs)")
    parser.add_argument("--manifest", default="corrections_split_manifest.json")
    parser.add_argument("--watermark", default=DEFAULT_WATERMARK)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write (default: classify + manifest only, no writes)",
    )
    parser.add_argument("--machine-id", default=os.environ.get("MEMORY_MACHINE_ID", ""))
    parser.add_argument("--hub-url", default=os.environ.get("MEMORY_HUB_URL", ""))
    args = parser.parse_args(argv)
    if not args.machine_id:
        args.machine_id = os.uname().nodename.strip().lower()
    st = store_mod.Store(args.db)
    st.machine_id = args.machine_id
    sync = None
    if args.apply:
        from memory_store.sync import SyncClient

        sync = SyncClient(st, args.hub_url, args.machine_id)
    manifest = run(
        st,
        sync=sync,
        watermark=args.watermark,
        limit=args.limit,
        apply=args.apply,
    )
    with open(args.manifest, "w") as fh:
        json.dump(manifest, fh, indent=1, sort_keys=True)
    print(json.dumps({k: v for k, v in manifest.items() if k != "entries"}, indent=2))
    leftovers = st.conn.execute(
        "SELECT COUNT(*) AS n FROM agent_memory WHERE source = 'correction'"
    ).fetchone()["n"]
    print(f"correction rows remaining: {leftovers}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
