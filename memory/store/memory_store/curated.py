"""Curated-rule machinery: matcher engine, floor render, projection.

The matcher engine embeds a situation, cosines it against the active
situational matchers, and collapses near-duplicate candidates (sibling
suppression — sibling rules coexist in the store, weighting decides which
surfaces; sync ADR). The agent-invoked ask (rule_search) and the
write-reconcile probe (rule_neighbors) rank and gate on it.

Floor render is deterministic: rules grouped under their topic, topics
alphabetical, ordered by id within a topic, no timestamps in output, so an
unchanged corpus renders byte-identical and re-publishing never churns.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from memory_store import spans
from memory_store.store import DEFAULT_PERSONA_TOPIC, normalize_topic

FIRE_THRESHOLD = 0.60  # thatch's default; env-tunable later if evidence demands
DUPE_SUPPRESSION = 0.90
# The agent-invoked pull: the caller asked on purpose, so borderline pairs
# still return and relevance stays the caller's judgment.
PULL_THRESHOLD = 0.45
# Two rules write-reconcile instead of cloning: their situations are
# near-identical, i.e. the matcher engine itself collapses them as siblings.
RECONCILE_THRESHOLD = DUPE_SUPPRESSION


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def _confidence(confirm, disconfirm) -> float:
    """Grading-derived confidence (Laplace-smoothed); the same read the
    engine gates on. Deliberately shared: fire and pull must never split
    on how confidence is computed."""
    return (confirm + 5 * 0.5) / (confirm + disconfirm + 5)


def _active_situations(store):
    return store.conn.execute(
        """SELECT id, situation, statement, rationale, grader, stance, scope,
                  confirm_count, disconfirm_count, fire_count
           FROM situational_rules WHERE status = 'active'"""
    ).fetchall()


def rule_search(
    store,
    situation: str,
    limit: int = 8,
    threshold: float = PULL_THRESHOLD,
    workspace: str | None = None,
) -> list[dict]:
    """The agent-invoked ask: rules whose situation matches a composed
    situation, strongest first. Same engine as fire (embed + cosine, shared
    confidence, sibling suppression), deliberately different gates:
    threshold sits lower and low-confidence rules return marked quiet
    rather than being dropped — an explicit ask can judge a weak rule, an
    automatic fire cannot. No fire telemetry: this is a read, and read
    tools stamp usage (PRJ-178) at the tool layer instead."""
    rows = _active_situations(store)
    if not rows:
        return []
    with spans.span("rules.rule_search") as node:
        query_vec = store.embed([situation], origin="rules-prompt")[0]
        situation_vecs = store.embed([r["situation"] for r in rows], origin="rules-situations")
        node.set(rules=len(rows))
    scored: list[dict] = []
    for row, svec in zip(rows, situation_vecs, strict=True):
        sim = _cosine(query_vec, svec)
        score = sim
        if workspace and row["scope"] and row["scope"] == workspace:
            score += 0.15
        if score < threshold:
            continue
        confidence = _confidence(row["confirm_count"], row["disconfirm_count"])
        scored.append(
            {
                "id": row["id"],
                "situation": row["situation"],
                "statement": row["statement"],
                "rationale": row["rationale"],
                "grader": row["grader"],
                "stance": row["stance"],
                "scope": row["scope"],
                "confidence": round(confidence, 4),
                "evidence_count": int(row["confirm_count"] + row["disconfirm_count"]),
                "score": round(score, 4),
                "similarity": round(sim, 4),
                "quiet": confidence < 0.35,
                "vec": svec,
            }
        )
    scored.sort(key=lambda r: r["score"], reverse=True)
    kept: list[dict] = []
    kept_vecs: list[list[float]] = []
    for candidate in scored:
        if any(_cosine(candidate["vec"], pvec) >= DUPE_SUPPRESSION for pvec in kept_vecs):
            continue
        kept.append(candidate)
        kept_vecs.append(candidate["vec"])
        if len(kept) >= limit:
            break
    for rule in kept:
        rule.pop("vec", None)
    return kept


def rule_neighbors(store, situation: str, limit: int = 1) -> list[dict]:
    """The write-reconcile probe: the closest situations to a candidate,
    regardless of thresholds or suppression. The caller decides what a
    similarity means — a ~1.0 pair is the same rule restated, a 0.6x pair
    is a sibling worth naming in the write response. Embedding failure
    degrades at the caller (a store without vectors still writes rules)."""
    rows = _active_situations(store)
    if not rows:
        return []
    with spans.span("rules.neighbors") as node:
        query_vec = store.embed([situation], origin="rules-prompt")[0]
        situation_vecs = store.embed([r["situation"] for r in rows], origin="rules-situations")
        node.set(rules=len(rows))
    scored = sorted(
        (
            {
                "id": row["id"],
                "situation": row["situation"],
                "statement": row["statement"],
                "similarity": round(_cosine(query_vec, svec), 4),
                "vec": svec,
            }
            for row, svec in zip(rows, situation_vecs, strict=True)
        ),
        key=lambda r: r["similarity"],
        reverse=True,
    )[:limit]
    for r in scored:
        r.pop("vec", None)
    return scored


FLOOR_PREAMBLE = """# Standing rules

The user's durable, always-on preferences. Generated from the persona store — do
not edit by hand. Retired rules do not appear here.
"""


def render_floor(store) -> str:
    """Deterministic floor render: active persona rules grouped under their
    topic, topics alphabetical, rules ordered by id within a topic. No
    timestamps, so an unchanged corpus renders byte-identical and
    re-publishing never churns.

    Grouping is what makes fifteen standing rules readable as a document
    rather than a wall: a reader looking for how to write a comment finds
    one heading instead of scanning every rule."""
    rows = store.conn.execute(
        """SELECT statement, id, topic FROM persona_rules
           WHERE status = 'active' ORDER BY id"""
    ).fetchall()
    if not rows:
        return ""
    grouped: dict[str, list[str]] = {}
    for row in rows:
        topic = normalize_topic(row["topic"]) or DEFAULT_PERSONA_TOPIC
        grouped.setdefault(topic, []).append(row["statement"])
    parts = [FLOOR_PREAMBLE]
    for topic in sorted(grouped):
        parts.append(f"\n## {topic.title()}\n\n")
        parts.append("\n\n".join(grouped[topic]) + "\n")
    return "".join(parts).rstrip() + "\n"


def refresh_projection(store, directory: str) -> dict:
    """Write the rendered floor plus full-row JSON to a directory, for a
    consumer that wants a restorable copy of the curated corpus. Nothing in
    the daemon calls this: the floor Cursor publishes is rendered into the
    data dir, and no copy of it is committed anywhere. Telemetry stays out —
    runtime-cadence data does not belong in a file meant for diffing."""
    out = Path(directory)
    out.mkdir(parents=True, exist_ok=True)
    floor = render_floor(store)
    (out / "memory-floor.md").write_text(floor, encoding="utf-8")
    persona_rows = [
        dict(r)
        for r in store.conn.execute(
            """SELECT id, statement, status, provenance, origin_machine,
                      created_at, updated_at
               FROM persona_rules ORDER BY id"""
        ).fetchall()
    ]
    situational_rows = [
        dict(r)
        for r in store.conn.execute(
            """SELECT id, situation, statement, rationale, grader, stance, scope,
                      status, provenance, origin_machine, created_at, updated_at
               FROM situational_rules ORDER BY id"""
        ).fetchall()
    ]
    (out / "curated-records.json").write_text(
        json.dumps({"persona": persona_rows, "situational": situational_rows}, indent=2),
        encoding="utf-8",
    )
    return {
        "floor_chars": len(floor),
        "persona_rows": len(persona_rows),
        "situational_rows": len(situational_rows),
    }
