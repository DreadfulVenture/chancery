"""Hub consolidation loop: claim, summarize, write, release-on-failure.

Replaces the package's sleep() path on the hub (AAAK ADR): no fallback
compression exists in this loop at all — when the LLM chain exhausts, no
summary is written, the claim is released, and the group retries next pass.
Consolidation is allowed to wait, never to fabricate.

The claim sets BOTH consolidated_at and consolidation_claimed_at so the
claim/release contract is visible to any repair tooling (the 564-orphans bug
class). Captures classify at ingest; fork_summary and exhibit rows are
excluded from consolidation input (input-classification ADR), so summaries
summarize speech, and no summary-of-summary compounding occurs.

The sleep prompt carries the exhibit-attribution rule at content level so
chunking that splits a document from its header cannot defeat it.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

CLAIM_COLUMNS = ("consolidated_at", "consolidation_claimed_at")

SLEEP_PROMPT = """Condense these conversation turns from {source} into 2-5 sentences of durable memory.

Rules, most important first:

1. Two speakers. [USER] and [HUMAN] lines are the user. [AGENT] and [ASSISTANT] lines are the AI assistant. Never record the assistant's work, findings, verdicts, or opinions as the user's.
2. Name the actor of every action. A turn with no stated subject is its own speaker acting: '[AGENT] APPROVE, 4 comments' means the agent approved with 4 comments, and is written 'the agent approved'. Never write 'was approved' or 'the PR approves'.
3. Keep what has NOT happened. If a turn says something is a draft, or was not posted, sent, merged, or run, the summary must say that in those words. Never turn a draft or a proposal into a completed act.
4. Some turns contain pasted material (logs, command output, file contents) rather than anything either speaker said. Attribute prose to its speaker; describe pasted material as an exhibit the session examined ('the boot log showed...'), never as either speaker's words. A turn quoting a whole prior conversation is a summary document, not speech. A chunk may start mid-document: judge content, not the row's label alone.
5. Keep concrete specifics: names, file paths, repos, PR and ticket numbers, commands, decisions, stated preferences, and problems left unresolved.
6. State only what the turns say. Never infer or invent. Drop pleasantries and tool narration.
7. Keep each summary under 1200 characters.

Output the summary text only: plain prose, no preamble, no heading, no bullet list, and no mention of these rules.

{memories}"""


def _extra_body() -> dict:
    """Per-request fields merged into the chat-completion body, from
    MEMORY_LLM_EXTRA_BODY as a JSON object. Some routes only accept a
    setting per request: Ollama rejects reasoning controls as Modelfile
    parameters, so a reasoning model served there deliberates on every
    summary — minutes per call — unless it is switched off here. Malformed
    JSON is ignored loudly rather than failing the summary."""
    raw = os.environ.get("MEMORY_LLM_EXTRA_BODY", "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        print(f"MEMORY_LLM_EXTRA_BODY ignored (not valid JSON): {error}", flush=True)
        return {}
    if not isinstance(parsed, dict):
        print("MEMORY_LLM_EXTRA_BODY ignored (not a JSON object)", flush=True)
        return {}
    return parsed


def _chat_completion(
    prompt: str,
    base_url: str | None = None,
    model: str | None = None,
    timeout: float | None = None,
    label: str = "consolidation",
) -> str | None:
    """One HTTP call to an OpenAI-compatible endpoint with the shared
    memory-LLM route (MEMORY_LLM_BASE_URL / MEMORY_LLM_MODEL /
    MEMORY_LLM_EXTRA_BODY / MEMORY_LLM_TIMEOUT). Returns None when no
    route is configured; raises on transport errors — callers release
    their claim and retry next pass. Every sleep-side LLM call goes
    through here so the route stays one thing; `label` names the caller
    in the failure log."""
    if timeout is None:
        timeout = float(os.environ.get("MEMORY_LLM_TIMEOUT", "300"))
    base_url = (base_url or os.environ.get("MEMORY_LLM_BASE_URL", "")).rstrip("/")
    model = model or os.environ.get("MEMORY_LLM_MODEL", "")
    if not base_url or not model:
        return None
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
    }
    body.update(_extra_body())
    request = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(body).encode(),
        headers={
            **{"Content-Type": "application/json"},
            **(
                {"Authorization": f"Bearer {os.environ['LLM_PROXY_API_KEY']}"}
                if os.environ.get("LLM_PROXY_API_KEY")
                else {}
            ),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read())
        text = payload["choices"][0]["message"]["content"].strip()
        return text or None
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        print(f"{label} LLM HTTP {error.code}: {body}", flush=True)
        raise
    except Exception as error:
        print(f"{label} LLM request failed: {error!r}", flush=True)
        raise


def summarize_via_llm(
    lines: list[str],
    source: str,
    base_url: str | None = None,
    model: str | None = None,
    timeout: float | None = None,
) -> str | None:
    """Summarize conversation turns through the shared route. Returns None
    when no route is configured; raises on transport errors — the caller
    releases the claim and retries next pass. There is no fallback
    compression in this loop."""
    return _chat_completion(
        SLEEP_PROMPT.format(source=source, memories="\n".join(lines)),
        base_url=base_url,
        model=model,
        timeout=timeout,
    )


def chunk_by_budget(lines: list[str], char_budget: int = 12000) -> list[list[str]]:
    """Simple budget chunking: fill a chunk until adding the next line would
    exceed the budget. (The package's context-window dance is not ours to
    inherit; our model route has a large window and we keep chunks modest.)"""
    chunks: list[list[str]] = []
    current: list[str] = []
    size = 0
    for line in lines:
        if current and size + len(line) > char_budget:
            chunks.append(current)
            current, size = [], 0
        current.append(line)
        size += len(line)
    if current:
        chunks.append(current)
    return chunks


def consolidate_group(
    store,
    source: str,
    row_ids: list[str],
    consolidator_version: str = "",
    summarizer=summarize_via_llm,
) -> dict:
    """Claim -> summarize -> write episodic -> mark. Release on failure.

    The claim transaction sets both columns; the release clears both. If the
    process dies between claim and write, the claim survives and repair
    tooling can see it (reclaim by clearing both columns)."""
    if not row_ids:
        return {"status": "empty"}
    placeholders = ",".join("?" for _ in row_ids)
    with store._lock, store.conn:
        rows = store.conn.execute(
            f"""SELECT id, content, source, repo, session_id,
                       consolidated_at, consolidation_claimed_at
                FROM working_memory WHERE id IN ({placeholders})""",
            tuple(row_ids),
        ).fetchall()
        if not rows:
            return {"status": "empty"}
        # Claim atomically: rows must be unclaimed. The UPDATE's rowcount is
        # the claim — already-claimed rows are skipped by the WHERE and the
        # count comes back short, so the group is contested, not re-summarized.
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        claimed_count = store.conn.execute(
            f"""UPDATE working_memory
                SET consolidated_at = ?, consolidation_claimed_at = ?,
                    consolidator_version = ?
                WHERE id IN ({placeholders})
                  AND consolidated_at IS NULL AND consolidation_claimed_at IS NULL""",
            (now, now, consolidator_version, *row_ids),
        ).rowcount
        if claimed_count != len(row_ids):
            store.conn.execute(
                f"""UPDATE working_memory
                    SET consolidated_at = NULL, consolidation_claimed_at = NULL,
                        consolidator_version = ''
                    WHERE id IN ({placeholders})
                      AND consolidated_at = ? AND consolidation_claimed_at = ?""",
                (now, now, *row_ids),
            )
            return {"status": "contested"}

    lines = [row["content"] for row in rows]
    source_label = rows[0]["source"] or source
    summary = None
    chunk_summaries = []
    try:
        for chunk in chunk_by_budget(lines):
            chunk_summary = summarizer(chunk, source_label)
            if chunk_summary:
                chunk_summaries.append(chunk_summary)
        if len(chunk_summaries) > 1:
            summary = summarizer(chunk_summaries, f"{source_label} (chunked)")
            if not summary:
                summary = " | ".join(chunk_summaries)
        elif chunk_summaries:
            summary = chunk_summaries[0]
    except Exception as error:
        summary_error = str(error)
    else:
        summary_error = ""

    if summary is None:
        # Release: no summary, rows retry next pass (AAAK ADR).
        with store._lock, store.conn:
            store.conn.execute(
                f"""UPDATE working_memory
                    SET consolidated_at = NULL, consolidation_claimed_at = NULL,
                        consolidator_version = ''
                    WHERE id IN ({placeholders})""",
                tuple(row_ids),
            )
        return {
            "status": "released",
            "reason": "llm-error" if summary_error else "llm-unavailable",
            "error": summary_error,
        }

    with store._lock, store.conn:
        # Provenance columns: the summary inherits the group's repo and
        # session (summary_of is the structured source-conversation link
        # the recall PRD wanted); app names the producing summarizer.
        repos = {row["repo"] for row in rows if row["repo"]}
        episodic = {
            "id": f"ep{time.time_ns():x}",
            "content": summary,
            "source": "sleep_consolidation",
            # The Z is a claim about the zone, so the value has to be UTC.
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "importance": 0.6,
            "metadata": {
                "source_label": source_label,
                "rows": len(row_ids),
                "consolidator_version": consolidator_version,
            },
            "repo": rows[0]["repo"] if len(repos) == 1 else "",
            "origin": "consolidated",
            "app": "memory-store",
            "summary_of": source,
        }
        store.upsert_episodic(episodic)
    return {"status": "ok", "rows": len(row_ids), "summary": summary, "episodic": episodic}


def pending_backlog(store, session_id: str | None = None) -> int:
    """Nudge-eligible backlog: captured speech rows awaiting consolidation.
    This is the paused-consolidation alarm's query (AAAK ADR). Pass a
    session_id to count one conversation's pending rows instead — the
    drain's force gate reads it before writing a force flag."""
    # `is not None`, never truthiness: an empty string is a real scope —
    # a client that sends "" means one conversation with an empty id, and
    # a truthy test would silently answer with the global backlog instead.
    session_clause = " AND session_id = ?" if session_id is not None else ""
    return store.conn.execute(
        f"""SELECT COUNT(*) AS n FROM working_memory
           WHERE origin = 'capture'
             AND kind = 'speech'
             AND consolidated_at IS NULL{session_clause}""",
        (session_id,) if session_id is not None else (),
    ).fetchone()["n"]


def next_consolidation_group(
    store,
    limit: int = 200,
    captured_by: str | None = None,
    unstamped_only: bool = False,
    stale_before: str | None = None,
) -> dict[str, list[str]]:
    """Group unconsolidated speech captures by conversation (session_id), the
    coarse one-summary-per-conversation shape. fork_summary and exhibit rows
    are never selected."""
    groups: dict[str, list[str]] = {}
    clauses = [
        "origin = 'capture'",
        "kind = 'speech'",
        "consolidated_at IS NULL",
    ]
    params: list = []
    if captured_by is not None:
        clauses.append("captured_by = ?")
        params.append(captured_by)
    if unstamped_only:
        clauses.append("consolidator_version = ''")
    if stale_before is not None:
        clauses.append("timestamp < ?")
        params.append(stale_before)
    params.append(limit)
    for row in store.conn.execute(
        f"""SELECT id, session_id FROM working_memory
           WHERE origin = 'capture'
             AND kind = 'speech'
             AND consolidated_at IS NULL
              AND {" AND ".join(clauses[3:]) if len(clauses) > 3 else "1"}
            ORDER BY timestamp LIMIT ?""",
        tuple(params),
    ).fetchall():
        groups.setdefault(row["session_id"], []).append(row["id"])
    # Conversations with no human in their line never consolidate (PRD
    # 20261114-lineage-gated-writes): a webhook bot's turns stay in session
    # search, but no episodic summary is ever distilled from them. One row
    # per group names the (machine, app) the class resolves through.
    for session_id in list(groups):
        named = store.conn.execute(
            """SELECT app, captured_by FROM working_memory
               WHERE session_id = ? ORDER BY timestamp LIMIT 1""",
            (session_id,),
        ).fetchone()
        if named is None:
            continue
        if store.conversation_class(named["captured_by"], named["app"], session_id) == "unanchored":
            del groups[session_id]
    return groups
