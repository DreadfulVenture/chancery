"""Nudge scorer: the automatic-injection channel's own scoring.

Per the memory PRD, the nudge channel is the precision channel and gets its
own scorer rather than upstream's: the candidate pool is restricted to
judgment-provenance rows (deliberate writes + consolidated episodic
summaries — raw captured turns are never nudge candidates), large rows sink
via a soft length penalty so keyword-shotgun documents cannot dominate, and
framing data (speaker, veracity, date) ships with every result; the honest
template lives in the plugin.

Similarity runs as two matrix products when numpy is importable — prompt
similarity in one, the semantic-debounce mask in another — with the
per-pair Python loop kept as the reference shape (and the only path
without numpy). The Python path must stay behaviorally identical: the
parity test in memory_store/tests/test_nudge.py diff-checks the two.

Vectors: pool contents already live in the vec0 tables (written on upsert),
so scoring reads them from the store instead of re-embedding the pool on
every nudge — re-embedding ran the whole pool through one large ONNX Run,
which wedges the KleidiAI SME kernel (see store.EMBED_BATCH_CHUNK). Only the
prompt and debounce-missing rows exercise the (chunked, cached) embedder.
"""

from __future__ import annotations

import math

from memory_store import spans

try:
    import numpy
except ImportError:  # pragma: no cover - numpy ships with fastembed/onnxruntime
    numpy = None

# Length penalty: multiplicative on the composite score, ramping from 1.0 at
# prose scale to a floor for multi-10k documents. Calibrated against the real
# corpus: ordinary turns ~700 chars, deliberate writes ~500-2000, fork
# summaries 22k-46k. Env-tunable per the package's weight-knob convention.
PENALTY_ONSET = 2000.0
PENALTY_FLOOR = 0.2

# Length-delta guard on the semantic debounce: rows and injected contents
# within this many chars of the same length are eligible for the 0.9-cosine
# suppression; unlike-length texts don't suppress. Cheap prefilter that
# mainly keeps the fork-summary near-dup from matching short prose.
LENGTH_DEBOUNCE_DELTA = 4000


def length_penalty(
    content_len: int, onset: float = PENALTY_ONSET, floor: float = PENALTY_FLOOR
) -> float:
    """Soft decay from 1.0 (at/below onset) toward `floor` as length grows.

    Uses log scaling so the curve bites at document scale without punishing
    ordinary long memories. Below onset: exactly 1.0 — prose is never taxed.
    """
    if content_len <= onset:
        return 1.0
    decay = math.log(content_len / onset) / math.log(8.0)  # one octave per ~8x
    return max(floor, 1.0 / (1.0 + decay))


def pool_query(store, workspace: str | None = None) -> list[dict]:
    """Fetch nudge-pool rows: deliberate writes + episodic summaries.

    Provenance is columns (repo/origin/app) — no string surgery. `workspace`
    (the resolved repo name) boosts same-repo rows — scope participates in
    retrieval, never in deletion (sync ADR). Rows carry `db_rowid` (the
    rowid in their own table) plus `vec_table` (which vec table keys it) so
    callers can join into the vec0 tables; a deliberate row's vec table is
    its own home's (vec_agent, the deliberate pool's home; vec_working for
    the working-memory stragglers still carrying the origin tag).
    Working-memory stragglers not yet migrated (replayed old records
    between boots) are folded in with the same shape; a migrated id can
    appear in both homes only until the migration's delete lands, and the
    agent row wins by construction (it is the home)."""
    rows: list[dict] = []
    with store._lock:
        for row in store.conn.execute(
            """SELECT rowid AS db_rowid, id, content, source, timestamp, created_at,
                      importance, veracity, author_id, author_type, kind,
                      repo, app
               FROM agent_memory"""
        ).fetchall():
            entry = dict(row)
            entry["tier"] = "working"
            entry["vec_table"] = "vec_agent"
            entry.setdefault("origin", "deliberate")
            if workspace and entry["repo"] == workspace:
                entry["workspace_match"] = True
            rows.append(entry)
        for row in store.conn.execute(
            """SELECT rowid AS db_rowid, id, content, source, timestamp, created_at,
                      importance, veracity, author_id, author_type, kind,
                      repo, origin
               FROM working_memory
               WHERE origin = 'deliberate'
                 AND id NOT IN (SELECT id FROM agent_memory)"""
        ).fetchall():
            entry = dict(row)
            entry["tier"] = "working"
            entry["vec_table"] = "vec_working"
            if workspace and entry["repo"] == workspace:
                entry["workspace_match"] = True
            rows.append(entry)
        for row in store.conn.execute(
            """SELECT rowid AS db_rowid, id, content, source, timestamp, created_at,
                      veracity, repo, origin
               FROM episodic_memory"""
        ).fetchall():
            entry = dict(row)
            entry["author_id"] = "sleep_consolidation"
            entry["author_type"] = "system"
            entry["tier"] = "episodic"
            entry["vec_table"] = "vec_episodes"
            entry["kind"] = None
            if workspace and entry["repo"] == workspace:
                entry["workspace_match"] = True
            rows.append(entry)
    return rows


def _sims(rows: list, targets: list[list[float]]):
    """All-pairs cosine between row vectors and target vectors, as a numpy
    (len(rows) x len(targets)) array.

    Zero-norm vectors score 0 against everything (the Python reference
    guards `if na and nb`); zero norms are clamped to 1 so the dot (which
    is already 0 for such rows) survives the divide."""
    matrix = numpy.asarray(rows, dtype=float)
    targets_m = numpy.asarray(targets, dtype=float)
    dots = matrix @ targets_m.T
    row_norms = numpy.linalg.norm(matrix, axis=1)
    target_norms = numpy.linalg.norm(targets_m, axis=1)
    row_norms[row_norms == 0.0] = 1.0
    target_norms[target_norms == 0.0] = 1.0
    return dots / (row_norms[:, None] * target_norms[None, :])


def _vectorized_scores(
    row_vectors: list[list[float]],
    row_lengths: list[int],
    prompt_vec: list[float],
    injected_lengths: list[int],
    injected_vecs: list[list[float]],
) -> tuple[list[float], list[bool]]:
    """Both channels as two matrix products: prompt similarity, then the
    debounce mask (any injected vector within the length-delta guard at
    cosine >= 0.9)."""
    sims = [s[0] for s in _sims(row_vectors, [prompt_vec])]
    if not injected_vecs:
        return sims, [False] * len(row_vectors)
    pair_sims = _sims(row_vectors, injected_vecs)
    rows_m = numpy.asarray(row_lengths)[:, None]
    injected_m = numpy.asarray(injected_lengths)[None, :]
    near = (pair_sims >= 0.9) & (numpy.abs(rows_m - injected_m) < LENGTH_DEBOUNCE_DELTA)
    return sims, near.any(axis=1).tolist()


def _loop_scores(
    row_vectors: list[list[float]],
    row_lengths: list[int],
    prompt_vec: list[float],
    injected_lengths: list[int],
    injected_vecs: list[list[float]],
) -> tuple[list[float], list[bool]]:
    """Per-pair Python cosine: the reference shape the vectorized path must
    match, and the only path without numpy (hermetic/stub runs)."""

    def cosine(a, b):
        dot = sum(x * y for x, y in zip(a, b, strict=True))
        na = math.sqrt(sum(x * x for x in a))
        nb = math.sqrt(sum(x * x for x in b))
        return dot / (na * nb) if na and nb else 0.0

    sims = [cosine(prompt_vec, v) for v in row_vectors]
    dups = [
        any(
            abs(row_len - inj_len) < LENGTH_DEBOUNCE_DELTA and cosine(v, inj) >= 0.9
            for inj_len, inj in zip(injected_lengths, injected_vecs, strict=True)
        )
        for row_len, v in zip(row_lengths, row_vectors, strict=True)
    ]
    return sims, dups


def _pool_vectors(store, pool: list[dict]) -> dict[tuple[str, int], list[float]]:
    """Vectors for pool rows, keyed by (vec_table, db_rowid).

    The table belongs in the key: the three vec0 tables' rowid sequences
    all start at 1 and overlap, so a bare-rowid merge would let one
    table's vector stand in for another's row. Stored vec0 vectors first
    (they are written on every upsert, so they are current); rows missing
    one fall back to the chunked embedder."""
    keys: dict[str, list[int]] = {}
    for row in pool:
        keys.setdefault(row["vec_table"], []).append(row["db_rowid"])
    stored: dict[tuple[str, int], list[float]] = {}
    with store._lock:
        for table, rowids in keys.items():
            for rowid, vector in store.stored_vectors(table, rowids).items():
                stored[(table, rowid)] = vector
    missing = [r for r in pool if (r["vec_table"], r["db_rowid"]) not in stored]
    if missing:
        embedded = store.embed([r["content"] for r in missing], origin="pool-fallback")
        for row, vector in zip(missing, embedded, strict=True):
            stored[(row["vec_table"], row["db_rowid"])] = vector
    return stored


def nudge_score(
    store,
    prompt: str,
    workspace: str | None = None,
    limit: int = 3,
    score_threshold: float = 0.5,
    injected_contents: list[str] | None = None,
    session_texts: list[str] | None = None,
    *,
    scope_to_workspace: bool = False,
    exclude_ids: set | None = None,
    include_episodic: bool = True,
) -> list[dict]:
    """Score the nudge pool against the prompt. Returns top results with
    framing data attached.

    - `injected_contents`: contents already injected this session (semantic
      debounce — candidates above similarity are suppressed, memory PRD req 3).
    - `session_texts`: accumulated session text for the context-containment
      check — a candidate already present in context is suppressed (req 6).
      Exact substring covers the fork-summary case; the caller passes the
      concatenated text.
    - `scope_to_workspace`: rank only the workspace's rows instead of
      boosting them — the session-start block's facts come from the
      project's pool, and a busier sibling repo must not crowd it out.
    - `exclude_ids`: rows skipped before the limit, so a caller filtering
      post-hoc (folded rows, already-shown rows) cannot starve the result
      below `limit` while eligible matches exist.
    - `include_episodic`: episodic summaries rank in the nudge by default;
      callers composing from deliberate rows only turn them off.
    """

    with spans.span("nudge.score", pool_size=0) as node:
        with spans.span("nudge.pool") as pool_node:
            pool = pool_query(store, workspace=workspace)
            if scope_to_workspace and workspace:
                pool = [row for row in pool if row["repo"] == workspace]
            vectors_by_rowid = _pool_vectors(store, pool)
            pool_node.set(rows=len(pool))
        node.set(pool_size=len(pool))
        if not pool:
            return []

        prompt_vec = store.embed([prompt], origin="nudge-prompt")[0]

        # Semantic debounce: embeddings of the injected contents, computed once
        # per prompt against the (sha256-keyed) embed cache — never per pool row.
        injected_vecs = (
            store.embed(list(injected_contents), origin="debounce") if injected_contents else []
        )
        node.set(debounced=len(injected_contents or []))

        # Context containment: exact substring in accumulated session text.
        joined_session = "\n".join(session_texts) if session_texts else ""

        paired = [r for r in pool if (r["vec_table"], r["db_rowid"]) in vectors_by_rowid]
        row_vectors = [vectors_by_rowid[(r["vec_table"], r["db_rowid"])] for r in paired]
        row_lengths = [len(r["content"]) for r in paired]
        injected_lengths = [len(c) for c in (injected_contents or [])]
        scorer = _vectorized_scores if numpy is not None else _loop_scores
        sims, dups = scorer(row_vectors, row_lengths, prompt_vec, injected_lengths, injected_vecs)

        scored: list[dict] = []
        for row, sim, dup in zip(paired, sims, dups, strict=True):
            # Semantic debounce: suppress near-duplicates of already-injected rows.
            if dup:
                continue

            # Context containment: already in context verbatim.
            if joined_session and row["content"] and row["content"] in joined_session:
                continue

            # Caller-carried exclusions (folded rows, already-delivered ids):
            # suppressed before scoring so the limit never spends slots on
            # rows the caller would only drop.
            if exclude_ids and row["id"] in exclude_ids:
                continue

            # Episodic summaries rank in the nudge; a deliberate-only caller
            # (the session-start block) turns them off here.
            if not include_episodic and row["tier"] == "episodic":
                continue

            score = sim
            if row.get("workspace_match"):
                score += 0.15
            if row.get("source") == "rule":
                score += 0.10
            score *= length_penalty(len(row["content"]))
            if row["tier"] == "episodic":
                score *= 0.85  # deliberate writes outrank summaries on ties

            if score < score_threshold:
                continue
            scored.append(
                {
                    "id": row["id"],
                    "content": row["content"],
                    "source": row["source"],
                    "tier": row["tier"],
                    "timestamp": row["timestamp"],
                    "created_at": row["created_at"],
                    "author_id": row["author_id"],
                    "author_type": row["author_type"],
                    "veracity": row["veracity"],
                    "score": round(score, 4),
                    "similarity": round(sim, 4),
                }
            )

        scored.sort(key=lambda r: r["score"], reverse=True)
        node.set(returned=len(scored[:limit]))
        return scored[:limit]
