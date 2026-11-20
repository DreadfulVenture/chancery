"""Knowledge-base build pass (PRJ-175).

One composed doc per project: the previous doc plus the deliberate
`agent_memory` rows since the build cursor, rolled up by the same LLM
route consolidation uses (one call per project with work to do, zero
otherwise). The delta scan IS the hard line's statement — behavioural
rows live in other tables and never reach it.

Removal has two mechanical paths, both prompt-mediated in composition:
a forgotten row's text rides the tombstone into the fold as an
eviction ("the sheet must not state this"), so a bare forget leaves the
standing doc at the next build; a contradicting row leaves by recency
precedence. The scan also re-lists projects that have KB versions even
when their delta is empty, so a forget-only delta still builds.

A per-project debounce folds a correction burst into one build, and the
composite cursor (timestamp + row id) makes deferral lossless: skipping
a build never loses work, the next pass picks the delta up where the
cursor stopped — including the same-second tail a timestamp-only cursor
would cut off.

Known race (documented, not repaired): two machines composing the same
seq from disjoint deltas advance their own cursors, and the standing
doc carries only the winner's rows — the loser's delta stays behind its
cursor until a re-scan. The window is debounce-bounded and the escape
hatch is deleting a project's cursor (the full re-scan is idempotent
and tested); detection rides the usage-counters ticket.

On any failure — no route, chain error, over-length doc — the pass
releases: nothing emits, the cursor does not advance, the previous doc
stays standing, and the retry happens after a window that grows with the
failure streak (each consecutive failure doubles the wait, capped; a
landed build clears the streak), the way the consolidator's session
retries back off. The wait rides its own knobs, MEMORY_KB_RETRY_BASE and
MEMORY_KB_RETRY_MAX — not the success debounce's MEMORY_KB_DEBOUNCE — so
tuning one never moves the other. The build never fabricates a
replacement.

The fold itself is batched (the 2026-11 compose deadlock: one call
carrying a month-long delta over-asked the model, the over-length draft
released, and the ladder backed off forever — 365 silent releases on one
project while its cursor stood still). A pass consumes a project's
backlog in bounded batches: each batch is one compose call whose
rendered new rows fit MEMORY_KB_FOLD_CHARS (measured characters, not row
count, sized so the input plus the sheet's own output budget fits the
LLM context window), lands a version, and advances the cursor; the next
batch re-scans past it until the delta drains or MEMORY_KB_BATCHES_PER_PASS
caps the pass's LLM spend per project — the cursor keeps every landed
batch, so the next scheduled pass continues the drain, and a cap-limited
pass stamps no debounce: the backlog is old rows mid-drain, which the
debounce was never meant to throttle, so the next scheduler pass
continues it within a minute. A release then costs one small batch, not
the whole backlog. An over-length draft gets a bounded compress-to-fit
re-ask (the draft plus an explicit cut-to-N instruction) before
releasing: truncated prose never ships. And the deadlock cannot hide
again: from the threshold of consecutive releases on, every release
prints a loud alarm line naming the project and its count, and every
MEMORY_KB_RETRY_RESET-th consecutive release with no cursor movement
falls back to the base window for that attempt — a sawtooth, one
base-window attempt per reset — so a stuck project keeps attempting
instead of pinning at the cap.
"""

from __future__ import annotations

import json
import math
import os
import time

from memory_store.consolidation.consolidation import _chat_completion

KB_PROMPT = """Rewrite this project's knowledge sheet.

You receive the previous sheet (it may be empty), new fact rows written
since its last rebuild in recency order — NEWEST LAST — and, when any
exist, rows that were forgotten after being folded: their claims must
not appear in the sheet.

Rules, most important first:

1. Recency precedence: a new row that contradicts the standing text
   replaces it. Reconcile by rewriting; keep both versions only when
   they truly describe different things.
2. Forgotten rows: remove every claim that comes from one, whether the
   previous sheet states it or a new row restates it. Keep everything
   else untouched.
3. Keep what the rows establish as durable project knowledge:
   architecture rulings, current state, open threads, names of things.
   Drop pleasantries and narration.
4. Name the actor of every decision. State only what the rows say —
   never infer or invent.
5. Behavioural rules never appear here: a situation-to-conduct
   instruction is guidance, not project knowledge. If a row reads as
   one, drop it entirely.
6. Keep the sheet under {max_chars} characters: condense the standing
   text as the rows accumulate.

Output the sheet text only: plain prose, no preamble, no heading, no
mention of these rules.

Previous sheet:
{prior}

New fact rows:
{facts}

Forgotten rows (drop their claims from the sheet):
{forgotten}"""

KB_COMPRESS_PROMPT = """Cut this draft down.

The sheet below is {draft_chars} characters; it must stay under
{max_chars} characters. Rewrite it to under {max_chars} characters:
condense — merge duplicated points, drop the least durable detail, keep
the sheet's meaning. Output the cut sheet text only: plain prose, no
preamble, no mention of these rules.

Draft:
{draft}"""


def _max_len() -> int:
    return int(os.environ.get("MEMORY_KB_MAX_LEN", "6000"))


def _int_knob(name: str, default: int, minimum: int = 1) -> int:
    """One int knob, malformed values ignored loudly for the default
    (the _retry_knobs shape): a set-but-empty or non-numeric value must
    not take the pass with a zero cap or crash mid-loop. The floor keeps
    a value that would disable the thing the knob feeds from taking it
    silently either — MEMORY_KB_RETRY_RESET=1 would flat-line the ladder
    at its base window, the fixed cadence PRJ-256 exists to prevent."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        value = 0
    if value < minimum:
        print(
            f"{name}={raw!r} ignored (want an integer >= {minimum}): using default {default}",
            flush=True,
        )
        return default
    return value


def _checked_int(value, name: str, default: int, minimum: int = 1) -> int:
    """An explicitly-passed knob argument gets the same treatment as the
    environment value (_int_knob): below-floor or non-int values are
    ignored loudly for the default, so a direct caller cannot silently
    no-op a project — a zero batch_cap would build nothing, a zero
    reset_every would crash the ladder's modulo."""
    if value is None:
        return _int_knob(name, default, minimum)
    if not isinstance(value, int) or value < minimum:
        print(
            f"{name}={value!r} ignored (want an integer >= {minimum}): using default {default}",
            flush=True,
        )
        return default
    return value


def _retry_knobs() -> tuple[float, float]:
    """The release ladder's knobs, MEMORY_KB_RETRY_BASE / MEMORY_KB_RETRY_MAX.
    Malformed or non-positive values are ignored loudly for the defaults
    instead of taking the pass with them (the MEMORY_LLM_EXTRA_BODY shape):
    a set-but-empty value would kill every pass before its first project,
    a nan one would crash each release mid-loop and starve the projects
    behind it, a zero one would silently disable the ladder it feeds."""
    out: list[float] = []
    for name, default in (("MEMORY_KB_RETRY_BASE", 1800.0), ("MEMORY_KB_RETRY_MAX", 21600.0)):
        raw = os.environ.get(name)
        value = default
        if raw is not None:
            try:
                parsed = float(raw.strip())
            except ValueError:
                parsed = None
            if parsed is None or not math.isfinite(parsed) or parsed <= 0:
                print(
                    f"{name}={raw!r} ignored (want a positive number): using default {default}",
                    flush=True,
                )
            else:
                value = parsed
        out.append(value)
    return out[0], out[1]


# The compress-to-fit bound: an over-length draft is re-asked at most
# this many times before the over-length draft returns and the pass
# releases — a route that cannot cut to size keeps releasing, honestly.
_COMPRESS_RETRIES = 2


def compose_via_llm(
    project: str,
    prior_doc: str,
    lines: list[str],
    forgotten: list[tuple[str, str]] | None = None,
    base_url: str | None = None,
    model: str | None = None,
    timeout: float | None = None,
) -> str | None:
    """One KB roll-up call through the shared route, with
    compress-to-fit as the last resort: a draft over MEMORY_KB_MAX_LEN is
    re-asked with the draft plus an explicit cut-to-N instruction,
    bounded at _COMPRESS_RETRIES retries — exhausted, the over-length
    draft returns as-is and the pass releases it (truncated prose never
    ships). Returns None when no route is configured; raises on
    transport errors — the pass releases and retries after the failure
    ladder, like consolidation."""
    prompt = KB_PROMPT.format(
        prior=prior_doc or "(none yet — this is the first build)",
        facts="\n".join(lines) or "(none)",
        forgotten=(
            "\n".join(f"- {row_id}: {content}" for row_id, content in forgotten)
            if forgotten
            else "(none)"
        ),
        max_chars=_max_len(),
    )
    doc = _chat_completion(
        prompt,
        base_url=base_url,
        model=model,
        timeout=timeout,
        label="kb",
    )
    max_len = _max_len()
    retries = 0
    while doc and len(doc) > max_len and retries < _COMPRESS_RETRIES:
        retries += 1
        print(
            f"kb compose over-length ({project}): {len(doc)} chars, "
            f"re-asking cut to {max_len} ({retries}/{_COMPRESS_RETRIES})",
            flush=True,
        )
        doc = _chat_completion(
            KB_COMPRESS_PROMPT.format(max_chars=max_len, draft_chars=len(doc), draft=doc),
            base_url=base_url,
            model=model,
            timeout=timeout,
            label="kb",
        )
    return doc


def _meta_get(store, key: str) -> str:
    return store._meta_get(key) or ""


def _cursor_pair(store, project: str) -> tuple[str, str]:
    """The fold cursor as a (timestamp, row_id) pair. Older values are a
    bare timestamp; the empty id degrades the comparison to
    timestamp-only, so pre-composite cursors keep working."""
    raw = _meta_get(store, f"kb_cursor:{project}")
    timestamp, _, row_id = raw.partition("|")
    return timestamp, row_id


def _reship_pending(store, emit) -> None:
    """Re-emit KB versions whose enqueue was swallowed by a hub outage,
    the migration's pending-list pattern: the doc stands locally, the
    record rides again each pass until it lands, and the pending write
    commits in its own transaction (a boot that marks unshipped ids and
    dies before the next store write must not lose them)."""
    pending = [pid for pid in _meta_get(store, "kb_unshipped").split(",") if pid]
    if not pending or not emit:
        return
    still: list[str] = []
    for version_id in pending:
        row = store.conn.execute(
            "SELECT id, project, doc, inputs, build_seq, created_at "
            "FROM knowledge_base WHERE id = ?",
            (version_id,),
        ).fetchone()
        if row is None:
            continue
        payload = {
            "id": row["id"],
            "project": row["project"],
            "doc": row["doc"],
            "inputs": json.loads(row["inputs"]),
            "build_seq": row["build_seq"],
            "created_at": row["created_at"],
        }
        try:
            if emit("knowledge_base", payload, record_id=version_id) is False:
                still.append(version_id)
        except Exception:
            still.append(version_id)
    with store._lock, store.conn:
        store._meta_set("kb_unshipped", ",".join(still))


def _projects(store) -> list[str]:
    """Every project the fold could owe work to: repos with deliberate
    rows, plus any project that already has a KB version (a forget-only
    delta must still build)."""
    rows = store.conn.execute(
        """SELECT DISTINCT repo FROM agent_memory WHERE repo != ''
           UNION
           SELECT DISTINCT project FROM knowledge_base
           ORDER BY 1"""
    ).fetchall()
    return [row[0] for row in rows]


def delta_scan(
    store, chunk_cap: int | None = None, fact_budget: int | None = None
) -> dict[str, list]:
    """Deliberate rows past each project's composite cursor, the fold's
    only new-content input.

    Rows with no repo stamp belong to no project and fold nowhere. Two
    caps bound a pass, and both cut deterministically in (timestamp, id)
    order: the chunk cap bounds a first build over a legacy pool, and
    the char budget bounds the fold prompt — overflow leaves the NEWEST
    rows fresh for the next pass, so the fold walks a large delta
    oldest-first and stays lossless."""
    if chunk_cap is None:
        chunk_cap = int(os.environ.get("MEMORY_KB_CHUNK", "120"))
    if fact_budget is None:
        fact_budget = int(os.environ.get("MEMORY_KB_FACT_BUDGET", "12000"))
    out: dict[str, list] = {}
    for project in _projects(store):
        cursor_ts, cursor_id = _cursor_pair(store, project)
        rows = store.conn.execute(
            """SELECT id, content, timestamp FROM agent_memory
                WHERE repo = ? AND (timestamp, id) > (?, ?)
                  AND (author_type IS NULL OR author_type != 'agent')
                  AND id NOT IN (SELECT row_id FROM forget_tombstones
                                 WHERE table_name = 'agent_memory')
                ORDER BY timestamp, id""",
            (project, cursor_ts, cursor_id),
        ).fetchall()
        # Agent-attributed rows are outside the doc's input by policy (PRD
        # 20261114-lineage-gated-writes): a memory with no human in its
        # line surfaces through recall as a stamped observation and never
        # becomes standing background truth until a human session writes
        # its own row.
        taken: list = []
        size = 0
        for row in rows[:chunk_cap]:
            if taken and size + len(row["content"]) > fact_budget:
                break
            taken.append(row)
            size += len(row["content"])
        if taken:
            out[project] = taken
    return out


def _consumed_evictions(store, project: str) -> set:
    """Evictions already fed to a landed build for this project
    (PRJ-172): a tombstone whose claim the composer cannot fully drop
    would otherwise re-feed — and keep nonempty — every pass forever.
    Local meta, like the fold cursor: each machine consumes its own
    fold, converging as its own tombstones and versions converge."""
    return set(json.loads(_meta_get(store, f"kb_evictions_done:{project}") or "[]"))


def eviction_scan(store, project: str) -> list[tuple[str, str]]:
    """Forgotten rows whose content reached a prior fold: tombstoned
    agent ids that appear in one of the project's version journals and
    have not yet been fed to a landed build. The composer receives
    their text — an id alone cannot name the prose to drop. Tombstones
    without content (predating the column) are skipped; consumed ones
    stop re-feeding: a mark unclaimed turns the forget-only delta into
    a skip, so mass tombstones (the correction split) cannot make sleep
    build the same rows every debounce window forever."""
    consumed = _consumed_evictions(store, project)
    return [
        (row["row_id"], row["content"] or "")
        for row in store.conn.execute(
            """SELECT jt.row_id AS row_id, jt.content AS content
                 FROM forget_tombstones jt
                WHERE jt.table_name = 'agent_memory'
                  AND jt.content IS NOT NULL
                  AND EXISTS (
                      SELECT 1 FROM knowledge_base kb
                       WHERE kb.project = ?
                         AND instr(kb.inputs, '"' || jt.row_id || '"') > 0
                  )
                ORDER BY jt.row_id""",
            (project,),
        ).fetchall()
        if row["row_id"] not in consumed
    ]


# The delay's hard ceiling keeps every stamp inside 4-digit years: the
# gate compares UTC stamps as strings, and the ordering only holds while
# the format's width is fixed.
_MAX_RETRY_DELAY = 30 * 86400


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _stamp_release(
    store,
    project: str,
    retry_base: float,
    retry_cap: float,
    reset_every: int = 5,
    alarm_at: int = 10,
) -> None:
    """Stamps a failed project's next attempt on a growing ladder
    (PRJ-256): each consecutive failure doubles the wait, capped. A fixed
    window is its own outage cost — a client host's log for the Nov 6-13 provider
    outage shows 1199 released passes on one host alone, the failures
    dominated by the client's 300s read timeout (each dead attempt still
    completing server-side ~592 seconds in), with five failing projects
    on Nov 10-12 (eight on Nov 6-9) merging into one doomed attempt every
    several minutes per daemon during active stretches. The counter lives
    beside the fold cursor in per-machine meta and clears only on a
    successful build. Two deadlock guards ride the same counter (the
    2026-11 compose deadlock: one project released 365 times, silently,
    its cursor pinned for two months): from the alarm_at-th consecutive
    release on, every release prints a loud line naming the project and
    count, and every reset_every-th consecutive release falls back to
    the base window for that attempt instead of the doubled one — a
    sawtooth of one base-window attempt per reset_every releases, not a
    permanent return. A landed build is the only cursor movement and it
    also clears this counter, so the streak IS the no-progress run, and
    a project whose failures never clear keeps attempting instead of
    pinning at the cap. The caller wraps this in the store lock and an
    open transaction."""
    raw = _meta_get(store, f"kb_failures:{project}")
    try:
        prior = int(raw or 0)
    except (TypeError, ValueError):
        # A hand-corrupted value falls to the base window rather than
        # aborting the pass loop it would otherwise reach.
        prior = 0
    failures = prior + 1
    if failures % reset_every == 0:
        # No cursor movement for reset_every consecutive releases: back
        # to base. The counter keeps growing — the alarm below reads it.
        delay = retry_base
    else:
        # The clamp is the float-conversion guard: past ~2**32 the
        # multiply would overflow before min() could cap it. The cap
        # governs from the fifth failure anyway; the ceiling below does
        # from there on.
        delay = min(retry_base * 2 ** min(failures - 1, 32), retry_cap, _MAX_RETRY_DELAY)
    if failures >= alarm_at:
        print(
            f"KB RELEASE ALARM: {project} has released {failures} consecutive builds",
            flush=True,
        )
    store._meta_set(f"kb_failures:{project}", str(failures))
    store._meta_set(
        f"kb_next_build_at:{project}",
        time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + delay)),
    )


def _fold_slice(fresh: list, fold_budget: int) -> list:
    """The pass's per-call cut: the scan's fact budget bounds a first
    build over a legacy pool, this one bounds every batch's rendered
    lines — measured characters, not row count — so the compose input
    (prior sheet, batch, evictions, prompt scaffolding) plus the sheet's
    own output budget fits the LLM context window. A single row over
    budget still folds alone (the delta_scan shape): cutting it would
    strand its content past the cursor forever."""
    taken: list = []
    size = 0
    for row in fresh:
        # The rendered line is "[{timestamp}] {content}": the brackets,
        # the space, the timestamp.
        rendered = len(row["timestamp"]) + len(row["content"]) + 3
        if taken and size + rendered > fold_budget:
            break
        taken.append(row)
        size += rendered
    return taken


def kb_build_pass(
    store,
    summarizer=None,
    emit=None,
    debounce_seconds: float | None = None,
    retry_base: float | None = None,
    retry_cap: float | None = None,
    batch_cap: int | None = None,
    fold_budget: int | None = None,
    reset_every: int | None = None,
    alarm_at: int | None = None,
) -> dict:
    """One pass: scan, gate, roll up, store, emit. Returns accounting —
    built (versions landed), deferred (debounce window), released (chain
    failure or over-length doc; prior version stays standing), skipped
    (nothing to do). The cursor and the version move together in one
    transaction; a released project stamps its retry window on the
    growing ladder, so the delta re-folds after the window elapses.

    A project's backlog folds in bounded batches: each batch is one
    compose call whose rendered new rows fit fold_budget characters
    (MEMORY_KB_FOLD_CHARS, default one max_len — measured characters,
    not row count), lands a version, and advances the cursor; the next
    batch re-scans past it until the delta drains. batch_cap
    (MEMORY_KB_BATCHES_PER_PASS, default 8) bounds one pass's LLM spend
    per project — a month-long backlog must not hold the daemon's tick
    thread for an hour of compose calls, so it drains over scheduled
    passes, the cursor keeping every landed batch. A pass that ends on
    the cap stamps no debounce — the backlog is old rows mid-drain,
    which the debounce was never meant to throttle, so the next
    scheduled pass continues it within a minute; a drained pass stamps
    the success debounce and a released pass its retry window, as
    before. Evictions ride the first batch (a landing consumes them); a
    release mid-backlog costs one small batch, not the whole delta."""
    summarizer = summarizer or compose_via_llm
    if debounce_seconds is None:
        debounce_seconds = float(os.environ.get("MEMORY_KB_DEBOUNCE", "1800"))
    if retry_base is None or retry_cap is None:
        env_base, env_cap = _retry_knobs()
        retry_base = env_base if retry_base is None else retry_base
        retry_cap = env_cap if retry_cap is None else retry_cap
    # Explicit arguments get the env knob's own validation: a zero
    # batch_cap would silently build nothing, a zero reset_every would
    # crash the ladder's modulo — neither may no-op a project quietly.
    # reset_every's floor is 2: a reset of 1 flat-lines the ladder at
    # its base window, the fixed cadence PRJ-256 exists to prevent.
    batch_cap = _checked_int(batch_cap, "MEMORY_KB_BATCHES_PER_PASS", 8)
    fold_budget = _checked_int(fold_budget, "MEMORY_KB_FOLD_CHARS", _max_len())
    reset_every = _checked_int(reset_every, "MEMORY_KB_RETRY_RESET", 5, minimum=2)
    alarm_at = _checked_int(alarm_at, "MEMORY_KB_RELEASE_ALARM", 10)
    max_len = _max_len()
    results = {"built": 0, "deferred": 0, "released": 0, "skipped": 0}
    if emit:
        _reship_pending(store, emit)
    now = _now()
    scanned = delta_scan(store)
    for project in _projects(store):
        fresh = scanned.get(project, [])
        evictions = eviction_scan(store, project)
        if not fresh and not evictions:
            results["skipped"] += 1
            continue
        next_at = _meta_get(store, f"kb_next_build_at:{project}")
        if next_at and now < next_at:
            results["deferred"] += 1
            continue

        batches = 0
        capped = False
        released = False
        while True:
            if batches:
                # Landed batches moved the cursor: re-scan instead of
                # slicing the first scan — a month-long backlog exceeds
                # the chunk cap, so only the moving cursor reaches the
                # tail. The re-scan re-runs the same delta rules.
                fresh = delta_scan(store).get(project, [])
            if not fresh and not (batches == 0 and evictions):
                break  # drained, or the forget-only build already ran
            if batches >= batch_cap:
                # The cap bounds one pass's LLM spend per project; the
                # cursor keeps every landed batch, so the next scheduled
                # pass continues the drain — mid-drain, so no debounce.
                capped = True
                break
            taken = _fold_slice(fresh, fold_budget)
            lines = [f"[{row['timestamp']}] {row['content']}" for row in taken]
            current = store.kb_current(project)
            prior_doc = current[0]["doc"] if current else ""
            prior_seq = current[0]["build_seq"] if current else 0
            batch_evictions = evictions if batches == 0 else []
            try:
                doc = summarizer(project, prior_doc, lines, batch_evictions)
            except Exception as error:
                print(f"kb build failed ({project}): {error!r}", flush=True)
                doc = None
            if not doc or len(doc) > max_len:
                # Release: over-length counts as failure, never as
                # truncation material — the prompt carries the target,
                # and a build that misses it (after the composer's
                # bounded compress-to-fit re-asks) retries after the
                # growing window rather than shipping cut prose. One
                # small batch failed: batches already landed stand, and
                # the rest of the backlog stays past the cursor.
                if doc and len(doc) > max_len:
                    print(f"kb build released ({project}): doc over {max_len} chars", flush=True)
                with store._lock, store.conn:
                    _stamp_release(store, project, retry_base, retry_cap, reset_every, alarm_at)
                results["released"] += 1
                released = True
                break

            seq = prior_seq + 1
            # The ns suffix keeps ids distinct when two machines race the same
            # seq: each carries its own doc, the standing-winner rule in
            # kb_current (newest created_at at the top seq) converges the read,
            # and a replayed record re-inserts nothing.
            version_id = f"kb:{project}:{seq}:{time.time_ns():x}"
            created = _now()
            inputs = [row["id"] for row in taken]
            with store._lock, store.conn:
                # One transaction: the version and the composite cursor
                # land together, so a crash re-folds the same delta with
                # nothing half-written. The success debounce stamps once
                # the loop ends, after it — a cap-limited pass must not
                # stamp one.
                store._insert_kb(
                    {
                        "id": version_id,
                        "project": project,
                        "doc": doc,
                        "inputs": inputs,
                        "build_seq": seq,
                        "created_at": created,
                    }
                )
                if taken:
                    store._meta_set(
                        f"kb_cursor:{project}", f"{taken[-1]['timestamp']}|{taken[-1]['id']}"
                    )
                # A landed build ends the failure streak: the next release
                # starts the ladder at the base window again.
                store._meta_set(f"kb_failures:{project}", "")
            if emit:
                payload = {
                    "id": version_id,
                    "project": project,
                    "doc": doc,
                    "inputs": inputs,
                    "build_seq": seq,
                    "created_at": created,
                }
                try:
                    shipped = emit("knowledge_base", payload, record_id=version_id) is not False
                except Exception:
                    shipped = False
                if not shipped:
                    # The doc stands locally; the record rides the pending list
                    # until it lands on the queue (next pass re-emits).
                    with store._lock, store.conn:
                        still = [
                            pid
                            for pid in _meta_get(store, "kb_unshipped").split(",")
                            if pid and pid != version_id
                        ]
                        store._meta_set("kb_unshipped", ",".join([*still, version_id]))
            results["built"] += 1
            batches += 1
            if batch_evictions:
                with store._lock, store.conn:
                    done = json.loads(_meta_get(store, f"kb_evictions_done:{project}") or "[]")
                    store._meta_set(
                        f"kb_evictions_done:{project}",
                        json.dumps(sorted({*done, *(ev_id for ev_id, _ in batch_evictions)})),
                    )
        if batches and not capped and not released:
            # The drain ended with the delta caught up: the success
            # debounce, as before. A cap-limited pass stamps nothing —
            # the next scheduler pass continues the drain within a
            # minute; the debounce protects fresh bursts, not a drain.
            # A released pass already stamped its retry window.
            with store._lock, store.conn:
                store._meta_set(
                    f"kb_next_build_at:{project}",
                    time.strftime(
                        "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + debounce_seconds)
                    ),
                )
    return results
