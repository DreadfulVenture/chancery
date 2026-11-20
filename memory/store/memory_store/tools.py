"""MCP-style tool surface over the owned store.

Four handlers (remember, recall, curated verbs) written directly against our
tables — no package dispatch, no compatibility layer (store ADR: the sole
consumer is our own daemon in this repo). The gate on the floor is a stated
precondition, not a state machine: the agent puts the rule to the user in chat
and waits for an answer, then writes it active. The user has no way to call a
tool, so a confirmation step could only ever be the writing agent confirming
its own work. Cap enforcement (the global floor budget) lives in
the store; the tool layer surfaces the refusal with roster accounting.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, UTC

from memory_store.capture import detect_repo, resolve_workspace
from memory_store.curated import (
    _cosine,
    FIRE_THRESHOLD,
    RECONCILE_THRESHOLD,
    rule_neighbors,
    rule_search,
)
from memory_store.recall import explicit_recall, fts_search_working
from memory_store.store import (
    DEFAULT_PERSONA_TOPIC,
    SITUATIONAL_GRADERS,
    SITUATIONAL_STANCES,
    UNRECORDED_CONVERSATION,
    Store,
    normalize_signal,
)

DELIBERATE_LABELS = {
    "rule",
    "correction",
    "preference",
    "convention",
    "fact",
    "insight",
    "task",
    "decision",
    "stated",
}

# memory_forget reaches memory rows and nothing else; each other domain
# removes its own rows through its own family (ADR
# 20261110-commands-grouped-by-domain). The map is the refusal's pointer.
MEMORY_TABLES = ("working_memory", "agent_memory", "episodic_memory")
REMOVED_ELSEWHERE = {
    "tool_rules": "tool_rule_remove(rule_id=<tr_ id>)",
    "situational_rules": "rule_forget(rule_id=<id>)",
    "persona_rules": "persona_update(rule_id=<id>, status='retired')",
}

# Write-time similarity warning (ADR 20260926-write-dedup): threshold and
# cap mirror thatch's findSimilar/find_duplicates. Warn-only — the write
# always succeeds; the tending cycle is the cleanup, not a harder gate.
SIMILAR_WARN_THRESHOLD = 0.85
SIMILAR_WARN_LIMIT = 3

RECONCILE_HINT = (
    "Similar memories exist. Review with memory_get and reconcile: "
    "memory_update the row that should hold the point and memory_forget "
    "the redundant one — or accept as distinct."
)

# Consolidating duplicates makes rows longer, and past the injection budget
# recall keeps only the head and tail. Silent at write time otherwise: the
# middle is lost on every later read, not on this call.
OVER_BUDGET_HINT = (
    "Over the injection budget — recall will drop the middle of this memory. "
    "Split it, or tighten it so the whole thing survives."
)

# Recall framing contract (ADR 20260926-recall-judged-rows): judged rows are
# elided head+tail at this budget, the same figures the plugin and Cursor
# hook apply to injected memories, so all three surfaces agree byte-for-byte.
MAX_MEMORY_CHARS = 1200
MEMORY_ELISION = "…[truncated]…"
POINTER_PREVIEW_CHARS = 120
POINTER_DEFAULT_LIMIT = 8
LIST_DEFAULT_LIMIT = 50


def elide_content(content: str) -> tuple[str, bool]:
    """Head+tail elision at MAX_MEMORY_CHARS; returns (content, truncated)."""
    if len(content) <= MAX_MEMORY_CHARS:
        return content, False
    half = MAX_MEMORY_CHARS // 2
    return (
        f"{content[:half]}{MEMORY_ELISION}{content[-half:]}",
        True,
    )


class ToolError(ValueError):
    pass


class Tools:
    """Dict-in/dict-out, mirroring the MCP tool contract the daemon serves."""

    def __init__(self, store: Store, machine_id: str):
        self.store = store
        self.machine_id = machine_id

    # --- memory tools ---------------------------------------------------

    def _deliberate_pool(self, exclude: str = "") -> list[dict]:
        """The deliberate pool: agent_memory rows (the pool's home) plus
        working-memory stragglers not yet migrated — replays
        of old records between boots. `vec_table` says which vec table each
        row's db_rowid keys. A row serves from exactly one home: the
        straggler side hides any id the agent home already holds, so a
        crash-window twin is read once (the migration's drain closes the
        window)."""
        exclude = exclude or ""
        with self.store._lock:
            rows = [
                {**dict(r), "vec_table": "vec_agent"}
                for r in self.store.conn.execute(
                    """SELECT rowid AS db_rowid, id, source, content
                       FROM agent_memory WHERE id != ?""",
                    (exclude,),
                ).fetchall()
            ] + [
                {**dict(r), "vec_table": "vec_working"}
                for r in self.store.conn.execute(
                    """SELECT rowid AS db_rowid, id, source, content
                       FROM working_memory
                       WHERE origin = 'deliberate'
                         AND id NOT IN (SELECT id FROM agent_memory)
                         AND id != ?""",
                    (exclude,),
                ).fetchall()
            ]
        return rows

    def _pool_vectors(self, rows: list[dict]) -> dict[str, list[float]]:
        """Vectors for deliberate-pool rows, keyed by row id. Stored vec0
        vectors first (kept current whenever a row's content changes, which
        is the only kind of change that moves a vector); rows missing one
        fall back to the chunked embedder, the nudge pool's pattern."""
        out: dict[str, list[float]] = {}
        with self.store._lock:
            per_table: dict[str, list[dict]] = {}
            for row in rows:
                per_table.setdefault(row["vec_table"], []).append(row)
            for table, group in per_table.items():
                rowids = [r["db_rowid"] for r in group]
                stored = self.store.stored_vectors(table, rowids)
                for r in group:
                    if r["db_rowid"] in stored:
                        out[r["id"]] = stored[r["db_rowid"]]
        missing = [r for r in rows if r["id"] not in out]
        if missing:
            try:
                embedded = self.store.embed([r["content"] for r in missing], origin="pool-fallback")
            except Exception:
                embedded = []
            for row, vector in zip(missing, embedded, strict=False):
                out[row["id"]] = vector
        return out

    def _similar_to(self, row_id: str, content: str) -> list[dict]:
        """Deliberate-pool neighbors above the warn threshold, strongest
        first. The vector is a sha256 cache hit (the upsert just embedded
        this content); pool rows missing one fall back to the chunked
        embedder, the nudge pool's pattern. Vec unavailable → empty list,
        never an exception (honest silence, same as recall's knn leg)."""
        if not self.store.vec_available:
            return []
        rows = self._deliberate_pool(exclude=row_id)
        vecs = self._pool_vectors(rows)
        try:
            new_vec = self.store.embed([content], origin="remember-check")[0]
        except Exception:
            return []
        hits = []
        for row in rows:
            vec = vecs.get(row["id"])
            if vec is None:
                continue
            score = _cosine(new_vec, vec)
            if score >= SIMILAR_WARN_THRESHOLD:
                hits.append(
                    {
                        "id": row["id"],
                        "source": row["source"],
                        "score": round(score, 4),
                    }
                )
        hits.sort(key=lambda h: h["score"], reverse=True)
        return hits[:SIMILAR_WARN_LIMIT]

    def memory_remember(
        self,
        content: str = "",
        source: str = "",
        importance: float = 0.5,
        veracity: str = "unknown",
        scope: str = "project",
        author_type: str | None = None,
        cwd: str | None = None,
        conversation_id: str | None = None,
        *,
        app: str,
        initiator: str = "",
        **_,
    ) -> dict:
        """Store a deliberate memory. `source` is the classification label;
        provenance is the session registry — the client-injected
        `conversation_id` resolves (or creates) a registry row the write
        links to, so "why was this written?" walks row -> session ->
        history. A call with no conversation (bare scripts) anchors to the
        provenance-unrecorded placeholder instead of fabricating one. The
        repo column is resolved from `cwd`, never fabricated and never
        taken as a name. No context -> empty repo.
        `author_type` and `initiator` arrive daemon-decided (the gate
        strips any model-supplied value): attribution and lineage are the
        daemon's call, never the writer's (PRD 20261114-lineage-gated-writes)."""
        content = (content or "").strip()
        if not content:
            raise ToolError("content is required")
        label = (source or "").strip() or "fact"
        if label not in DELIBERATE_LABELS:
            raise ToolError(
                f"unknown source label {label!r}; use one of {sorted(DELIBERATE_LABELS)}"
            )
        if scope not in ("project", "global"):
            raise ToolError("scope must be project|global")
        repo = detect_repo(cwd) if cwd else ""
        conversation_id = (conversation_id or "").strip() or None
        session_id = self.store.get_or_create_session(
            # The machine is this daemon's, always — even a contextless
            # write knows where it ran. Only the conversation can be
            # unknown, and only the MIGRATED legacy pool anchors to the
            # legacy placeholder machine.
            machine=self.machine_id,
            tool=app,
            client_conversation_id=conversation_id or UNRECORDED_CONVERSATION,
            project=repo if conversation_id else "",
            # The gate decided this value (client-declared when it had to
            # create an unregistered conversation, else the stored one);
            # defaulting here would stamp a fresh row legacy-human and
            # fail the gate open on the caller's next write.
            initiator=initiator,
        )
        row_id = f"m{time.time_ns():x}"
        self.store.upsert_agent(
            {
                "id": row_id,
                "session_id": session_id,
                "scope": scope,
                "content": content,
                "source": label,
                "kind": "speech",
                # The write nudge asks the store for deliberate writes newer
                # than a watermark, and that question is asked of timestamp.
                # An unstamped row is invisible to it, so writing one would
                # never satisfy the nudge that asked for it. Sub-second
                # precision because the comparison is strictly greater-than
                # and two writes can land in the same second.
                "timestamp": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                "importance": importance,
                "veracity": veracity,
                # Attribution only ever arrives daemon-stamped ("agent" for
                # a conversation with no human voice in it); the model has
                # no author argument to fill (PRD 20261114).
                "author_type": author_type,
                "repo": repo,
                "app": app,
            }
        )
        result = {
            "status": "ok",
            "id": row_id,
            "source": label,
            "repo": repo,
            "similar_to": self._similar_to(row_id, content),
        }
        hints = [RECONCILE_HINT] if result["similar_to"] else []
        if len(content) > MAX_MEMORY_CHARS:
            result["over_budget"] = {"chars": len(content), "budget": MAX_MEMORY_CHARS}
            hints.append(OVER_BUDGET_HINT)
        if hints:
            result["hint"] = " ".join(hints)
        return result

    def memory_update(
        self,
        id: str = "",
        content: str | None = None,
        source: str | None = None,
        importance: float | None = None,
        veracity: str | None = None,
        **_,
    ) -> dict:
        """Correct a memory in place, keeping its id and provenance.
        Forget-then-remember loses the id and reads as two unrelated
        records; a memory that was wrong should end up corrected, not
        contradicted by a newer neighbour. The id routes itself: the
        deliberate home is agent_memory, whose working-memory stragglers
        (replayed records between boots) are edited in place the same
        way."""
        row_id = (id or "").strip()
        if not row_id:
            raise ToolError("id is required")
        if content is None and source is None and importance is None and veracity is None:
            raise ToolError("nothing to update: pass content, source, importance, or veracity")
        row = self.store.agent_row(row_id)
        where = "agent_memory"
        if row is None:
            where = "working_memory"
            row = self.store.conn.execute(
                "SELECT * FROM working_memory WHERE id = ?", (row_id,)
            ).fetchone()
            if row is None:
                # Recall hands out both tiers, so an episodic id arriving here is
                # the caller following the correction instruction without reading
                # the tier. Say where that row goes instead of "not found", which
                # reads as a broken tool and invites a retry.
                episodic = self.store.conn.execute(
                    "SELECT 1 FROM episodic_memory WHERE id = ?", (row_id,)
                ).fetchone()
                if episodic is not None:
                    raise ToolError(
                        f"{row_id} is an episodic summary, which is not edited: forget it "
                        "with memory_forget (table episodic_memory) and store anything "
                        "true as a new memory"
                    )
                raise ToolError(f"no working memory {row_id}")
        merged = dict(row)
        if content is not None:
            content = content.strip()
            if not content:
                raise ToolError("content cannot be emptied; use memory_forget")
            merged["content"] = content
        if source is not None:
            label = source.strip()
            if label not in DELIBERATE_LABELS:
                raise ToolError(
                    f"unknown source label {label!r}; use one of {sorted(DELIBERATE_LABELS)}"
                )
            merged["source"] = label
        if importance is not None:
            merged["importance"] = importance
        if veracity is not None:
            merged["veracity"] = veracity
        if where == "agent_memory":
            self.store.upsert_agent(merged, force=True)
        else:
            merged["metadata"] = json.loads(merged.pop("metadata_json", None) or "{}")
            self.store.upsert_capture(merged, force=True)
        # Content changed → the old adjudication is stale: pairs naming this
        # row may now duplicate something else and should re-flag.
        if content is not None:
            self.store.clear_dedup_verdicts(row_id)
        result = {
            "status": "ok",
            "id": row_id,
            "source": merged["source"],
            "content": merged["content"],
        }
        if len(merged["content"]) > MAX_MEMORY_CHARS:
            result["over_budget"] = {
                "chars": len(merged["content"]),
                "budget": MAX_MEMORY_CHARS,
            }
            result["hint"] = OVER_BUDGET_HINT
        return result

    def memory_forget(
        self, table: str = "", id: str = "", homes: tuple[str, ...] | None = None, **_
    ) -> dict:
        """`homes` is the delete's resolved home set, passed by the daemon
        wrapper so wire and delete share one resolution; a direct call
        resolves its own."""
        if not table or id in ("", None):
            raise ToolError("table and id are required")
        if table not in MEMORY_TABLES:
            if table in REMOVED_ELSEWHERE:
                raise ToolError(f"{table} is not memory; remove it with {REMOVED_ELSEWHERE[table]}")
            raise ToolError(f"unsupported table {table!r}; {', '.join(MEMORY_TABLES)} only")
        for home in homes or self.store.forget_homes(table, id):
            self.store.forget(home, id)
        return {"status": "ok", "forgotten": f"{table}:{id}"}

    # --- recall tools ----------------------------------------------------

    def _stamp_used(self, rows: list[tuple[str, str]]) -> None:
        """Usage telemetry for rows a tool is about to return to the agent
        (PRD 20261104, pull-based recall): every agent-initiated read
        counts, machine-side lookups never do. Homepage of the guarantee —
        stamps originate only here, from read-tool handlers, so a scorer
        or consolidation pass sharing the same query helpers cannot stamp
        anything."""
        self.store.stamp_usage(rows)

    def memory_recall(
        self,
        query: str = "",
        limit: int = 12,
        workspace: str | None = None,
        cwd: str | None = None,
        **_,
    ) -> dict:
        """Explicit recall over the judged tiers: deliberate memories +
        episodic summaries, head+tail elided at 1200 chars. Raw captured
        turns are NOT content results — they surface as per-session pointers
        through memory_find_conversations, and full text is reached via
        memory_list(session_id=...) / memory_get. The length penalty does
        not apply on this channel. Workspace from `cwd` (plugin-injected)
        or explicit override; no context -> no workspace boost."""
        if not (query or "").strip():
            raise ToolError("query is required")
        resolved_workspace = workspace or (resolve_workspace(cwd) if cwd else None)
        results = explicit_recall(
            self.store,
            query,
            limit=limit,
            workspace=resolved_workspace,
        )
        framed = []
        for result in results:
            row = dict(result)
            content, truncated = elide_content(row["content"])
            row["content"] = content
            if truncated:
                row["truncated"] = True
            framed.append(row)
        self._stamp_used([(result["id"], result["tier"]) for result in results])
        return {
            "status": "ok",
            "count": len(framed),
            "workspace": resolved_workspace,
            "results": framed,
        }

    def memory_find_conversations(
        self, query: str = "", limit: int = POINTER_DEFAULT_LIMIT, **_
    ) -> dict:
        """Which raw conversations match a query — one pointer per session,
        never turn content. Discovery for the raw transcript tier: pull a
        conversation's actual turns with memory_list(session_id=...), one
        turn's full text with memory_get."""
        if not (query or "").strip():
            raise ToolError("query is required")
        matched: dict[str, dict] = {}
        for hit in fts_search_working(self.store.conn, query, k=120):
            row = self.store.conn.execute(
                """SELECT id, content, session_id, timestamp FROM working_memory
                   WHERE id = ? AND origin = 'capture'""",
                (hit["id"],),
            ).fetchone()
            if row is None or not row["session_id"]:
                continue
            session = row["session_id"]
            # fts_search_working orders by rank, so the first hit seen for a
            # session is its best-matching turn and "best" is never replaced.
            entry = matched.setdefault(
                session,
                {
                    "session_id": session,
                    "matched_count": 0,
                    "best": row,
                },
            )
            entry["matched_count"] += 1
        pointers = []
        for session, entry in matched.items():
            best = entry["best"]
            totals = self.store.conn.execute(
                """SELECT COUNT(*) AS n, MIN(timestamp) AS first_ts,
                          MAX(timestamp) AS last_ts
                   FROM working_memory WHERE session_id = ?""",
                (session,),
            ).fetchone()
            # Already well under MAX_MEMORY_CHARS, so elide_content here
            # could never fire; memory_list's preview slices the same way.
            preview = best["content"][:POINTER_PREVIEW_CHARS]
            pointers.append(
                {
                    "session_id": session,
                    "matched_count": entry["matched_count"],
                    "total_count": totals["n"],
                    "first_ts": totals["first_ts"],
                    "last_ts": totals["last_ts"],
                    "preview": preview,
                    "tier": "pointer",
                    "_best_id": best["id"],
                }
            )
        pointers.sort(key=lambda p: p["matched_count"], reverse=True)
        pointers = pointers[: max(limit, 0)]
        # The pointer surfaces a conversation; the row the agent actually
        # read into that pointer is the best-matching turn, which is what
        # the usage stamp marks (PRD 20261104, pull-based recall).
        self._stamp_used([(p.pop("_best_id"), "working") for p in pointers])
        return {"status": "ok", "count": len(pointers), "pointers": pointers}

    def memory_list(
        self,
        table: str = "working_memory",
        origin: str | None = None,
        repo: str | None = None,
        source: str | None = None,
        session_id: str | None = None,
        limit: int = LIST_DEFAULT_LIMIT,
        **_,
    ) -> dict:
        """Inventory over metadata — no content in the listing. Default view
        is the judged tiers (deliberate working rows; episodic with
        table='episodic_memory'), the check-before-write browse surface.
        session_id switches to one conversation's rows, chronological —
        the drill-down step from a summary's source_conversation or a
        find_conversations pointer; episodic mode answers 'which summaries
        cover this session' (summary_of keyed read). The deliberate pool's
        home is agent_memory, so the deliberate view and the agent session
        drill read it there, with the working-table stragglers still
        carrying the origin tag folded into the deliberate view."""
        if table not in ("working_memory", "agent_memory", "episodic_memory"):
            raise ToolError(
                f"unsupported table {table!r}; working_memory, agent_memory or episodic_memory only"
            )
        if table == "agent_memory" and origin not in (None, "deliberate"):
            raise ToolError("agent_memory carries deliberate rows only")
        preview = POINTER_PREVIEW_CHARS
        deliberate_view = (
            table in ("working_memory", "agent_memory")
            and origin in (None, "deliberate")
            and not session_id
        )
        order = "timestamp ASC" if session_id else "timestamp DESC"
        if deliberate_view:
            # Both homes in one UNION ALL; the agent side joins the registry
            # so its session_id renders the same drill key the pointer
            # surfaces carry (the conversation id).
            clauses = ["1 = 1"]
            params: list = []
            if repo:
                clauses.append("repo = ?")
                params.append(repo)
            if source:
                clauses.append("source = ?")
                params.append(source)
            rows = self.store.conn.execute(
                f"""SELECT * FROM (
                       SELECT a.id AS id, a.source AS source, a.timestamp AS timestamp,
                              s.client_conversation_id AS session_id,
                              a.importance AS importance, a.veracity AS veracity,
                              a.repo AS repo, 'deliberate' AS origin,
                              a.app AS app, a.kind AS kind,
                              length(a.content) AS length,
                              substr(a.content, 1, {preview}) AS preview
                       FROM agent_memory a LEFT JOIN session s ON a.session_id = s.id
                       UNION ALL
                       SELECT id AS id, source AS source, timestamp AS timestamp,
                              session_id AS session_id,
                              importance AS importance, veracity AS veracity,
                              repo AS repo, origin AS origin, app AS app, kind AS kind,
                              length(content) AS length,
                              substr(content, 1, {preview}) AS preview
                       FROM working_memory
                       WHERE origin = 'deliberate'
                         AND id NOT IN (SELECT id FROM agent_memory))
                WHERE {" AND ".join(clauses)}
                ORDER BY {order}
                LIMIT ?""",
                (*params, max(limit, 0)),
            ).fetchall()
        elif session_id and table == "agent_memory":
            # Provenance drill: one session's written rows through the
            # registry join — the drill key is the same conversation id the
            # pointer surfaces carry.
            drill = ["s.client_conversation_id = ?"]
            drill_params: list = [session_id]
            if repo:
                drill.append("a.repo = ?")
                drill_params.append(repo)
            if source:
                drill.append("a.source = ?")
                drill_params.append(source)
            rows = self.store.conn.execute(
                f"""SELECT a.id, a.source, a.timestamp,
                           s.client_conversation_id AS session_id,
                           a.importance, a.veracity, a.repo, 'deliberate' AS origin,
                           a.app, a.kind,
                           length(a.content) AS length,
                           substr(a.content, 1, {preview}) AS preview
                    FROM agent_memory a LEFT JOIN session s ON a.session_id = s.id
                    WHERE {" AND ".join(drill)}
                    ORDER BY a.timestamp
                    LIMIT ?""",
                (*drill_params, max(limit, 0)),
            ).fetchall()
        else:
            clauses: list[str] = []
            params: list = []
            if session_id:
                # Episodic rows link to their source conversation through
                # summary_of, not their own session_id (which is 'default').
                key = "summary_of" if table == "episodic_memory" else "session_id"
                clauses.append(f"{key} = ?")
                params.append(session_id)
            if origin:
                clauses.append("origin = ?")
                params.append(origin)
            elif not session_id:
                # Default view excludes the raw capture tier; the working
                # table's deliberate tier is served by the deliberate_view
                # union instead of this branch, so the default here only
                # reaches episodic rows, which are all consolidated.
                clauses.append("origin = 'consolidated'")
            if repo:
                clauses.append("repo = ?")
                params.append(repo)
            if source:
                clauses.append("source = ?")
                params.append(source)
            where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
            # kind is a working-memory column only — episodic rows have no kind.
            kind_select = "kind" if table == "working_memory" else "'' AS kind"
            rows = self.store.conn.execute(
                f"""SELECT id, source, timestamp, session_id, importance, veracity,
                           repo, origin, app, {kind_select},
                           length(content) AS length,
                           substr(content, 1, {preview}) AS preview
                    FROM {table}{where}
                    ORDER BY {order}
                    LIMIT ?""",
                (*params, max(limit, 0)),
            ).fetchall()
        listing = [
            {
                "id": r["id"],
                "source": r["source"],
                "tier": "episodic" if table == "episodic_memory" else "working",
                "repo": r["repo"],
                "origin": r["origin"],
                "app": r["app"],
                "kind": r["kind"],
                "timestamp": r["timestamp"],
                "importance": r["importance"],
                "veracity": r["veracity"],
                "length": r["length"],
                "preview": r["preview"],
            }
            for r in rows
        ]
        self._stamp_used([(r["id"], r["tier"]) for r in listing])
        return {"status": "ok", "count": len(listing), "table": table, "rows": listing}

    def knowledge_read(self, project: str = "", conversation_id: str | None = None, **_) -> dict:
        """The standing knowledge-base doc per project (or every project).
        Read-only by design: the doc is composed by sleep, and correcting
        it is correcting any memory — write the truer fact (a
        contradicting row wins by recency) or forget the row that carried
        a claim (its text rides the tombstone out of the sheet at the
        next build).

        A conversation whose client deferred its session-start facts gets
        them here, current content in ranked order, and the fetch clears
        that conversation's first-tool hold. The doc already arrived with
        the session-start block, so a call naming no project returns the
        facts alone."""
        name = (project or "").strip() or None
        conversation_id = (conversation_id or "").strip()
        deferred = self.store.session_facts_for(conversation_id) if conversation_id else None
        out: dict = {"status": "ok"}
        if deferred:
            facts = []
            for row in self.store.deliberate_rows(deferred["fact_ids"]):
                content, truncated = elide_content(row["content"])
                fact = {
                    key: row.get(key)
                    for key in ("id", "timestamp", "created_at", "veracity", "author_type")
                }
                fact["content"] = content
                if truncated:
                    fact["truncated"] = True
                facts.append(fact)
            self.store.session_facts_mark_fetched(conversation_id)
            self._stamp_used([(fact["id"], "working") for fact in facts])
            out["project"] = deferred["project"]
            out["facts"] = facts
            if name is None:
                return out
        docs = self.store.kb_current(name)
        self._stamp_used([(doc["id"], "kb") for doc in docs])
        out["docs"] = docs
        return out

    def compliance_report(self, window_days: int | None = None, **_) -> dict:
        """The compliance ladder's review aggregates (PRJ-179): how many
        conversations were observed and how many pulled (the no-nudge base
        rate), the escalation events with their per-level conversion, and
        the max level reached. The operator's review reads this — dead tiers are
        removed by a code change on what it shows, never a runtime switch."""
        report = self.store.compliance_aggregates(window_days)
        report["status"] = "ok"
        return report

    def rule_recall(
        self,
        situation: str = "",
        limit: int = 8,
        workspace: str | None = None,
        cwd: str | None = None,
        **_,
    ) -> dict:
        """Ask the store what its rules already say about a situation: the
        agent formulates the moment it is in; the store answers (PRJ-172).
        Same engine as the automatic fire path — embed + cosine, shared
        confidence, sibling suppression — with pull-shaped gates: a lower
        threshold, low-confidence rules returned and marked quiet, no fire
        telemetry. Read tools stamp usage (PRJ-178); the compliance ladder
        credits this verb through the client pull report, not usage rows —
        rules carry no usage_counters row."""
        if not (situation or "").strip():
            raise ToolError("situation is required")
        resolved_workspace = workspace or (resolve_workspace(cwd) if cwd else None)
        results = rule_search(self.store, situation, limit=limit, workspace=resolved_workspace)
        return {
            "status": "ok",
            "count": len(results),
            "workspace": resolved_workspace,
            "rules": results,
        }

    def memory_get(self, id: str = "", table: str | None = None, **_) -> dict:
        """Fetch one record by id. Ids route themselves: 'ep…' -> episodic,
        otherwise agent_memory first (the deliberate home) then working —
        recall cannot match ids (lexical search matches content), so this
        is the verification path for a specific record."""
        row_id = (id or "").strip()
        if not row_id:
            raise ToolError("id is required")
        if table:
            if table not in ("working_memory", "agent_memory", "episodic_memory"):
                raise ToolError(
                    f"unsupported table {table!r}; working_memory, agent_memory "
                    "or episodic_memory only"
                )
            homes: tuple[str, ...] = (table,)
        elif row_id.startswith("ep"):
            homes = ("episodic_memory",)
        else:
            homes = ("agent_memory", "working_memory")
        row = None
        for home in homes:
            row = self.store.conn.execute(
                f"SELECT * FROM {home} WHERE id = ?", (row_id,)
            ).fetchone()
            if row is not None:
                self._stamp_used([(row_id, "episodic" if home == "episodic_memory" else "working")])
                return {"status": "ok", "found": True, "table": home, "record": dict(row)}
        tombstoned = any(self.store.is_tombstoned(home, row_id) for home in homes)
        return {"status": "ok", "found": False, "table": homes[0], "tombstoned": tombstoned}

    def memory_find_duplicates(
        self, threshold: float = SIMILAR_WARN_THRESHOLD, limit: int = 20, **_
    ) -> dict:
        """Duplicate-candidate pairs over the deliberate pool, strongest
        first, grouped into clusters. A cluster is a connected component:
        its members are joined by a chain of above-threshold pairs, so the
        ends of a long one are often unrelated to each other and it is not
        evidence that the group is a single topic. Verdict-marked pairs are
        skipped — the agent decides duplicates via memory_mark_checked."""
        if not self.store.vec_available:
            return {"status": "ok", "pairs": [], "clusters": []}
        rows = self._deliberate_pool()
        vec_by_id = self._pool_vectors(rows)
        marked = self._marked_pairs()
        pairs: list[dict] = []
        for i, a in enumerate(rows):
            va = vec_by_id.get(a["id"])
            if va is None:
                continue
            for b in rows[i + 1 :]:
                vb = vec_by_id.get(b["id"])
                if vb is None:
                    continue
                score = _cosine(va, vb)
                if score < threshold:
                    continue
                pair_key = tuple(sorted((a["id"], b["id"])))
                if pair_key in marked:
                    continue
                pairs.append(
                    {
                        "a": a["id"],
                        "a_source": a["source"],
                        "b": b["id"],
                        "b_source": b["source"],
                        "score": round(score, 4),
                    }
                )
        pairs.sort(key=lambda p: p["score"], reverse=True)
        # Clusters come from every pair above threshold, not from the page
        # of pairs being returned — grouping the truncated list makes the
        # membership an artifact of where `limit` happened to cut.
        clusters = self._clusters(pairs)
        returned = pairs[:limit]
        # The agent's eyes landed on the returned page plus every cluster
        # member; the rest of the pool was machine-crunched, not read, so
        # only those names stamp.
        seen_ids = {m for pair in returned for m in (pair["a"], pair["b"])}
        for cluster in clusters:
            seen_ids.update(cluster)
        self._stamp_used([(row_id, "working") for row_id in sorted(seen_ids)])
        return {"status": "ok", "pairs": returned, "clusters": clusters}

    def _marked_pairs(self) -> set[tuple[str, str]]:
        with self.store._lock:
            rows = self.store.conn.execute("SELECT row_a, row_b FROM dedup_verdicts").fetchall()
        return {(r["row_a"], r["row_b"]) for r in rows}

    def _clusters(self, pairs: list[dict]) -> list[list[str]]:
        adjacency: dict[str, set[str]] = {}
        for pair in pairs:
            adjacency.setdefault(pair["a"], set()).add(pair["b"])
            adjacency.setdefault(pair["b"], set()).add(pair["a"])
        seen: set[str] = set()
        clusters: list[list[str]] = []
        for node in adjacency:
            if node in seen:
                continue
            component: list[str] = []
            stack = [node]
            while stack:
                current = stack.pop()
                if current in seen:
                    continue
                seen.add(current)
                component.append(current)
                stack.extend(adjacency[current] - seen)
            if len(component) >= 3:
                clusters.append(sorted(component))
        clusters.sort()
        return clusters

    def memory_mark_checked(
        self,
        a: str = "",
        b: str = "",
        verdict: str = "",
        grounds: str | None = None,
        **_,
    ) -> dict:
        """Record the verdict for a duplicate-candidate pair so it stops
        re-flagging: duplicate (merge — update one, forget the other),
        supplement (keep both), contradiction (resolve, then update),
        unrelated (similar wording, different point). Verdicts are
        machine-local and cleared on either member's next content change
        (a merge may create new duplicate relationships — re-flagging is
        intended)."""
        row_a = (a or "").strip()
        row_b = (b or "").strip()
        if not row_a or not row_b or row_a == row_b:
            raise ToolError("two distinct row ids are required (a, b)")
        if verdict not in ("duplicate", "supplement", "contradiction", "unrelated"):
            raise ToolError("verdict must be duplicate|supplement|contradiction|unrelated")
        lo, hi = sorted((row_a, row_b))
        with self.store._lock, self.store.conn:
            for row_id in (lo, hi):
                known = self.store.conn.execute(
                    "SELECT 1 FROM agent_memory WHERE id = ? "
                    "UNION ALL SELECT 1 FROM working_memory WHERE id = ?",
                    (row_id, row_id),
                ).fetchone()
                if known is None:
                    raise ToolError(f"no working memory {row_id}")
            self.store.conn.execute(
                """INSERT INTO dedup_verdicts (row_a, row_b, verdict,
                              grounds, origin_machine, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                           strftime('%Y-%m-%dT%H:%M:%SZ','now'))
                   ON CONFLICT(row_a, row_b) DO UPDATE SET
                     verdict = excluded.verdict,
                     grounds = excluded.grounds,
                     origin_machine = excluded.origin_machine,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')""",
                (lo, hi, verdict, grounds, self.machine_id),
            )
        return {"status": "ok", "pair": [lo, hi], "verdict": verdict}

    # --- curated: persona floor -------------------------------------------

    def persona_codify(
        self,
        statement: str = "",
        topic: str = "",
        provenance: str | None = None,
        **_,
    ) -> dict:
        """Write an active floor rule. The user has already agreed to it in
        conversation — nothing here can check that, which is the whole
        reason the precondition is stated rather than enforced.

        Enforces the global budget; an over-budget write is refused with
        the roster attached so the compensating trade is composed
        in-session. Any rule may be reworded or retired to make room, via
        ordinary persona_update calls, then retry."""
        statement = (statement or "").strip()
        if not statement:
            raise ToolError("statement is required")
        rule_id = int(time.time_ns() % (10**9))
        result = self.store.upsert_persona(
            {
                "id": rule_id,
                "statement": statement,
                "status": "active",
                "topic": topic or DEFAULT_PERSONA_TOPIC,
                "provenance": provenance,
                "origin_machine": self.machine_id,
            }
        )
        if result["status"] == "refused":
            return {
                "status": "refused",
                "reason": "floor budget exceeded",
                "budget_state": result["budget_state"],
                "hint": "reword or retire any rule (persona_update) to make room, then retry",
            }
        result["id"] = rule_id
        return result

    def persona_update(
        self,
        rule_id: int = 0,
        statement: str | None = None,
        status: str | None = None,
        topic: str | None = None,
        **_,
    ) -> dict:
        """Reword, retopic, or retire any floor rule. Budget enforced at the
        write; refusal carries roster accounting for composing the trade.
        Same precondition as persona_codify: the user agreed to this edit in
        chat first."""
        if not rule_id:
            raise ToolError("rule_id is required")
        row = self.store.conn.execute(
            "SELECT statement, status, topic FROM persona_rules WHERE id = ?", (rule_id,)
        ).fetchone()
        if row is None:
            raise ToolError(f"no persona rule {rule_id}")
        result = self.store.upsert_persona(
            {
                "id": rule_id,
                "statement": statement or row["statement"],
                "status": status or row["status"],
                "topic": topic if topic is not None else row["topic"],
            }
        )
        return result

    def persona_reinforce(self, rule_id: int = 0, **_) -> dict:
        """Record that a floor rule was applied this session."""
        if not rule_id:
            raise ToolError("rule_id is required")
        self.store.apply_feedback(rule_id, "persona", "apply", 1.0, self.machine_id)
        return {"status": "ok", "reinforced": rule_id}

    def persona_list(self, **_) -> dict:
        rows = self.store.conn.execute(
            """SELECT id, statement, status, topic, apply_count, last_applied_at,
                      created_at, updated_at
               FROM persona_rules WHERE status != 'retired'
               ORDER BY topic, id"""
        ).fetchall()
        return {"status": "ok", "count": len(rows), "rules": [dict(r) for r in rows]}

    # --- curated: situational (behaviors + predictions) --------------------

    def rule_codify(
        self,
        situation: str = "",
        statement: str = "",
        rationale: str | None = None,
        grader: str = "",
        stance: str = "",
        provenance: str | None = None,
        cwd: str | None = None,
        id: int | None = None,
        **_,
    ) -> dict:
        """Codify (or with `id`, amend in place) a situational rule —
        behavior when grader=agent, prediction when grader=user. No user
        gate: a wrong rule fires when matched and gets feedback-trained
        out; the ask the write performs is the STORE's (PRJ-172) — a
        candidate whose situation is near-identical to a standing rule
        comes back as a reconcile result (grade that one, or pass its id
        here with the amended text) instead of a silent clone, and a
        0.6x sibling rides the response as a post-write warning. Scope is
        resolved from `cwd`, never named directly; no context -> empty
        scope: 'fires everywhere' is a judgment, never a default.

        `grader` and `stance` have no defaults for the same reason. Each
        decides what kind of row this is — whose behaviour it describes,
        and whether it directs or predicts — and a default would file a
        prediction about the user as the agent's own directive whenever
        the caller left them out (ADR 20260918)."""
        situation = (situation or "").strip()
        statement = (statement or "").strip()
        rationale = (rationale or "").strip() or None
        if not situation or not statement:
            raise ToolError("situation and statement are required")
        if grader not in SITUATIONAL_GRADERS:
            raise ToolError(
                "grader is required: 'agent' for your own discipline, 'user' for "
                "the user's decision tendencies"
            )
        if stance not in SITUATIONAL_STANCES:
            raise ToolError(
                "stance is required: 'prescriptive' for a rule to follow, "
                "'descriptive' for a prediction of what the user tends to do"
            )
        try:
            max_length = int(os.environ.get("MEMORY_RULE_LENGTH_MAX", "1200"))
        except ValueError as error:
            raise ToolError("MEMORY_RULE_LENGTH_MAX must be an integer") from error
        if max_length < 1:
            raise ToolError("MEMORY_RULE_LENGTH_MAX must be positive")
        payload_length = len(situation) + len(statement) + len(rationale or "")
        if payload_length > max_length:
            raise ToolError(
                f"situational rule payload is {payload_length} characters; "
                f"MEMORY_RULE_LENGTH_MAX is {max_length}"
            )

        if id is not None:
            row = self.store.conn.execute(
                "SELECT id, situation, statement, rationale, scope, "
                "provenance, origin_machine FROM situational_rules WHERE id = ?",
                (id,),
            ).fetchone()
            if row is None:
                raise ToolError(f"rule id {id} does not exist")
            self.store.upsert_situational(
                {
                    "id": row["id"],
                    "situation": situation,
                    "statement": statement,
                    "rationale": rationale if rationale is not None else row["rationale"],
                    "grader": grader,
                    "stance": stance,
                    "scope": resolve_workspace(cwd) if cwd else (row["scope"] or ""),
                    "status": "active",
                    "provenance": provenance if provenance is not None else row["provenance"],
                    "origin_machine": row["origin_machine"],
                }
            )
            return {
                "status": "ok",
                "updated": row["id"],
                "grader": grader,
                "stance": stance,
                "scope": resolve_workspace(cwd) if cwd else (row["scope"] or ""),
            }

        resolved_scope = resolve_workspace(cwd) if cwd else ""
        # The duplicate check degrades explicitly: without embeddings the
        # write proceeds and the response names the missed check.
        try:
            neighbors = rule_neighbors(self.store, situation, limit=3)
            embed_ok = True
        except Exception:
            neighbors = []
            embed_ok = False
        if neighbors and neighbors[0]["similarity"] >= RECONCILE_THRESHOLD:
            match = neighbors[0]
            return {
                "status": "reconcile",
                "matched": {k: match[k] for k in ("id", "situation", "statement", "similarity")},
                "guidance": (
                    "a rule with this situation already stands: grade it with "
                    f"rule_feedback(id={match['id']}), or pass id={match['id']} "
                    "here with the amended text — do not write a second copy"
                ),
            }
        row_id = int(time.time_ns() % (10**9))
        self.store.upsert_situational(
            {
                "id": row_id,
                "situation": situation,
                "statement": statement,
                "rationale": rationale,
                "grader": grader,
                "stance": stance,
                "scope": resolved_scope,
                "status": "active",
                "provenance": provenance,
                "origin_machine": self.machine_id,
            }
        )
        result = {"status": "ok", "rule_id": row_id, "grader": grader, "scope": resolved_scope}
        if not embed_ok:
            result["reconcile_skipped"] = (
                "no embeddings available; the situation-duplicate check did not run"
            )
        else:
            siblings = [
                {"id": n["id"], "situation": n["situation"], "similarity": n["similarity"]}
                for n in neighbors
                if n["similarity"] >= FIRE_THRESHOLD
            ]
            if siblings:
                result["similar"] = siblings
                result["reconcile"] = (
                    "the write landed beside an existing sibling: grade the older "
                    "rule with rule_feedback and forget the clone with "
                    "rule_forget(rule_id=<this rule_id>) "
                    "when the pair restates one fact — keep both only when they "
                    "describe different moments"
                )
        return result

    def rule_feedback(
        self,
        rule_id: int = 0,
        signal: str = "",
        delta: float = 1.0,
        polarity: str = "",
        grounds: str | None = None,
        record_id: str | None = None,
        **_,
    ) -> dict:
        """Grade a surfaced rule. signal confirm/disconfirm are full weight;
        'soft' is a weak signal (0.25) and carries no direction of its own,
        so it requires `polarity`. There is deliberately no default: a
        caller who says nothing and a caller who means disconfirm are
        different, and collapsing them wrote soft_refute rows nobody
        chose. `grounds` records WHY
        (audit data, never interpreted). Accumulative; confidence is
        derived. The store normalizes onto the canonical wire vocabulary
        (confirm|soft_confirm|soft_refute|refute) — the returned `signal`
        is that canonical value and the returned `delta` is the EFFECTIVE
        weight (0.25 for soft), both of which are what the sync record
        carries — the wire must not ship the agent-facing shorthand or the
        pre-weight delta. `record_id` (supplied by the emitter) binds the
        local apply to the wire record so the hub's relay-back replay is
        deduped instead of doubling the origin's counters."""
        # `id` is the key every agent-facing surface renders (fired-rule
        # injections, rule_list output); the schema name is `rule_id`.
        # Accepting the rendered key at this boundary keeps both correct
        # paths converging (ADR 20260921). Stringified ids tolerated: the
        # injection's JSON has been copied with the id as a string.
        try:
            rule_id = int(rule_id or _.get("id") or 0)
        except (TypeError, ValueError):
            raise ToolError("rule_id and signal (confirm|disconfirm|soft) required") from None
        if not rule_id or signal not in ("confirm", "disconfirm", "soft"):
            raise ToolError("rule_id and signal (confirm|disconfirm|soft) required")
        if signal == "soft" and polarity not in ("confirm", "disconfirm"):
            # Names the argument: the caller who trips this is usually one
            # who stated a direction in `grounds` prose, not knowing
            # polarity is passed separately.
            raise ToolError(
                "signal 'soft' requires the separate polarity argument "
                "(confirm|disconfirm) — stating it in grounds does not set it"
            )
        effective = 1.0 if signal != "soft" else 0.25
        canonical = normalize_signal(signal, polarity)
        self.store.apply_feedback(
            rule_id,
            "situational",
            canonical,
            effective,
            self.machine_id,
            grounds=grounds,
            record_id=record_id,
        )
        return {"status": "ok", "rule_id": rule_id, "signal": canonical, "delta": effective}

    def rule_list(self, kind: str = "", **_) -> dict:
        """kind filters by grader: 'behavior' -> agent, 'prediction' -> user."""
        if kind == "behavior":
            where, params = "WHERE grader = 'agent'", ()
        elif kind == "prediction":
            where, params = "WHERE grader = 'user'", ()
        else:
            where, params = "", ()
        rows = self.store.conn.execute(
            f"""SELECT id, situation, statement, rationale, grader, stance, scope,
                       status, confirm_count, disconfirm_count, fire_count,
                       last_fired_at
                FROM situational_rules {where} ORDER BY id""",
            params,
        ).fetchall()
        return {"status": "ok", "count": len(rows), "rules": [dict(r) for r in rows]}

    def rule_forget(self, rule_id: int = 0, **kwargs) -> dict:
        """Tombstone a situational rule that should not exist at all, such
        as a clone rule_codify flagged. A rule that is merely wrong is graded
        down with rule_feedback instead, which keeps its evidence."""
        try:
            rule_id = int(rule_id or kwargs.pop("id", 0) or 0)
        except (TypeError, ValueError):
            raise ToolError("rule_id must be a situational rule id") from None
        if not rule_id:
            raise ToolError("rule_id is required")
        exists = self.store.conn.execute(
            "SELECT 1 FROM situational_rules WHERE id = ?", (rule_id,)
        ).fetchone()
        if exists is None:
            raise ToolError(f"no situational rule {rule_id}")
        self.store.forget("situational_rules", rule_id)
        return {"status": "ok", "forgotten": f"situational_rules:{rule_id}", "rule_id": rule_id}


# Which tools are told the calling client. The name is transport provenance,
# not an argument: Cursor cannot set a tool argument at all, so anything a
# client could put in the payload would be a claim rather than a fact. The
# daemon reads it off the MCP connection and injects it here, and it is
# absent from the schemas below so no client can offer one.
TOOLS_WITH_APP = frozenset({"memory_remember"})

# Daemon-side gate: which tools a connection may call, applied by
# daemon.call_tool. One prefix per domain, and a domain's whole lifecycle
# lives under its prefix (ADR 20261110-commands-grouped-by-domain): a new
# operation joins its domain's family, a new domain adds a prefix here.
TOOL_PREFIXES = ("memory_", "knowledge_", "persona_", "rule_", "tool_rule_", "compliance_")

# The write surface for lineage-gated access (PRD
# 20261114-lineage-gated-writes): every tool that changes stored state or
# steers future behavior. Reading is open; these gate on the calling
# conversation's lineage.
WRITE_TOOLS = frozenset(
    {
        "memory_remember",
        "memory_update",
        "memory_forget",
        "memory_mark_checked",
        "persona_codify",
        "persona_update",
        "persona_reinforce",
        "rule_codify",
        "rule_forget",
        "rule_feedback",
        "tool_rule_add",
        "tool_rule_remove",
        "tool_rule_promote",
        "tool_rule_copy",
    }
)

# memory_remember labels an unanchored caller may use: checkable claims
# about the world. The steering labels (rule, preference, convention,
# correction, stated) are how a poisoned write becomes standing conduct,
# so they need a human in the conversation's line.
OBSERVATION_LABELS = frozenset({"fact", "insight", "decision", "task"})

# Reads whose provenance pointers (session ids) are redacted for callers
# with no human in their line: an injected bot must not learn a valid
# parent session id to claim as its own. memory_list's own rows carry no
# session id today, but it stays in the set so the redaction follows what
# a read returns if that ever changes.
LINEAGE_REDACT_READS = frozenset(
    {"memory_recall", "memory_list", "memory_find_conversations", "memory_get"}
)

UNANCHORED_WRITE_MESSAGE = (
    "refused: this conversation does not trace to a human-started session "
    "(PRD 20261114-lineage-gated-writes). Writes that steer behavior — rules, "
    "persona, corrections, deletions — need a human in the line. "
    "memory_remember with source fact|insight|decision|task is available for "
    "observations; a human session can adopt them."
)

UNREGISTERED_CONVERSATION_MESSAGE = (
    "refused: the conversation is not registered with the memory store, so "
    "its lineage cannot be checked (PRD 20261114-lineage-gated-writes). "
    "Writes that steer behavior need a registered human-started session."
)

TOOL_DEFINITIONS = [
    {
        "name": "memory_remember",
        "description": (
            "Store a durable memory immediately. The user's corrections and "
            "rulings on your process must be stored with this tool IN THE "
            "SAME TURN, as the very next action — before amending plans, "
            "code, or responses. Deferring the write into plans or "
            "responses loses it when the task ends first. Write on ONE "
            "signal — do not wait for a pattern, repeat, or confirmation. "
            "`source` is the classification "
            "label: rule (situational, phrased 'When <situation>: <rule>'), "
            "correction, preference, convention, fact, or insight. Never "
            "requires approval — memory is the agent's own tool. This "
            "instruction lives in the tool definition, not in a stored "
            "rule, so it survives a DB reset. When the response carries "
            "similar_to, reconcile instead of stacking copies: memory_update "
            "the row that should hold the point and memory_forget the "
            "redundant one, or record the pair genuinely distinct with "
            "memory_mark_checked."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "The memory content."},
                "source": {
                    "type": "string",
                    "description": "Classification label.",
                    "enum": sorted(DELIBERATE_LABELS),
                },
                "scope": {
                    "type": "string",
                    "description": (
                        "Ranking metadata only, never a filter. 'project' "
                        "(default) affinity-boosts the row in its project's "
                        "recall once ranking consumes it; 'global' stays "
                        "neutral everywhere. Pass 'global' only for facts "
                        "that hold across every project."
                    ),
                    "enum": ["project", "global"],
                },
                "importance": {"type": "number", "description": "0.0-1.0."},
                "veracity": {
                    "type": "string",
                    "description": "stated | inferred | tool | imported | unknown.",
                },
                "cwd": {
                    "type": "string",
                    "description": (
                        "Session working directory; the client injects it and "
                        "the project is resolved from it. Pass it only when a "
                        "result came back with an empty repo."
                    ),
                },
            },
            "required": ["content"],
        },
    },
    {
        "name": "memory_recall",
        "description": (
            "Search the judged tiers: deliberate memories and episodic "
            "summaries, head+tail elided at 1200 chars (truncated: true) "
            "with full rows one memory_get away. Episodic rows carry "
            "source_conversation, the session they summarize. Raw captured "
            "turns are NOT returned here — discover which conversations "
            "matched with memory_find_conversations, then pull turns with "
            "memory_list(session_id=...)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural-language query."},
                "limit": {"type": "integer", "description": "Maximum results."},
                "workspace": {
                    "type": "string",
                    "description": "Optional override; resolved from cwd by default.",
                },
                "cwd": {
                    "type": "string",
                    "description": "Session working directory (plugin-injected).",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "memory_find_conversations",
        "description": (
            "Which raw conversations match a query — one pointer per "
            "session (matched turn count, time span, first-line preview), "
            "strongest first, never turn content. The drill-down path: "
            "memory_list(session_id=...) for the conversation's rows, "
            "memory_get for one turn's full text."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural-language query."},
                "limit": {
                    "type": "integer",
                    "description": "Maximum pointers (default 8).",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "memory_list",
        "description": (
            "Inventory over metadata — no content rows. Default view: the "
            "judged tiers (deliberate memories; episodic summaries with "
            "table='episodic_memory') for check-before-write. session_id "
            "switches to one conversation's rows chronologically — the "
            "drill-down from a summary's source_conversation or a "
            "find_conversations pointer; episodic mode with session_id "
            "answers 'which summaries cover this session'. Full text of "
            "any row: memory_get."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "table": {
                    "type": "string",
                    "enum": ["working_memory", "agent_memory", "episodic_memory"],
                    "description": "Default working_memory.",
                },
                "origin": {
                    "type": "string",
                    "description": "Filter: capture | deliberate | consolidated.",
                },
                "repo": {"type": "string", "description": "Filter by repo stamp."},
                "source": {"type": "string", "description": "Filter by source label."},
                "session_id": {
                    "type": "string",
                    "description": (
                        "One conversation's rows (summary_of on episodic; "
                        "the provenance drill on agent_memory)."
                    ),
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum rows (default 50).",
                },
            },
        },
    },
    {
        "name": "memory_get",
        "description": (
            "Fetch one record by id: full row with veracity/tier framing. "
            "recall is query-based and cannot match ids, so use this to "
            "verify or inspect a specific record (id prefix routes the "
            "table: 'ep…' -> episodic, otherwise agent_memory first, then "
            "working)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Row id."},
                "table": {
                    "type": "string",
                    "enum": ["working_memory", "agent_memory", "episodic_memory"],
                    "description": "Override; resolved from the id prefix by default.",
                },
            },
            "required": ["id"],
        },
    },
    {
        "name": "knowledge_read",
        "description": (
            "Read the project knowledge base: the standing composed doc "
            "per project (inputs lists the memory row ids it reflects). "
            "Correcting it is the same as correcting any memory: write "
            "the truer fact with memory_remember (it wins by recency at "
            "the next build) or forget the row that carried the claim "
            "(its text rides the tombstone out of the sheet). When the "
            "session-start block says this conversation's matched facts are "
            "waiting, call this with no arguments: it returns those facts "
            "(the doc already arrived with the block)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "project": {
                    "type": "string",
                    "description": "Project name (repo). Empty = all projects.",
                },
            },
        },
    },
    {
        "name": "compliance_report",
        "description": (
            "The compliance ladder's review aggregates: conversations "
            "observed vs pulled (the no-nudge base rate), escalation "
            "events with per-level conversion, and the max level reached. "
            "Not memory content — no pull credit for reading it."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "window_days": {
                    "type": "integer",
                    "description": "Restrict events to this many days; omit for all time.",
                },
            },
        },
    },
    {
        "name": "memory_find_duplicates",
        "description": (
            "Duplicate-candidate pairs over the deliberate memory pool, "
            "strongest first, grouped into clusters. A cluster is a chain: "
            "its members are linked by above-threshold pairs, so a large one "
            "is usually several topics rather than one, and its ends may be "
            "unrelated. Read the rows before deciding anything is redundant. "
            "Verdict-marked pairs are skipped. The first step of store "
            "tending; resolve pairs with memory_mark_checked."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "threshold": {
                    "type": "number",
                    "description": "Minimum cosine similarity (default 0.85).",
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum pairs returned (default 20).",
                },
            },
        },
    },
    {
        "name": "memory_mark_checked",
        "description": (
            "Record the verdict for a duplicate-candidate pair so it stops "
            "re-flagging: duplicate (merge via memory_update + memory_forget), "
            "supplement (keep both), contradiction (resolve first), unrelated "
            "(similar wording, different point). Verdicts clear on either "
            "member's next content change — a merge may create new duplicate "
            "relationships, and re-flagging is intended."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "a": {"type": "string", "description": "First row id."},
                "b": {"type": "string", "description": "Second row id."},
                "verdict": {
                    "type": "string",
                    "enum": ["duplicate", "supplement", "contradiction", "unrelated"],
                    "description": "The pair's relationship.",
                },
                "grounds": {
                    "type": "string",
                    "description": "Why this verdict (audit trail).",
                },
            },
            "required": ["a", "b", "verdict"],
        },
    },
    {
        "name": "memory_update",
        "description": (
            "Correct an existing working memory in place, keeping its id "
            "and provenance. Use this when a memory is wrong or has gone "
            "stale — stacking a corrected copy alongside it leaves recall "
            "returning both and no way to tell which one holds. Only the "
            "fields passed change. Working memory only: an episodic row is "
            "a machine-written summary, so forget it with memory_forget "
            "rather than rewriting it."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Row id to correct."},
                "content": {"type": "string", "description": "Replacement text."},
                "source": {
                    "type": "string",
                    "description": "Classification label.",
                    "enum": sorted(DELIBERATE_LABELS),
                },
                "importance": {"type": "number", "description": "0.0-1.0."},
                "veracity": {
                    "type": "string",
                    "description": "stated | inferred | tool | imported | unknown.",
                },
            },
            "required": ["id"],
        },
    },
    {
        "name": "memory_forget",
        "description": (
            "Delete a memory row by table and id. The delete is tombstoned "
            "so a delayed replay of the original write cannot resurrect it. "
            "Use this for a memory that should not exist at all; a memory "
            "that is merely wrong is memory_update's job, which keeps the "
            "id. Neither needs permission. Rules are not memories: a "
            "situational rule goes with rule_forget, a tool rule with "
            "tool_rule_remove, a floor rule with persona_update."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "table": {"type": "string", "enum": list(MEMORY_TABLES)},
                "id": {"type": "string", "description": "Row id to forget."},
            },
            "required": ["table", "id"],
        },
    },
    {
        "name": "persona_codify",
        "description": (
            "Write a floor rule (always-on, every session, every project). "
            "PRECONDITION: propose the rule to the user in chat, in full, "
            "and wait for an answer before calling this. Unlike a memory, "
            "which is yours to write, the floor is text the user pays for on "
            "every request — the user decides what goes in it. The floor has a "
            "global character budget; an over-budget write is refused with "
            "the roster — reword or retire a rule to make room, then retry."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "statement": {"type": "string", "description": "The rule text."},
                "topic": {
                    "type": "string",
                    "description": (
                        "Heading the rule renders under in the published floor "
                        "(free text, e.g. comments, communication, git, review). "
                        "Call persona_list first and reuse an existing topic "
                        "unless the rule genuinely starts a new one."
                    ),
                },
                "provenance": {"type": "string", "description": "Where it came from."},
            },
            "required": ["statement"],
        },
    },
    {
        "name": "persona_list",
        "description": "List floor rules with budget accounting.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "persona_update",
        "description": (
            "Reword, retopic, or retire any floor rule. Budget enforced at "
            "the write; refusal carries roster accounting for composing "
            "the trade."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "rule_id": {"type": "integer"},
                "statement": {"type": "string", "description": "New rule text."},
                "status": {"type": "string", "enum": ["active", "retired"]},
                "topic": {"type": "string", "description": "New heading for the rule."},
            },
            "required": ["rule_id"],
        },
    },
    {
        "name": "persona_reinforce",
        "description": "Record that a floor rule was applied this session.",
        "input_schema": {
            "type": "object",
            "properties": {
                "rule_id": {"type": "integer"},
            },
            "required": ["rule_id"],
        },
    },
    {
        "name": "rule_recall",
        "description": (
            "Ask the store what its rules already say about a situation "
            "you are in or are about to enter. Compose the moment "
            "('I am about to force-push a reviewed branch'); returns "
            "matching rules strongest-first with situation, statement, "
            "grades, and origin scope. Low-confidence rules come back "
            "marked quiet. Ask before gated actions and before writing a "
            "rule — the answer may already stand."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "situation": {
                    "type": "string",
                    "description": (
                        "The moment, as a short statement of what is happening or imminent."
                    ),
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum rules to return (default 8).",
                },
                "cwd": {
                    "type": "string",
                    "description": (
                        "Session working directory; the client injects it and "
                        "it boosts project-scoped rules. Pass it only when a "
                        "result came back without one."
                    ),
                },
            },
            "required": ["situation"],
        },
    },
    {
        "name": "rule_codify",
        "description": (
            "Codify a situational rule. grader='agent' for own discipline "
            "(behavior), grader='user' for the user's decision tendencies "
            "(prediction). No user confirmation needed; rules encode "
            "discipline, not shortcuts. The store is asked first: a "
            "near-identical standing rule returns as a reconcile result "
            "(grade or amend it) instead of writing a clone."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "situation": {"type": "string", "description": "When this applies."},
                "statement": {"type": "string", "description": "The rule itself."},
                "rationale": {"type": "string", "description": "Why it exists."},
                "grader": {
                    "type": "string",
                    "enum": ["agent", "user"],
                    "description": (
                        "agent for your own discipline, user for the user's "
                        "decision tendencies. Required; there is no default."
                    ),
                },
                "stance": {
                    "type": "string",
                    "enum": ["prescriptive", "descriptive"],
                    "description": (
                        "prescriptive for a rule to follow, descriptive for a "
                        "prediction of what the user tends to do. Required; "
                        "there is no default."
                    ),
                },
                "provenance": {"type": "string", "description": "Origin context."},
                "cwd": {
                    "type": "string",
                    "description": (
                        "Session working directory; the client injects it and "
                        "the scope is resolved from it. Pass it only when a "
                        "result came back with an empty scope."
                    ),
                },
                "id": {
                    "type": "integer",
                    "description": (
                        "Amend an existing rule in place (from a reconcile "
                        "result or rule_list): the situation/statement are "
                        "rewritten on that row and the edit converges fleet-wide."
                    ),
                },
            },
            "required": ["situation", "statement", "grader", "stance"],
        },
    },
    {
        "name": "rule_feedback",
        "description": (
            "Grade a surfaced rule: confirm (relevant/ham), disconfirm "
            "(spam), or soft (weak signal, 0.25 weight, requires polarity). "
            "Trains the classifier; low-confidence rules stop firing."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "rule_id": {"type": "integer", "description": "The graded rule."},
                "id": {
                    "type": "integer",
                    "description": (
                        "Alias for rule_id — the id as rendered in fired-rule "
                        "injections and rule_list output."
                    ),
                },
                "signal": {
                    "type": "string",
                    "enum": ["confirm", "disconfirm", "soft"],
                },
                "delta": {"type": "number", "description": "Weight of the signal."},
                "polarity": {
                    "type": "string",
                    "enum": ["confirm", "disconfirm"],
                    "description": (
                        "Required when signal is soft, which has no direction "
                        "of its own. Rejected if omitted — there is no default."
                    ),
                },
                "grounds": {
                    "type": "string",
                    "description": "Why this signal: the observed relevance or irrelevance.",
                },
            },
            "required": ["rule_id", "signal"],
        },
    },
    {
        "name": "rule_list",
        "description": "List curated rules with confidence accounting.",
        "input_schema": {
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["persona", "situational", ""],
                    "description": "Filter by kind; empty lists both.",
                }
            },
        },
    },
    {
        "name": "rule_forget",
        "description": (
            "Forget a situational rule that should not exist at all, such "
            "as a clone rule_codify flagged beside an existing sibling. The "
            "delete is tombstoned so a delayed replay cannot resurrect it. A "
            "rule that is merely wrong in this situation is graded down "
            "with rule_feedback instead. Needs no permission."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "rule_id": {"type": "integer", "description": "The rule to forget."},
                "id": {
                    "type": "integer",
                    "description": (
                        "Alias for rule_id — the id as rendered in fired-rule "
                        "injections and rule_list output."
                    ),
                },
            },
            "required": ["rule_id"],
        },
    },
]
