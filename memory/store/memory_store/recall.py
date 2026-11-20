"""Explicit-recall scorer: lifted from mnemosyne-core (MIT, AxDSan/mnemosyne).

The lexical functions lift verbatim per the store ADR (copy, don't re-derive),
with two deliberate deletions per the memory PRD: the CJK and Cyrillic LIKE
fallbacks are dropped (our corpus never exercises them), and the recency
importance weighting is ours to change later without upstream negotiation.
The dict-out contract is preserved for consumers.
"""

from __future__ import annotations

import os
import re
import sqlite3

# --- stopword set (lifted) ------------------------------------------------

FACT_MATCH_STOPWORDS: set[str] = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "can",
    "could",
    "did",
    "do",
    "does",
    "for",
    "from",
    "had",
    "has",
    "have",
    "how",
    "i",
    "in",
    "is",
    "it",
    "its",
    "me",
    "my",
    "of",
    "on",
    "or",
    "our",
    "related",
    "should",
    "that",
    "the",
    "their",
    "there",
    "this",
    "to",
    "totally",
    "unrelated",
    "use",
    "uses",
    "was",
    "we",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "with",
    "you",
    "your",
    "again",
    "into",
    "not",
    "please",
    "somewhere",
    "supposed",
    "them",
    "then",
    "they",
    "whatever",
    "ask",
    "asking",
    "query",
    "question",
    "questions",
    "search",
    "retrieve",
    "recall",
}

_extra_stopwords = {
    token.strip().lower()
    for token in re.split(r"[,\s]+", os.environ.get("MEMORY_RECALL_EXTRA_STOPWORDS", ""))
    if len(token.strip()) >= 3
}
FACT_MATCH_STOPWORDS.update(_extra_stopwords)

_RECALL_TOKEN_RE = re.compile(r"(?u)[^\W_][\w]*(?:[_.:/+-]+[^\W_][\w]*)*")

RECALL_SYNONYMS: dict[str, tuple] = {
    "branding": ("brand", "positioning", "identity", "wording"),
    "preference": ("prefer", "prefers", "want", "wants", "reject", "rejects", "avoid", "grounded"),
    "professional": ("software", "builder"),
    "url": ("link", "profile"),
    "current": ("now", "live", "latest"),
    "feeling": ("feel", "feels"),
    "imposter": ("self-doubt", "doubt", "insecure"),
}


def is_meaningful_recall_token(token: str) -> bool:
    return len(token) >= 3 and token not in FACT_MATCH_STOPWORDS and not token.isdigit()


def recall_tokens(text: str) -> list[str]:
    return [
        token
        for token in _RECALL_TOKEN_RE.findall(text.lower())
        if is_meaningful_recall_token(token)
    ]


def hyphen_components(token: str) -> list[str]:
    if "-" not in token:
        return []
    return list(
        dict.fromkeys(part for part in token.split("-") if is_meaningful_recall_token(part))
    )


def component_unit_weight(components: list[str]) -> int:
    return len(components) if len(components) >= 2 else 1


def expand_hyphenated_tokens(tokens: list[str]) -> list[str]:
    expanded: list[str] = []
    seen: set[str] = set()
    for token in tokens:
        if token not in seen:
            seen.add(token)
            expanded.append(token)
        for part in hyphen_components(token):
            if part not in seen:
                seen.add(part)
                expanded.append(part)
    return expanded


def expanded_query_tokens(tokens: list[str]) -> list[str]:
    expanded: list[str] = []
    seen: set[str] = set()
    for token in expand_hyphenated_tokens(tokens):
        for candidate in (token, *RECALL_SYNONYMS.get(token, ())):
            if candidate not in seen:
                seen.add(candidate)
                expanded.append(candidate)
    return expanded


# --- lexical relevance (lifted; CJK tail dropped) ------------------------


def lexical_relevance(query_tokens: list[str], content: str, query_lower: str = "") -> float:
    content_lower = content.lower()
    if not query_tokens:
        return 0.0
    component_groups = [hyphen_components(token) for token in query_tokens]
    lexical_unit_count = sum(component_unit_weight(components) for components in component_groups)
    content_tokens = set(recall_tokens(content_lower))
    expanded_content_tokens = set(content_tokens)
    for token in list(content_tokens):
        expanded_content_tokens.update(
            part for part in re.split(r"[_:/.-]+", token) if is_meaningful_recall_token(part)
        )
    content_tokens = expanded_content_tokens
    if not content_tokens:
        return 0.0

    exact = 0
    partial = 0.0
    for token, components in zip(query_tokens, component_groups, strict=True):
        if token in content_tokens:
            exact += component_unit_weight(components)
            continue
        component_hits = sum(part in content_tokens for part in components)
        if len(components) >= 2 and component_hits >= 2:
            exact += component_hits
            continue
        if components:
            continue
        synonyms = RECALL_SYNONYMS.get(token, ())
        if synonyms and any(syn in content_tokens for syn in synonyms):
            partial += 0.75
            continue
        if len(token) >= 4 and any(
            token in ctoken or ctoken in token for ctoken in content_tokens if len(ctoken) >= 4
        ):
            partial += 0.4

    full_match = 1.0 if query_lower and query_lower in content_lower else 0.0
    return (exact + partial + full_match) / max(lexical_unit_count, 1)


# --- FTS candidate generation (lifted; CJK/Cyrillic fallbacks dropped) ----


def fts_query_terms(query: str) -> list[str]:
    terms = []
    for term in expanded_query_tokens(recall_tokens(query)):
        term = term.replace('"', '""').strip()
        if term:
            terms.append(f'"{term}"')
    return terms


def fts_search_working(conn: sqlite3.Connection, query: str, k: int = 20) -> list[dict]:
    """Search working-memory FTS; returns [{id, rank}]."""
    terms = fts_query_terms(query)
    if not terms:
        return []
    fts_query = " OR ".join(terms)
    rows = conn.execute(
        "SELECT id, rank FROM fts_working WHERE fts_working MATCH ? ORDER BY rank, id LIMIT ?",
        (fts_query, k),
    ).fetchall()
    return [{"id": r["id"], "rank": r["rank"]} for r in rows]


def fts_search_agent(conn: sqlite3.Connection, query: str, k: int = 20) -> list[dict]:
    """Search the deliberate pool's FTS; returns [{id, rank}] (same shape as
    the working search, over fts_agent)."""
    terms = fts_query_terms(query)
    if not terms:
        return []
    fts_query = " OR ".join(terms)
    rows = conn.execute(
        "SELECT id, rank FROM fts_agent WHERE fts_agent MATCH ? ORDER BY rank, id LIMIT ?",
        (fts_query, k),
    ).fetchall()
    return [{"id": r["id"], "rank": r["rank"]} for r in rows]


def fts_search_episodes(conn: sqlite3.Connection, query: str, k: int = 20) -> list[dict]:
    """Search episodic FTS; returns [{rowid, rank}]."""
    terms = fts_query_terms(query)
    if not terms:
        return []
    fts_query = " OR ".join(terms)
    rows = conn.execute(
        "SELECT rowid, rank FROM fts_episodes WHERE fts_episodes MATCH ? "
        "ORDER BY rank, rowid LIMIT ?",
        (fts_query, k),
    ).fetchall()
    return [{"rowid": r["rowid"], "rank": r["rank"]} for r in rows]


# --- explicit recall: fusion over the full store ---------------------------


def explicit_recall(
    store,
    query: str,
    limit: int = 12,
    vec_weight: float = 0.5,
    fts_weight: float = 0.3,
    importance_weight: float = 0.2,
    workspace: str | None = None,
) -> list[dict]:
    """Hybrid explicit recall over the judged tiers (dict-out contract).

    Deliberate rows read from agent_memory (the registry join renders
    session_id as the drill key); lexical relevance drives the score
    (the package's shape, minus recency decay — a policy knob we own
    now). Only deliberate rows are content results; raw captured turns
    surface as per-session pointers through find_conversations instead
    (ADR 20260926-recall-judged-rows). Episodic rows: FTS rank + optional
    vector cosine fused by the configurable weights, each carrying its
    source-conversation link.

    Scope ranks retrieval (curated-rules PRD): same-workspace rows get a
    soft additive bump so current-repo + global rise; it never filters.
    """
    query_lower = query.lower()
    query_toks = recall_tokens(query)

    # Agent-memory leg: FTS candidates rescored lexically. agent_memory is
    # the deliberate pool's home; its rows join the registry so the
    # rendered session_id is the same drill key the pointer surfaces carry
    # (the conversation id). Working-memory rows still carrying the origin
    # tag (replayed old records between boots) are folded in by the second
    # leg. The k rides well above the result limit because capture rows
    # outnumber deliberate rows by an order of magnitude in the working
    # FTS index — a low k would flood candidates with one session's raw
    # turns before any deliberate row was scored.
    candidates: dict[str, dict] = {}

    def _score_deliberate(row) -> None:
        relevance = lexical_relevance(query_toks, row["content"], query_lower)
        if relevance <= 0:
            return
        score = (
            relevance * fts_weight * 2.0
            + row["importance"] * importance_weight
            + relevance * relevance * 0.08
        )
        if workspace and row["repo"] == workspace:
            score += 0.15
        candidates[f"wm:{row['id']}"] = {
            "id": row["id"],
            "content": row["content"],
            "source": row["source"],
            "timestamp": row["timestamp"],
            "session_id": row["session_id"],
            "tier": "working",
            "kind": row["kind"],
            "author_id": row["author_id"],
            "author_type": row["author_type"],
            "veracity": row["veracity"],
            "importance": row["importance"],
            "score": round(score, 4),
            "lexical": round(relevance, 4),
        }

    for hit in fts_search_agent(store.conn, query, k=120):
        row = store.conn.execute(
            """SELECT a.id, a.content, a.source, a.timestamp,
                      s.client_conversation_id AS session_id, a.importance,
                      a.veracity, a.author_id, a.author_type, a.kind, a.repo
               FROM agent_memory a LEFT JOIN session s ON a.session_id = s.id
               WHERE a.id = ?""",
            (hit["id"],),
        ).fetchone()
        if row is not None:
            _score_deliberate(row)

    for hit in fts_search_working(store.conn, query, k=120):
        row = store.conn.execute(
            """SELECT id, content, source, timestamp, session_id, importance,
                      veracity, author_id, author_type, kind, repo
               FROM working_memory
               WHERE id = ?
                 AND origin = 'deliberate'
                 AND id NOT IN (SELECT id FROM agent_memory)""",
            (hit["id"],),
        ).fetchone()
        if row is not None:
            _score_deliberate(row)

    # Episodic leg: FTS rank fused with vector cosine when available.
    ep_hits = fts_search_episodes(store.conn, query, k=40)
    ep_rows = {}
    for hit in ep_hits:
        row = store.conn.execute(
            """SELECT rowid, id, content, source, timestamp, session_id, importance,
                      veracity, summary_of, repo
               FROM episodic_memory WHERE rowid = ?""",
            (hit["rowid"],),
        ).fetchone()
        if row is not None:
            ep_rows[row["id"]] = (row, hit["rank"])

    vec_closeness: dict[str, float] = {}
    if store.vec_available and ep_rows:
        query_vec = store.embed([query], origin="recall-query")[0]
        import struct

        blob = struct.pack(f"<{len(query_vec)}f", *query_vec)
        rowids = [r[0]["rowid"] for r in ep_rows.values()]
        # vec0's knn parser rejects `rowid IN (?)` with a single placeholder
        # ("A LIMIT or 'k = ?' constraint is required") while accepting
        # multi-element IN lists; pad the degenerate case. The IN set
        # dedupes, so the result is the single row either way.
        if len(rowids) == 1:
            rowids = rowids * 2
        placeholders = ",".join("?" for _ in rowids)
        for hit in store.conn.execute(
            f"""SELECT rowid, distance FROM vec_episodes
                WHERE rowid IN ({placeholders}) AND embedding MATCH ?
                ORDER BY distance LIMIT 40""",
            (*rowids, blob),
        ).fetchall():
            # sqlite-vec distance is (1 - cosine) for unit vectors.
            vec_closeness_by_rowid = 1.0 - hit["distance"]
            row = store.conn.execute(
                "SELECT id FROM episodic_memory WHERE rowid = ?", (hit["rowid"],)
            ).fetchone()
            if row:
                vec_closeness[row["id"]] = vec_closeness_by_rowid

    max_rank = max((abs(h[1]) for h in ep_rows.values()), default=1.0) or 1.0
    # Per-row source-conversation counts: one keyed COUNT per returned
    # episodic row (indexed by idx_wm_session), never a join over the pool.
    capture_counts: dict[str, int] = {}
    for row_id, (row, _) in ep_rows.items():
        source_session = row["summary_of"] or ""
        if source_session:
            capture_counts[row_id] = store.conn.execute(
                "SELECT COUNT(*) AS n FROM working_memory WHERE session_id = ?",
                (source_session,),
            ).fetchone()["n"]
    for row_id, (row, rank) in ep_rows.items():
        fts_norm = 1.0 - (abs(rank) / max_rank) if max_rank else 0.0
        vec_sim = vec_closeness.get(row_id, 0.0)
        score = fts_norm * fts_weight + vec_sim * vec_weight + row["importance"] * importance_weight
        if workspace and row["repo"] == workspace:
            score += 0.15
        source_session = row["summary_of"] or ""
        candidates[f"ep:{row_id}"] = {
            "id": row_id,
            "content": row["content"],
            "source": row["source"],
            "timestamp": row["timestamp"],
            "tier": "episodic",
            "summary_of": row["summary_of"],
            "veracity": row["veracity"],
            "importance": row["importance"],
            "score": round(score, 4),
            "fts": round(fts_norm, 4),
            "vec": round(vec_sim, 4),
        }
        if source_session:
            candidates[f"ep:{row_id}"]["source_conversation"] = {
                "session_id": source_session,
                "capture_count": capture_counts.get(row_id, 0),
            }

    ranked = sorted(candidates.values(), key=lambda r: r["score"], reverse=True)
    return ranked[:limit]
