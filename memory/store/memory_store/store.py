"""Owned memory store: schema, upsert, forget, and embedding.

Replaces the mnemosyne-memory package's storage layer (ADR
20260911-replace-mnemosyne-library). The working/episodic/FTS/vec0 table shapes
lift from the package under MIT; the curated tables (persona_rules,
situational_rules) and feedback side tables are ours per the curated-rules PRD
and the record-log sync PRD.

Embedding uses fastembed with the configured model — default
BAAI/bge-small-en-v1.5 (384-dim, ~34MB); MEMORY_EMBEDDING_MODEL switches it
(with MEMORY_EMBEDDING_DIM for models outside the known-dims table). Vectors
live in sqlite-vec vec0 tables whose dimension is recorded in store_meta: a
model or dimension change drops and re-backfills the tables at open, recomputing
every vector from content — content is the source of truth and the sync wire
never carries vectors. Only rows a reader consumes are vectorized: deliberate
working rows (the nudge pool) and episodic rows (nudge pool + recall's knn
leg); captured turns are FTS-recallable and never embedded.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Any, Literal
from collections.abc import Iterable

import pydantic
from memory_store import spans

EMBEDDING_MODEL = os.environ.get("MEMORY_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
_MODEL_DIMS = {
    "BAAI/bge-small-en-v1.5": 384,
    "BAAI/bge-base-en-v1.5": 768,
    "BAAI/bge-large-en-v1.5": 1024,
}
try:
    EMBEDDING_DIM = int(os.environ.get("MEMORY_EMBEDDING_DIM") or _MODEL_DIMS[EMBEDDING_MODEL])
except KeyError:
    raise ValueError(
        f"unknown embedding model {EMBEDDING_MODEL!r}: set MEMORY_EMBEDDING_DIM, "
        f"or pick one of {sorted(_MODEL_DIMS)}"
    ) from None

# onnxruntime's KleidiAI SME f32 GEMM (seen on M4 with onnxruntime 1.30)
# wedges indefinitely on real-text batches >= ~64 and crawls at ~32. Chunks
# larger than this never reach the ONNX session (verified 2026-09-18: a full
# 113-text pool in one Run hung >90s; the same pool in 16-chunks completed).
EMBED_BATCH_CHUNK = 16
EMBED_THREADS = int(os.environ.get("MEMORY_EMBED_THREADS", "2"))

# Embed cache: sha256(content) -> float vector. Debounce and pool scoring
# re-request identical texts across turns; 1024 floats x 4B ≈ 4KB per entry,
# so a few thousand entries is a few MB. Eviction only costs a recompute —
# the same content always hashes to the same cached vector, so correctness
# never depends on hitting the cache.
EMBED_CACHE_MAX = 2048

# The persona floor budget: global sum across active rows (chars of
# statement text). Enforced at every write; over-budget refused, never
# truncated. Promoted from the old render cap to the enforced budget.
PERSONA_BUDGET = 15000

PERSONA_STATUSES = ("active", "retired")

# The floor renders grouped by topic, so a rule's topic decides which heading
# it appears under. Free text rather than an enum: the headings are the user's
# own organization of their preferences, not a vocabulary we get to fix.
DEFAULT_PERSONA_TOPIC = "general"


def normalize_topic(topic: str | None) -> str:
    """Fold a topic to its storage form: lowercase, trimmed, spaces kept."""
    return " ".join((topic or "").strip().lower().split())


# A floor rule is agreed in conversation before it is written, so there is
# no state for one awaiting an answer. Records written under the older
# vocabulary still arrive over sync and still open on disk; the legacy
# maps below exist to match those stored rows, never to name new writes.
LEGACY_PERSONA_STATUSES = {"proposed": "active"}
SITUATIONAL_GRADERS = ("user", "agent")
SITUATIONAL_STANCES = ("prescriptive", "descriptive")

# The feedback wire vocabulary — the single definition. The hub's validator
# (hub_server), the client's emitter (daemon), and sync's push/apply all
# import this tuple: vocabulary drift across those files was a production
# bug (client emitted confirm|disconfirm|soft against a hub expecting the
# canonical four, so every grading record the hub ever received was
# rejected). The agent-facing rule_feedback tool keeps its three-value
# human shape (confirm|disconfirm|soft + polarity) and normalizes here.
FEEDBACK_SIGNALS = ("confirm", "soft_confirm", "soft_refute", "refute")
# Counter direction per canonical signal. The soft weighting lives in the
# DELTA, not here: rule_feedback passes 0.25 for a soft signal, and the
# old-format records stranded by the vocabulary drift carry the same
# 0.25 — weighting it again here would double-count them.
SIGNAL_COUNTERS = {
    "confirm": "confirm_count",
    "soft_confirm": "confirm_count",
    "soft_refute": "disconfirm_count",
    "refute": "disconfirm_count",
}


def normalize_signal(signal: str, polarity: str = "") -> str:
    """Map a feedback signal onto the canonical wire vocabulary.

    Accepts the agent-facing shape (confirm|disconfirm|soft with polarity)
    and any canonical value; returns the canonical value. `soft` carries no
    direction, so it raises without a polarity rather than picking one: no
    layer supplies a default, because a caller who omitted polarity and a
    caller who meant disconfirm are not the same caller."""
    signal = (signal or "").strip()
    if signal in FEEDBACK_SIGNALS:
        return signal
    if signal == "confirm":
        return "confirm"
    if signal == "disconfirm":
        return "refute"
    if signal == "soft":
        if polarity == "confirm":
            return "soft_confirm"
        if polarity == "disconfirm":
            return "soft_refute"
        raise ValueError(f"soft feedback needs polarity confirm|disconfirm, got {polarity!r}")
    raise ValueError(f"unknown feedback signal {signal!r}")


# The record contract — one definition, enforced on every host that can
# originate a record and again at the hub. It lived only in hub_server,
# which put the one check between a bad record and the log on a machine
# with no agent and no user: the 2026-09-19 vocabulary drift was rejected
# there, correctly, and nobody found out for days. Validating before a
# record leaves its origin is what makes a contract violation land on the
# caller that caused it.
RECORD_KINDS = (
    "capture",
    "memory",
    "episodic",
    "rule",
    "feedback",
    "forget",
    "session",
    "agent_memory",
    "knowledge_base",
    "tool_rule",
    "entity",
)
_RECORD_FIELDS = {"record_id", "kind", "machine_id", "occurred_at", "payload"}
FORGET_TABLES = (
    "working_memory",
    "agent_memory",
    "episodic_memory",
    "persona_rules",
    "situational_rules",
    "tool_rules",
    "entities",
)

# The placeholder session anchor for provenance the store does not have:
# contextless writes (scripts calling memory_remember bare) and every row
# migrated off the pre-registry deliberate pool land here, one session row
# per client tool. Agents never see or touch session rows; the anchor is
# an honest "no conversation was recorded", never a fabricated history.
LEGACY_MACHINE = "legacy"
UNRECORDED_CONVERSATION = "provenance-unrecorded"


def _valid_text(value) -> bool:
    return isinstance(value, str) and bool(value)


def _valid_timestamp(value) -> bool:
    if not _valid_text(value):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


_ENTITY_STAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", re.ASCII)


def _valid_entity_stamp(value) -> bool:
    """Exactly YYYY-MM-DDTHH:MM:SSZ. Entity apply orders rows and keeps the
    earliest deleted_at by comparing these strings, which is chronological
    only when every stamp has the same shape: an offset form such as
    14:00:00-04:00 would sort before 17:00:00Z, the same instant. ASCII
    digits only, zero-padded: a space-padded day or a non-ASCII digit sorts
    out of order too."""
    if not _valid_text(value) or not _ENTITY_STAMP.fullmatch(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return False
    return True


def _session_violation(label: str, session) -> str | None:
    """A session travels as the triple each machine resolves to its own
    registry row; a registry id is local and never rides the wire."""
    if not isinstance(session, dict) or not _valid_text(session.get("machine")):
        return f"{label} payload must carry the session's machine"
    if not _valid_text(session.get("tool")):
        return f"{label} payload must carry the session's tool"
    if not _valid_text(session.get("conversation_id")):
        return f"{label} payload must carry the session's conversation_id"
    return None


def validate_record(record, *, allow_unknown_kinds: bool = False) -> str | None:
    """Return a reason the record violates the wire contract, or None.

    Reason strings are the agent-facing explanation at the origin and the
    per-record rejection at the hub, so they name what is wrong rather
    than which check failed.

    `allow_unknown_kinds` is the relay's mode (ADR 20261023-forward-
    compatible-sync): the envelope is checked for every record and the
    payload only for kinds this host knows, so a machine running ahead of
    the hub still gets its records relayed. Origins never pass it — a kind
    this host cannot name is a bug in the caller, and the payload check
    has to run somewhere."""
    if not isinstance(record, dict):
        return "record must be an object"
    if set(record) != _RECORD_FIELDS:
        return "record fields must be exactly record_id, kind, machine_id, occurred_at, payload"
    if not _valid_text(record["record_id"]):
        return "record_id must be a non-empty string"
    if not _valid_text(record["kind"]):
        return "kind must be a non-empty string"
    if not _valid_text(record["machine_id"]) or not all(
        char.islower() or char.isdigit() or char == "-" for char in record["machine_id"]
    ):
        return "machine_id must contain only lowercase letters, digits, and hyphens"
    if not _valid_text(record["occurred_at"]):
        return "occurred_at must be a non-empty string"
    if not _valid_timestamp(record["occurred_at"]):
        return "occurred_at must be ISO 8601"
    payload = record["payload"]
    if not isinstance(payload, dict):
        return "payload must be a JSON object"
    kind = record["kind"]
    if kind not in RECORD_KINDS:
        return None if allow_unknown_kinds else "unsupported record kind"
    if kind in ("capture", "memory", "episodic"):
        if not _valid_text(payload.get("id")):
            return f"{kind} payload must carry an id"
        if not _valid_text(payload.get("content")):
            return f"{kind} payload must carry content"
        check = row_shape_checks(kind, payload)
        if check:
            return check
    elif kind == "rule":
        if payload.get("target") not in ("persona", "situational"):
            return "rule payload must carry target persona|situational"
    elif kind == "feedback":
        if not isinstance(payload.get("rule_id"), int) or payload["rule_id"] < 1:
            return "feedback payload must carry a positive rule_id"
        if payload.get("rule_kind") not in ("persona", "situational"):
            return "feedback rule_kind must be persona|situational"
        if payload.get("signal") not in FEEDBACK_SIGNALS:
            return "feedback signal must be one of " + "|".join(FEEDBACK_SIGNALS)
        if not isinstance(payload.get("delta", 1.0), (int, float)):
            return "feedback delta must be numeric"
    elif kind == "forget":
        if payload.get("table") not in FORGET_TABLES:
            return "forget payload must carry a known table"
        if not _valid_text(str(payload.get("id"))):
            return "forget payload must carry an id"
        if payload["table"] == "entities":
            # Forgetting an entry inserts a forget row, and every directory
            # row records the session that wrote it.
            return _session_violation("forget entities", payload.get("session"))
    elif kind == "session":
        if not _valid_text(payload.get("conversation_id")):
            return "session payload must carry a conversation_id"
    elif kind == "agent_memory":
        if not _valid_text(payload.get("id")):
            return "agent_memory payload must carry an id"
        if not _valid_text(payload.get("content")):
            return "agent_memory payload must carry content"
        check = _session_violation("agent_memory", payload.get("session"))
        if check:
            return check
        if payload.get("scope", "project") not in ("project", "global"):
            return "agent_memory scope must be project|global"
        check = row_shape_checks(kind, payload)
        if check:
            return check
    elif kind == "knowledge_base":
        if not _valid_text(payload.get("id")):
            return "knowledge_base payload must carry an id"
        if not _valid_text(payload.get("project")):
            return "knowledge_base payload must carry a project"
        if not _valid_text(payload.get("doc")):
            return "knowledge_base payload must carry a doc"
        if len(payload["doc"]) > (max_doc := int(os.environ.get("MEMORY_KB_MAX_LEN", "6000"))):
            # Same bound the build enforces on its own output: an oversized
            # doc dies at intake, not when an agent reads it.
            return f"knowledge_base payload doc exceeds {max_doc} characters"
        inputs = payload.get("inputs")
        if not isinstance(inputs, list) or not all(isinstance(i, str) and i for i in inputs):
            return "knowledge_base payload inputs must be an array of row ids"
        seq = payload.get("build_seq")
        if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
            return "knowledge_base payload build_seq must be a positive integer"
        if not isinstance(payload.get("created_at"), str) or not payload.get("created_at"):
            return "knowledge_base payload created_at must be a non-empty string"
    elif kind == "tool_rule":
        try:
            ToolRulePayload.model_validate(payload)
        except pydantic.ValidationError as error:
            details = "; ".join(
                f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
                for item in error.errors()[:5]
            )
            return f"tool_rule payload invalid: {details}"
        # The applier re-mints ids from content, so a wire record's ids are
        # advisory; the pair's join is not — a rule naming a foreign tool
        # would land as an orphan the matcher never reaches.
        if payload["rule"]["tool_id"] != payload["tool"]["id"]:
            return "tool_rule payload rule must reference its own tool's id"
    elif kind == "entity":
        return _entity_violation(payload, allow_unknown_ops=allow_unknown_kinds)
    return None


def row_shape_checks(kind: str, payload: dict) -> str | None:
    """The row-field type checks every content-row kind shares. A TEXT
    importance rides the wire as valid until a scorer multiplies it and
    raises on every query that touches the row — the check at intake is
    what keeps one record from breaking recall machine-wide."""
    importance = payload.get("importance")
    if importance is not None and not isinstance(importance, (int, float)):
        return f"{kind} payload importance must be a number, not {type(importance).__name__}"
    metadata = payload.get("metadata")
    if metadata is not None and not isinstance(metadata, dict):
        return f"{kind} payload metadata must be an object"
    return None


class ToolEnrollment(pydantic.BaseModel):
    """The `tools` row as it rides the tool_rule record payload. Ids are
    content hashes (see tool_key_id); the applier re-mints them, so the
    wire's values are advisory."""

    id: str
    kind: Literal["command", "mcp"]
    key: list[str] = pydantic.Field(min_length=1)
    created_by: str = pydantic.Field(min_length=1)
    created_at: str = pydantic.Field(min_length=1)

    @pydantic.model_validator(mode="after")
    def _mcp_key_is_single(self) -> ToolEnrollment:
        if self.kind == "mcp" and len(self.key) != 1:
            raise ValueError("an mcp tool's key is a single-element array")
        return self


class ToolBinding(pydantic.BaseModel):
    """The `tool_rules` row as it rides the tool_rule record payload.
    guidance_id dangles until the guidance table lands (PRJ-172); this
    increment ships inline-note bindings only. The enrolling session's
    conversation_id rides for provenance (row -> registry walk) and is
    excluded from the binding id — the same rule bound from two sessions
    converges on one row."""

    id: str
    tool_id: str
    guidance_id: str | None = None
    note: str | None = None
    scope: Literal["project", "global"]
    project: str = ""
    conversation_id: str = ""
    created_by: str = pydantic.Field(min_length=1)
    created_at: str = pydantic.Field(min_length=1)


class ToolRulePayload(pydantic.BaseModel):
    """The tool_rule record's payload: an enrollment and its binding, in
    one record so a fleet converges on the pair together."""

    tool: ToolEnrollment
    rule: ToolBinding


def mint_tool_rule_ids(tool: dict, rule: dict) -> tuple[str, str]:
    """The content-hash ids bind_tool will land on for this enrollment.
    Shared by the write path and the tombstone guards (sync apply, the
    authoring verbs) so a guard's predicate can never drift from the
    arithmetic it guards."""
    tool_id = tool_key_id(tool["kind"], tool["key"])
    rule_id = tool_rule_id(
        {
            "tool_id": tool_id,
            "note": rule.get("note"),
            "scope": rule["scope"],
            "project": rule.get("project", ""),
        }
    )
    return tool_id, rule_id


def tool_key_id(kind: str, key: list[str]) -> str:
    """The enrollment's content-hash id: the same enrollment built on any
    machine lands on the same row, which is the whole idempotency story
    (replayed records INSERT OR IGNORE onto their row)."""
    canonical = json.dumps({"kind": kind, "key": key}, sort_keys=True, separators=(",", ":"))
    return "tool_" + hashlib.sha256(canonical.encode()).hexdigest()[:20]


def tool_rule_id(rule: dict) -> str:
    """The binding's content-hash id. A re-bind with changed note/scope is
    a NEW binding (the enrolling agent authored a different rule), not an
    update of the old one — correcting a binding is forget-and-rebind,
    once forget lands for this family."""
    canonical = json.dumps(
        {
            "tool_id": rule["tool_id"],
            "note": rule.get("note"),
            "scope": rule["scope"],
            "project": rule.get("project", ""),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return "tr_" + hashlib.sha256(canonical.encode()).hexdigest()[:20]


def _entity_violation(payload: dict, *, allow_unknown_ops: bool) -> str | None:
    """Check an entity payload's shape, never its vocabulary.

    Materialization skips a row whose `kind`, `verb` or alias `type` it
    does not know, so an unknown value is inert here. Checking them
    on the wire would make adding a verb a payload change to a known kind,
    which the relay does validate — a hub-first deploy for what the design
    calls a value, not a schema change."""
    op = payload.get("op")
    if not _valid_text(op):
        return "entity payload must carry an op"
    if not _valid_text(payload.get("id")):
        return "entity payload must carry the row id it writes"
    if op in ENTITY_INSERT_TABLES:
        for field in ENTITY_INSERT_FIELDS[op]:
            if not _valid_text(payload.get(field)):
                return f"entity {op} payload must carry {field}"
        for field in ENTITY_INSERT_DEFAULTS.get(op, {}):
            if field in payload and not isinstance(payload[field], str):
                return f"entity {op} {field} must be a string"
        if not _valid_entity_stamp(payload.get("created_at")):
            return f"entity {op} payload must carry created_at as YYYY-MM-DDTHH:MM:SSZ"
        return _session_violation(f"entity {op}", payload.get("session"))
    if op in ENTITY_REMOVE_TABLES:
        if not _valid_entity_stamp(payload.get("deleted_at")):
            return f"entity {op} payload must carry deleted_at as YYYY-MM-DDTHH:MM:SSZ"
        return None
    # Same reasoning as an unknown kind: the relay passes an op it has not
    # learned yet so the record reaches a machine that has.
    return None if allow_unknown_ops else "unsupported entity op"


# Idempotent migrations, skipped when already applied. A stale schema snapshot
# cached in a concurrent connection can race the guard, so "no such column" on
# the ALTER itself is treated as migrated.
_MIGRATIONS = [
    "ALTER TABLE persona_rules ADD COLUMN topic TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE feedback_log ADD COLUMN grounds TEXT",
    "ALTER TABLE feedback_log ADD COLUMN record_id TEXT",
    "ALTER TABLE working_memory ADD COLUMN repo TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE working_memory ADD COLUMN origin TEXT NOT NULL DEFAULT 'capture'",
    "ALTER TABLE working_memory ADD COLUMN app TEXT NOT NULL DEFAULT 'opencode'",
    "ALTER TABLE working_memory ADD COLUMN captured_by TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE working_memory ADD COLUMN consolidator_version TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE episodic_memory ADD COLUMN repo TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE episodic_memory ADD COLUMN origin TEXT NOT NULL DEFAULT 'consolidated'",
    "ALTER TABLE episodic_memory ADD COLUMN app TEXT NOT NULL DEFAULT 'memory-store'",
    # The KB eviction scan reads a forgotten row's text from its tombstone;
    # tombstones predating the column carry NULL and are skipped.
    "ALTER TABLE forget_tombstones ADD COLUMN content TEXT",
    # Lineage-gated writes (PRD 20261114-lineage-gated-writes): who started
    # the conversation. Empty reads as the legacy pool (human).
    "ALTER TABLE session ADD COLUMN initiator TEXT NOT NULL DEFAULT ''",
]


# The legacy compound source grammar, parsed exactly once here (sync.apply
# reuses this for old-shape wire payloads). Shapes seen in the wild:
#   cursor:<repo>:<session8>   captured speech (work-deployment lineage)
#   <label>:<repo>             deliberate write with repo
#   <label>                    deliberate write, unscoped (or "sleep_consolidation")
#   <arbitrary>                pre-grammar rows (e.g. "rehearsal")
def parse_legacy_source(source: str | None) -> dict:
    """Split a legacy compound source string into (origin, repo, session_id,
    label). The single place the old grammar is understood."""
    value = (source or "").strip()
    if not value:
        return {"origin": "capture", "repo": "", "session_id": "default", "label": ""}
    parts = value.split(":")
    if parts[0] == "cursor":
        # cursor:<repo>:<session8> — captured transcript
        repo = parts[1] if len(parts) > 1 else ""
        session = parts[2] if len(parts) > 2 else "default"
        return {"origin": "capture", "repo": repo, "session_id": session, "label": ""}
    if len(parts) == 2:
        return {
            "origin": "deliberate",
            "repo": parts[1],
            "session_id": "default",
            "label": parts[0],
        }
    return {"origin": "deliberate", "repo": "", "session_id": "default", "label": value}


SCHEMA = """
CREATE TABLE IF NOT EXISTS working_memory (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source TEXT,
    timestamp TEXT,
    session_id TEXT DEFAULT 'default',
    importance REAL DEFAULT 0.5,
    metadata_json TEXT,
    veracity TEXT DEFAULT 'unknown',
    author_id TEXT,
    author_type TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    consolidated_at TEXT,
    consolidation_claimed_at TEXT,
    kind TEXT DEFAULT 'speech',
    repo TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'capture',
    app TEXT NOT NULL DEFAULT 'opencode',
    captured_by TEXT NOT NULL DEFAULT '',
    consolidator_version TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_wm_session ON working_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_wm_timestamp ON working_memory(timestamp);
CREATE INDEX IF NOT EXISTS idx_wm_source ON working_memory(source);
CREATE INDEX IF NOT EXISTS idx_wm_kind ON working_memory(kind);

CREATE TABLE IF NOT EXISTS episodic_memory (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL,
    source TEXT,
    timestamp TEXT,
    session_id TEXT DEFAULT 'default',
    importance REAL DEFAULT 0.5,
    metadata_json TEXT,
    summary_of TEXT DEFAULT '',
    veracity TEXT DEFAULT 'unknown',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    repo TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'consolidated',
    app TEXT NOT NULL DEFAULT 'memory-store'
);

CREATE INDEX IF NOT EXISTS idx_em_session ON episodic_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_em_timestamp ON episodic_memory(timestamp);
CREATE INDEX IF NOT EXISTS idx_em_source ON episodic_memory(source);
-- Reverse link (ADR 20260926-recall-judged-rows): summaries of one source
-- conversation are a keyed read on summary_of, the same key raw rows carry
-- as session_id.
CREATE INDEX IF NOT EXISTS idx_em_summary_of ON episodic_memory(summary_of);

-- Session registry (PRD 20261104 data model): identity and provenance are
-- structure, not string convention. session.id is a store-owned UUID that
-- later tables key on; the client conversation id sits opaque and is never
-- parsed. machine/project/tool name where the session ran; parent_session_id
-- carries the structural subagent link. SQLite foreign keys are not enforced
-- (no PRAGMA), so the writer orders the parent row before the child link.
CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    client_conversation_id TEXT NOT NULL,
    machine TEXT NOT NULL,
    tool TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    parent_session_id TEXT REFERENCES session(id),
    role TEXT NOT NULL DEFAULT 'main',
    -- Who started this conversation: 'human' or 'agent', declared by the
    -- client from its own session metadata at open time, never by the
    -- model. Empty on rows that predate the column and on registrations
    -- from clients that do not say; the lineage resolver treats empty as
    -- the legacy pool (human), which every pre-lineage client was.
    initiator TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(machine, tool, client_conversation_id)
);

-- Raw captured turns under their session row: sleep input and explicit-recall
-- material only (never push content). Shares the working_memory row's id, so
-- the migration backfill later joins the two tables on it for free.
CREATE TABLE IF NOT EXISTS session_history (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES session(id),
    author_type TEXT,
    kind TEXT NOT NULL DEFAULT 'speech',
    content TEXT NOT NULL,
    ts TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_history_session ON session_history(session_id);

-- Deliberate memories under their session row (PRD 20261104): facts,
-- insights, decisions — each carrying provenance as a foreign key instead
-- of a column convention ("why did we decide this?" is row -> session ->
-- history). The registry's id is resolved per machine: wire records carry
-- the (machine, tool, conversation_id) triple and apply-side
-- get_or_create_session resolves it locally, the same way capture turns
-- bind. kind keeps the working-memory slot's value (deliberate writes speak)
-- so recall renders migrated rows exactly as before. scope is ranking
-- metadata only — project rows may take an affinity boost in their project,
-- global rows stay neutral; recall never filters on it, and no reader
-- consumes it yet (PRJ-177 ships the field unranked; the ranking
-- consumption rides its own reviewed decision).
CREATE TABLE IF NOT EXISTS agent_memory (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES session(id),
    scope TEXT NOT NULL DEFAULT 'project',
    content TEXT NOT NULL,
    source TEXT,
    kind TEXT NOT NULL DEFAULT 'speech',
    timestamp TEXT,
    importance REAL DEFAULT 0.5,
    metadata_json TEXT,
    veracity TEXT DEFAULT 'unknown',
    author_id TEXT,
    author_type TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    repo TEXT NOT NULL DEFAULT '',
    app TEXT NOT NULL DEFAULT 'opencode'
);

CREATE INDEX IF NOT EXISTS idx_am_session ON agent_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_am_source ON agent_memory(source);

-- The KB (PRD 20261104): one composed doc per project, one row per build
-- version. Current text = the row with the highest build_seq; every prior
-- version stays (replace-with-history). inputs journals the agent_memory
-- row ids the build consumed — the version's audit surface; the doc text
-- carries no citations. Rows are content records, not per-machine state,
-- so a machine's emitter is any build pass and converging writes resolve
-- on build_seq (tie: newest created_at; the loser stays as history).
CREATE TABLE IF NOT EXISTS knowledge_base (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    doc TEXT NOT NULL,
    inputs TEXT NOT NULL,
    build_seq INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_kb_project_seq ON knowledge_base(project, build_seq);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_agent USING fts5(
    id UNINDEXED,
    content
);

CREATE TRIGGER IF NOT EXISTS am_ai AFTER INSERT ON agent_memory BEGIN
    INSERT INTO fts_agent(id, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS am_ad AFTER DELETE ON agent_memory BEGIN
    DELETE FROM fts_agent WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS am_au AFTER UPDATE ON agent_memory BEGIN
    DELETE FROM fts_agent WHERE id = old.id;
    INSERT INTO fts_agent(id, content) VALUES (new.id, new.content);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS fts_working USING fts5(
    id UNINDEXED,
    content
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_episodes USING fts5(
    content,
    content='episodic_memory',
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS em_ai AFTER INSERT ON episodic_memory BEGIN
    INSERT INTO fts_episodes(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS em_ad AFTER DELETE ON episodic_memory BEGIN
    INSERT INTO fts_episodes(fts_episodes, rowid, content)
        VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS em_au AFTER UPDATE ON episodic_memory BEGIN
    INSERT INTO fts_episodes(fts_episodes, rowid, content)
        VALUES ('delete', old.rowid, old.content);
    INSERT INTO fts_episodes(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS wm_ai AFTER INSERT ON working_memory BEGIN
    INSERT INTO fts_working(id, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS wm_ad AFTER DELETE ON working_memory BEGIN
    DELETE FROM fts_working WHERE id = old.id;
END;

CREATE TABLE IF NOT EXISTS persona_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    statement TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    topic TEXT NOT NULL DEFAULT '',
    provenance TEXT,
    origin_machine TEXT,
    apply_count INTEGER NOT NULL DEFAULT 0,
    last_applied_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_persona_status ON persona_rules(status);

CREATE TABLE IF NOT EXISTS situational_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    situation TEXT NOT NULL,
    statement TEXT NOT NULL,
    rationale TEXT,
    grader TEXT NOT NULL DEFAULT 'agent',
    stance TEXT NOT NULL DEFAULT 'prescriptive',
    scope TEXT DEFAULT 'global',
    status TEXT NOT NULL DEFAULT 'active',
    provenance TEXT,
    origin_machine TEXT,
    confirm_count REAL NOT NULL DEFAULT 0,
    disconfirm_count REAL NOT NULL DEFAULT 0,
    fire_count INTEGER NOT NULL DEFAULT 0,
    last_fired_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_situ_status ON situational_rules(status);

CREATE TABLE IF NOT EXISTS feedback_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    rule_kind TEXT NOT NULL,
    signal TEXT NOT NULL,
    delta REAL NOT NULL DEFAULT 1,
    origin_machine TEXT,
    grounds TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_rule ON feedback_log(rule_kind, rule_id);

CREATE TABLE IF NOT EXISTS record_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_record_kind ON record_log(kind);

CREATE TABLE IF NOT EXISTS forget_tombstones (
    table_name TEXT NOT NULL,
    row_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    content TEXT,
    PRIMARY KEY (table_name, row_id)
);

CREATE TABLE IF NOT EXISTS store_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Machine-local dedup verdicts (ADR 20260926-write-dedup): pairs the agent
-- has adjudicated stop re-flagging. Telemetry-shaped, deliberately not
-- synced — the wire carries no verdict record kind. A merge changes
-- content, so verdicts involving a touched row are cleared on writes
-- (clear_dedup_verdicts): the merged row may now duplicate something ELSE,
-- and that re-flag is intended.
CREATE TABLE IF NOT EXISTS dedup_verdicts (
    row_a TEXT NOT NULL,
    row_b TEXT NOT NULL,
    verdict TEXT NOT NULL,
    origin_machine TEXT,
    grounds TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY (row_a, row_b)
);
-- Tool enrollment (PRD 20261104, tool matching): the registry of bindable
-- tools and the bindings that speak at their moment of use. `tools.key` is
-- a JSON token array (["git","push"]; MCP calls as single-element arrays)
-- and ids are content hashes (tool_key_id / tool_rule_id), so the same
-- enrollment replayed from any machine converges on the same row without
-- resolution logic. `tool_rules.guidance_id` dangles until the guidance
-- table lands (PRJ-172): this increment ships inline-note bindings only.
CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS tool_rules (
    id TEXT PRIMARY KEY,
    tool_id TEXT NOT NULL,
    guidance_id TEXT,
    note TEXT,
    scope TEXT NOT NULL DEFAULT 'project',
    project TEXT NOT NULL DEFAULT '',
    conversation_id TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_rules_tool ON tool_rules(tool_id);

-- Per-conversation fire bookkeeping: hold-once is per tool per
-- conversation, and a fire is recorded in BOTH hold modes so flipping the
-- holds flag on mid-fleet never re-rejects a conversation that already ran
-- the tool. Local-only, deliberately not journaled — execution state is
-- per machine's client conversations, the same class as a sync cursor.
CREATE TABLE IF NOT EXISTS tool_fires (
    tool_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    app TEXT NOT NULL DEFAULT '',
    held INTEGER NOT NULL DEFAULT 0,
    fired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY (tool_id, conversation_id)
);

-- Per-row usage telemetry (PRD 20261104, pull-based recall): only reads an
-- agent initiated stamp — by id, in the Tools read handlers — while every
-- automatic lookup (nudge pools, session-open, tool-recall, tool-moment,
-- KB build, consolidation, sync) reaches no stamp path at all. Stamped at
-- this side table rather than on the memory rows, so the sync wire payloads
-- stay byte-identical and the counts never ride cross-machine replication.
-- Local-only, deliberately not journaled — the same class as tool_fires:
-- reads are the per-machine agents' history, not shared row state.
CREATE TABLE IF NOT EXISTS usage_counters (
    row_id TEXT PRIMARY KEY,
    tier TEXT NOT NULL DEFAULT '',
    count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Compliance ladder bookkeeping (PRD 20261104, PRJ-179): whether a client
-- conversation has pulled, how far its reminder ladder has escalated, and
-- one journaled row per escalation. The daemon holds the state because the
-- clients restart constantly — a plugin that forgot the conversation's
-- earlier pulls would falsely remind a session that already recalled — and
-- the journal plus aggregates (compliance_report) are the review
-- surface for tier removal, which is a code change on data review, never a
-- runtime switch. Local-only, deliberately not journaled to the sync
-- record — the same class as tool_fires: per-machine client conversations.
CREATE TABLE IF NOT EXISTS compliance_state (
    conversation_id TEXT PRIMARY KEY,
    app TEXT NOT NULL DEFAULT '',
    machine TEXT NOT NULL DEFAULT '',
    -- Active turns since the last pull, and the highest tier already
    -- fired against this stretch of silence.
    active_turns INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 0,
    last_pull_at TEXT,
    total_pulls INTEGER NOT NULL DEFAULT 0,
    total_turns INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS compliance_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    app TEXT NOT NULL DEFAULT '',
    machine TEXT NOT NULL DEFAULT '',
    level INTEGER NOT NULL,
    -- active_turns at the moment of the escalation; a later pull's
    -- turns_after is the difference, which is the time-to-recall.
    turns_at_fire INTEGER NOT NULL,
    escalated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    recalled_at TEXT,
    turns_after INTEGER,
    outcome TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_compliance_events_conversation
    ON compliance_events(conversation_id, outcome);

-- Session-start facts a client deferred instead of inlining: the opening
-- request's ranked deliberate facts, held for the agent to fetch with
-- knowledge_read, and the one-time hold on the conversation's first other tool
-- call that insists on the fetch. Local-only like compliance_state: these
-- are this machine's client conversations.
CREATE TABLE IF NOT EXISTS session_open_facts (
    conversation_id TEXT PRIMARY KEY,
    app TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    -- JSON array of row ids, in ranked order.
    fact_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    fetched_at TEXT,
    held_at TEXT
);

-- Records this machine pulled but could not apply (ADR 20261023-forward-
-- compatible-sync): a kind it does not know, or a known kind whose apply
-- raised. Machine-local and never synced — the record is already logged at
-- the hub, and this table is only this machine's unfinished work on it.
-- The raw record is kept verbatim so a later version applies the fields it
-- had no columns for at pull time. row_key names the row a record
-- overwrites, for the kinds where the last apply wins; NULL for the rest.
CREATE TABLE IF NOT EXISTS deferred_records (
    record_id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    row_key TEXT,
    record_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_deferred_row ON deferred_records(row_key);

-- The entity directory (PRD 20261023-entity-directory), append-only: a
-- change inserts a row or sets a one-way deleted_at on one, so applying a
-- synced record is insert-if-absent or set-if-empty and machines holding
-- the same rows agree whatever order those rows arrived in. The one foreign
-- key is the session, which apply resolves before inserting; every other
-- reference is plain text because a row can arrive before the row it points
-- at.

-- Identity only. kind never changes; a wrong kind is forgotten and recreated.
CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES session(id),
    created_at TEXT NOT NULL
);

-- One row per forget. Restoring sets deleted_at on the open forget row;
-- forgetting again is a new row. An entry is forgotten while it has a
-- forget row with no deleted_at.
CREATE TABLE IF NOT EXISTS entity_forgets (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES session(id),
    created_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_forgets_entity ON entity_forgets(entity_id);

-- The display name is the one field that changes. The newest row wins.
CREATE TABLE IF NOT EXISTS entity_names (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES session(id),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_names_entity ON entity_names(entity_id, created_at);

-- Typed relationships between entries: subject, verb, object. Ending one
-- sets deleted_at; changing one ends the old row and adds a new one.
CREATE TABLE IF NOT EXISTS entity_relations (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL,
    verb TEXT NOT NULL,
    object_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES session(id),
    created_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_relations_subject ON entity_relations(subject_id, verb);
CREATE INDEX IF NOT EXISTS idx_relations_object ON entity_relations(object_id, verb);

-- One row per alias added. Removing an alias sets deleted_at on that row;
-- adding it again later is a new row. A removal names the row it ends,
-- never the alias value, so a concurrent edit elsewhere on the entry
-- cannot bring a removed alias back.
CREATE TABLE IF NOT EXISTS entity_aliases (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    type TEXT NOT NULL,
    instance TEXT NOT NULL DEFAULT '',
    value TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES session(id),
    created_at TEXT NOT NULL,
    deleted_at TEXT
);

-- Deliberately not UNIQUE: two machines can each give one alias to a
-- different entry before they sync, and apply must accept both rather than
-- stall. A collision shows up as an ambiguous lookup.
CREATE INDEX IF NOT EXISTS idx_alias_lookup ON entity_aliases(type, instance, value);

-- One row per observation of how an entry communicates or works, filed
-- under the entry that wrote or did the thing observed. Observations live
-- here rather than in agent_memory so they never fold into a project's
-- knowledge base. Correcting one adds a new row and ends the old.
CREATE TABLE IF NOT EXISTS entity_observations (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    content TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES session(id),
    created_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_observations_entity ON entity_observations(entity_id);
"""

# Current state of the directory, derived from the append-only tables above
# and recomputed inside the transaction of every write and every applied
# record. Machine-local and never synced, like the vec0 tables: a mismatch
# against ENTITY_MATERIALIZED_VERSION rebuilds them from the rows at open.
ENTITY_MATERIALIZED_VERSION = "1"

ENTITY_MATERIALIZED_TABLES = (
    "current_entities",
    "current_relations",
    "current_aliases",
)

ENTITY_MATERIALIZED_SCHEMA = """
CREATE TABLE IF NOT EXISTS current_entities (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    display_name TEXT,
    acts_for TEXT,
    -- The end of this entry's merge chain, or its own id when unmerged.
    final_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS current_relations (
    id TEXT PRIMARY KEY,
    subject_id TEXT NOT NULL,
    verb TEXT NOT NULL,
    object_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_current_rel_subject ON current_relations(subject_id, verb);
CREATE INDEX IF NOT EXISTS idx_current_rel_object ON current_relations(object_id, verb);

CREATE TABLE IF NOT EXISTS current_aliases (
    id TEXT PRIMARY KEY,
    -- Who the alias resolves to: the end of owner_id's merge chain, so
    -- aliases gathered under one merged entry are not a collision.
    entity_id TEXT NOT NULL,
    -- The entry the alias row was written on, which a merge does not move.
    owner_id TEXT NOT NULL,
    type TEXT NOT NULL,
    instance TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_current_alias_lookup
    ON current_aliases(type, instance, value);
CREATE INDEX IF NOT EXISTS idx_current_alias_entity ON current_aliases(entity_id);
"""

CAPTURE_KINDS = ("speech", "exhibit", "fork_summary")

# The directory's fixed vocabularies. Materialization ignores a row whose
# value it does not know, which is what lets a machine running older code
# hold rows from a newer one without the wire contract policing values:
# adding a verb stays a value change rather than a hub-first deploy.
ENTITY_KINDS = ("human", "agent", "bot")
ENTITY_RELATION_VERBS = ("acts_for", "merged_into")
ENTITY_ALIAS_TYPES = (
    "github",
    "slack",
    "email",
    "linear",
    "jira",
    "name",
    "signature",
)

# Ops that carry one new row, and ops that end one. The row each insert op
# writes, and the table each removal op reaches into.
ENTITY_INSERT_TABLES = {
    "create": "entities",
    "rename": "entity_names",
    "relate": "entity_relations",
    "alias_add": "entity_aliases",
    "observe": "entity_observations",
}
ENTITY_REMOVE_TABLES = {
    "unrelate": "entity_relations",
    "alias_remove": "entity_aliases",
    "unobserve": "entity_observations",
    "restore": "entity_forgets",
}

# Per insert op, the payload fields that become columns on its row. Every
# one is required and must be a non-empty string. Every insert also carries
# the session that wrote it and its created_at.
ENTITY_INSERT_FIELDS = {
    "create": ("kind",),
    "rename": ("entity_id", "display_name"),
    "relate": ("subject_id", "verb", "object_id"),
    "alias_add": ("entity_id", "type", "value"),
    "observe": ("entity_id", "content"),
}

# Optional per insert op: column -> value used when the payload omits it.
# Email, name and signature aliases have no instance.
ENTITY_INSERT_DEFAULTS = {"alias_add": {"instance": ""}}


class Store:
    """SQLite-backed store. One connection per Store, guarded by a reentrant
    lock; single-process use per machine (the daemon owns the machine's store)."""

    def __init__(self, path: str | Path):
        self.path = str(path)
        # The RLock serializes every access, so the connection may be shared
        # across threads (the daemon serves MCP requests and runs timers in
        # one process). Cross-process use is still one-connection-per-process.
        self.conn = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self._load_vec_extension()
        self._lock = threading.RLock()
        # Leaf lock for the embedder itself: exactly one thread may be inside
        # an onnxruntime Run at any time. The daemon's other locks (the
        # DaemonState RLock, this store's _lock) are held by separate call
        # sites around embed, which previously allowed two concurrent Run()
        # calls on one InferenceSession — serialized here, independent of
        # whatever outer lock discipline the caller uses.
        self._embed_lock = threading.Lock()
        self._embed_cache: OrderedDict[str, list[float]] = OrderedDict()
        # Before _init_schema: the dimension backfill embeds during open.
        self._embedder: Any | None = None
        self._init_schema()

    def _load_vec_extension(self) -> None:
        if os.environ.get("MEMORY_DISABLE_EMBEDDINGS") == "1":
            self.vec_available = False
            return
        try:
            import sqlite_vec  # type: ignore[import-not-found]

            self.conn.enable_load_extension(True)
            sqlite_vec.load(self.conn)
            self.conn.enable_load_extension(False)
            self.vec_available = True
        except Exception as error:
            # Writes still succeed without the extension and land with no
            # vector, so the only symptom is recall quietly missing those rows
            # later. A python built without loadable SQLite extensions is the
            # usual cause, and it is not obvious from the interpreter.
            self.vec_available = False
            with spans.span("store.vec_unavailable") as span:
                span.close(status="error", error=repr(error)[:120])

    def _init_schema(self) -> None:
        with self._lock, self.conn:
            self.conn.executescript(SCHEMA)
            # Idempotent migrations: execute each, treating "already
            # applied" OperationalErrors as done. The membership
            # pre-check is per-statement (its own table + column);
            # a shared check silently skips every other migration —
            # the bug that kept ADD COLUMN grounds from ever firing.
            for statement in _MIGRATIONS:
                table = statement.split(" TABLE ")[-1].split()[0]
                column = statement.split(" COLUMN ")[-1].split()[0]
                existing = {row["name"] for row in self.conn.execute(f"PRAGMA table_info({table})")}
                if column in existing and "ADD COLUMN" in statement:
                    continue  # already applied
                if column not in existing and "DROP COLUMN" in statement:
                    continue  # already applied (or never existed)
                try:
                    self.conn.execute(statement)
                except sqlite3.OperationalError as error:
                    message = str(error)
                    if "no such column" in message or ("duplicate column" in message.lower()):
                        continue  # raced a peer connection's migration
                    raise
            self._rebuild_fts_if_legacy()
            self._migrate_proposed_personas()
            self._migrate_source_columns()
            self._backfill_legacy_initiators()
            self._ensure_vec_tables()
            self._ensure_entity_tables()
            # Per-record idempotency for feedback (after the ADD COLUMN
            # migration): the hub relays every record back to its origin,
            # and feedback applies accumulatively — without this the origin
            # counts each of its own gradings twice (masked for the store's
            # first week only because the vocabulary drift rejected every
            # feedback record at the hub, so nothing ever echoed back).
            # NULL is not unique: applies without a wire record coexist.
            self.conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_record_id "
                "ON feedback_log(record_id) WHERE record_id IS NOT NULL"
            )
            # After the ADD COLUMN migrations: origin is a migration-added
            # column on working_memory, and SCHEMA executes before them —
            # a legacy table would hit a missing column otherwise. Serving
            # the deliberate-pool migration scan (and any straggler check).
            self.conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_wm_deliberate "
                "ON working_memory(origin) WHERE origin = 'deliberate'"
            )

    def _meta_get(self, key: str) -> str | None:
        row = self.conn.execute("SELECT value FROM store_meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def _meta_set(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO store_meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )

    def _rebuild_fts_if_legacy(self) -> None:
        """Legacy databases carry content rows that predate their FTS index
        (the index is created by SCHEMA after the table already held rows).
        An external-content FTS5 'delete' against a document the index has
        never seen reports 'database disk image is malformed' — so every
        data-migration UPDATE on such a row would fail. The rebuild makes
        the index match the content table. Gated by store_meta: once per
        database, ever — an ungated rebuild was O(corpus) startup cost on
        every open."""
        if self._meta_get("fts_rebuilt") == "1":
            return
        self.conn.execute("INSERT INTO fts_working(fts_working) VALUES('rebuild')")
        self.conn.execute("INSERT INTO fts_episodes(fts_episodes) VALUES('rebuild')")
        self._meta_set("fts_rebuilt", "1")

    def _ensure_vec_tables(self) -> None:
        """Create the vec0 tables at the configured model's dimension, and
        rebuild when the store's recorded model or dimension no longer
        matches — or when any table is missing: an upgraded store from
        before the agent-memory split carries only the two legacy tables,
        and dropping only the present ones (the unconditional CREATE would
        die on the first) is what makes that boot a backfill instead of an
        outage. Every vector is recomputed from content — content is the
        source of truth, the sync wire never carries vectors, so a model
        switch or a table addition is drop/recreate/backfill at open, not
        a migration of state. Legacy stores (tables without a meta row —
        every store written before store_meta existed) take the same
        path."""
        if not self.vec_available:
            return
        tables = {
            row["name"]
            for row in self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' "
                "AND name IN ('vec_working', 'vec_episodes', 'vec_agent')"
            )
        }
        complete = {"vec_working", "vec_episodes", "vec_agent"} <= tables
        matches = (
            complete
            and self._meta_get("embedding_model") == EMBEDDING_MODEL
            and self._meta_get("embedding_dim") == str(EMBEDDING_DIM)
        )
        if matches:
            return
        for table in ("vec_working", "vec_episodes", "vec_agent"):
            if table in tables:
                self.conn.execute(f"DROP TABLE {table}")
            self.conn.execute(
                f"CREATE VIRTUAL TABLE {table} USING vec0(embedding float[{EMBEDDING_DIM}])"
            )
        backfilled = self._backfill_vectors()
        self._meta_set("embedding_model", EMBEDDING_MODEL)
        self._meta_set("embedding_dim", str(EMBEDDING_DIM))
        action = "created" if not tables else "rebuilt"
        print(
            f"vec store {action} at "
            f"{EMBEDDING_DIM}-dim for {EMBEDDING_MODEL}: {backfilled} vectors",
            flush=True,
        )

    def _backfill_vectors(self) -> int:
        """Recompute vectors from content after a dimension rebuild: every
        agent_memory row (the deliberate pool's vector source) and every
        episodic row (nudge pool + recall's knn leg). Deliberate rows that
        still sit in working_memory pre-migration embed there too; the
        migration drains that table, so post-migration it stops matching.
        Captured turns are never embedded — nothing reads their vectors.
        Runs inside _init_schema's open transaction; embed() chunks
        internally, so a full pass is bounded."""
        targets: list[tuple[str, int, str]] = []
        for row in self.conn.execute("SELECT rowid, content FROM agent_memory").fetchall():
            targets.append(("vec_agent", row["rowid"], row["content"]))
        for row in self.conn.execute(
            "SELECT rowid, content FROM working_memory WHERE origin = 'deliberate'"
        ).fetchall():
            targets.append(("vec_working", row["rowid"], row["content"]))
        for row in self.conn.execute("SELECT rowid, content FROM episodic_memory").fetchall():
            targets.append(("vec_episodes", row["rowid"], row["content"]))
        if not targets:
            return 0
        vectors = self.embed([content for _, _, content in targets], origin="vec-backfill")
        for (table, rowid, _content), vector in zip(targets, vectors, strict=True):
            self._vec_insert(table, rowid, vector)
        return len(targets)

    def _ensure_entity_tables(self) -> None:
        """Create the directory's materialized tables, and rebuild them from
        the append-only rows when one is missing or the recorded version no
        longer matches the code. They are derived state and never synced, so
        a change to how they are computed is a recompute at open rather than
        a migration — the same contract the vec0 tables keep with content."""
        present = {
            row["name"]
            for row in self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN "
                f"({','.join('?' * len(ENTITY_MATERIALIZED_TABLES))})",
                ENTITY_MATERIALIZED_TABLES,
            )
        }
        current = set(ENTITY_MATERIALIZED_TABLES) <= present
        if current and self._meta_get("entity_materialized_version") == ENTITY_MATERIALIZED_VERSION:
            return
        for table in ENTITY_MATERIALIZED_TABLES:
            self.conn.execute(f"DROP TABLE IF EXISTS {table}")
        self.conn.executescript(ENTITY_MATERIALIZED_SCHEMA)
        self._materialize_entities()
        self._meta_set("entity_materialized_version", ENTITY_MATERIALIZED_VERSION)

    def _migrate_proposed_personas(self) -> None:
        """Activate floor rules left in the retired `proposed` state. They
        already counted against the budget, so the total does not move;
        the ceiling simply bites on the next write, which is where a floor
        carrying rules nobody answered gets trimmed."""
        rows = self.conn.execute(
            "SELECT id, substr(statement, 1, 70) AS head FROM persona_rules "
            "WHERE status = 'proposed' ORDER BY id"
        ).fetchall()
        if not rows:
            return
        self.conn.execute("UPDATE persona_rules SET status = 'active' WHERE status = 'proposed'")
        print(f"persona migration: activated {len(rows)} proposed rule(s)", flush=True)
        for row in rows:
            print(f"  {row['id']}: {row['head']}", flush=True)

    def _migrate_source_columns(self) -> None:
        """One-time parse of legacy compound source strings into the
        provenance columns (repo, origin, app, session_id). Cursor ceases
        to exist as data here.

        Gated on a meta flag rather than on the rows themselves: an empty
        repo is the normal state of a globally-scoped row, so the row-level
        predicate below never stops matching and the pass would re-run on
        every open, overwriting app and origin each time."""
        if self._meta_get("source_columns_migrated") == "1":
            return
        # Working memory: only rows still carrying a compound source need
        # parsing — deliberate rows already carry a bare label and stay.
        rows = self.conn.execute(
            """SELECT id, source, session_id FROM working_memory
               WHERE repo = ''"""
        ).fetchall()
        for row in rows:
            parsed = parse_legacy_source(row["source"])
            # The label slot is normalized: compound deliberate sources
            # (fact:example) reduce to the bare label; captured rows carry
            # no label at all (kind says speech/exhibit/fork).
            label = parsed["label"] if parsed["origin"] == "deliberate" else ""
            self.conn.execute(
                """UPDATE working_memory
                   SET repo = ?, origin = ?, app = 'opencode', session_id = ?,
                       source = ?
                   WHERE id = ?""",
                (parsed["repo"], parsed["origin"], parsed["session_id"], label, row["id"]),
            )
        # Episodic rows: consolidation output — origin/app are fixed, and
        # the source-conversation link in metadata_json.source_label
        # becomes the structured summary_of.
        ep_rows = self.conn.execute(
            """SELECT rowid, metadata_json, summary_of FROM episodic_memory
               WHERE repo = ''"""
        ).fetchall()
        for row in ep_rows:
            try:
                meta = json.loads(row["metadata_json"] or "{}")
            except json.JSONDecodeError:
                meta = {}
            label = meta.get("source_label", "")
            # source_label composes the legacy conversation source
            # (cursor:<repo>:<session8>); recover repo from it.
            parsed = parse_legacy_source(label)
            summary_of = row["summary_of"] or parsed["session_id"]
            self.conn.execute(
                """UPDATE episodic_memory
                   SET repo = ?, origin = 'consolidated', app = 'memory-store',
                       summary_of = ?
                   WHERE rowid = ?""",
                (parsed["repo"], summary_of, row["rowid"]),
            )
        self._meta_set("source_columns_migrated", "1")

    def _backfill_legacy_initiators(self) -> None:
        """One-time backfill: rows that predate the initiator column are the
        human's own conversations (every client then was human-driven), so
        they read human from here on. Rows created after the backfill with
        an empty initiator resolve agent — the refusing direction — so a
        fabricated or unidentified lineage can never inherit the legacy
        pool's trust (PRD 20261114-lineage-gated-writes)."""
        if self._meta_get("legacy_initiator_backfilled") == "1":
            return
        with self._lock, self.conn:
            self.conn.execute("UPDATE session SET initiator = 'human' WHERE initiator = ''")
            self._meta_set("legacy_initiator_backfilled", "1")

    # --- embedding -----------------------------------------------------

    def _hash_text(self, text: str) -> str:
        # The model name is part of the key: a vector from one model must
        # never be served for another (spaces are not comparable across
        # models, and a model switch must not be able to serve stale hits).
        return hashlib.sha256(f"{EMBEDDING_MODEL}\x00{text}".encode()).hexdigest()

    def _cache_put(self, key: str, vector: list[float]) -> None:
        self._embed_cache.pop(key, None)
        self._embed_cache[key] = vector
        while len(self._embed_cache) > EMBED_CACHE_MAX:
            self._embed_cache.popitem(last=False)

    def embed(self, texts: list[str], origin: str = "unattributed") -> list[list[float]]:
        """Embed texts with the pinned local model. Batches are chunked to
        `EMBED_BATCH_CHUNK` (large single Runs wedge the KleidiAI SME kernel
        — see the constant's comment) and hits are served from the sha256
        LRU cache, so identical texts never re-embed. The model is loaded
        lazily; failure raises (callers decide whether embedding is
        optional for them). Content is never mutated, so cached vectors are
        always current — a changed upsert recomputes both by virtue of new
        content hashing differently.

        `origin` names the caller (nudge-prompt, debounce, pool-fallback,
        upsert-capture, upsert-episodic, rules-prompt, rules-situations,
        recall-query, vec-backfill); it rides the span context so a wedged
        embed leaves an OUTSTANDING line naming exactly who was stuck."""
        if not self.vec_available:
            raise RuntimeError("embeddings disabled (vec unavailable)")
        results: list[list[float] | None] = [None] * len(texts)
        misses: list[tuple[int, str]] = []  # (index, text)
        for index, text in enumerate(texts):
            key = self._hash_text(text)
            hit = self._embed_cache.get(key)
            if hit is not None:
                self._embed_cache.move_to_end(key)
                results[index] = hit
            else:
                misses.append((index, text))

        with spans.span("memory.embed", origin=origin, texts=len(texts)) as spa:
            spa.set(cache_hits=len(texts) - len(misses))
            if misses:
                lock_t0 = time.monotonic()
                with self._embed_lock:
                    spa.set(lock_wait_ms=round((time.monotonic() - lock_t0) * 1000.0))
                    if self._embedder is None:
                        from fastembed import TextEmbedding  # type: ignore[import-not-found]

                        self._embedder = TextEmbedding(EMBEDDING_MODEL, threads=EMBED_THREADS)
                    for start in range(0, len(misses), EMBED_BATCH_CHUNK):
                        chunk = misses[start : start + EMBED_BATCH_CHUNK]
                        chunk_vectors = [
                            vector.tolist()
                            for vector in self._embedder.embed([text for _, text in chunk])
                        ]
                        for (index, text), vector in zip(chunk, chunk_vectors, strict=True):
                            results[index] = vector
                            self._cache_put(self._hash_text(text), vector)
                    spa.set(chunks=(len(misses) + EMBED_BATCH_CHUNK - 1) // EMBED_BATCH_CHUNK)
            spa.set(returned=len(results))
            return results  # type: ignore[return-value]

    def _vec_insert(self, table: str, rowid: int, embedding: list[float]) -> None:
        if not self.vec_available:
            return
        import struct

        blob = struct.pack(f"<{len(embedding)}f", *embedding)
        self.conn.execute(f"INSERT INTO {table}(rowid, embedding) VALUES (?, ?)", (rowid, blob))

    def _vec_delete(self, table: str, rowid: int) -> None:
        if not self.vec_available:
            return
        self.conn.execute(f"DELETE FROM {table} WHERE rowid = ?", (rowid,))

    def stored_vectors(self, table: str, rowids: list[int]) -> dict[int, list[float]]:
        """Read vectors for exact rowids from a vec0 table. Returns only the
        rowids actually present; scoring callers fall back to embed() for
        the rest. Callers hold _lock (vec0 shares the main connection)."""
        if not self.vec_available or not rowids:
            return {}
        import struct

        placeholders = ",".join("?" for _ in rowids)
        found: dict[int, list[float]] = {}
        for row in self.conn.execute(
            f"SELECT rowid, embedding FROM {table} WHERE rowid IN ({placeholders})",
            tuple(rowids),
        ).fetchall():
            blob = row["embedding"]
            found[row["rowid"]] = list(struct.unpack(f"<{len(blob) // 4}f", blob))
        return found

    # --- working memory ---------------------------------------------------

    def upsert_capture(self, row: dict, *, force: bool = False) -> None:
        """Idempotent capture upsert (record-log apply target). Only
        deliberate rows embed on apply — their vectors feed the nudge pool;
        captured turns are FTS-recallable and no reader consumes their
        vectors, so embedding them was pure write-path cost. Deliberate
        re-embeds happen only when content changed.

        Same content is a replay and writes nothing, which is what the
        record log wants. `force` is for edits that change only the other
        columns (importance, label, veracity) and would otherwise be
        swallowed as a replay."""
        with self._lock, self.conn:
            existing = self.conn.execute(
                "SELECT rowid, content, consolidated_at FROM working_memory WHERE id = ?",
                (row["id"],),
            ).fetchone()
            content_changed = not existing or existing["content"] != row["content"]
            if not content_changed and not force:
                return
            self.conn.execute(
                """INSERT INTO working_memory
                   (id, content, source, timestamp, session_id, importance,
                    metadata_json, veracity, author_id, author_type, kind,
                     repo, origin, app, captured_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     content = excluded.content,
                     source = excluded.source,
                     timestamp = excluded.timestamp,
                     session_id = excluded.session_id,
                     importance = excluded.importance,
                     metadata_json = excluded.metadata_json,
                     veracity = excluded.veracity,
                     author_id = excluded.author_id,
                     author_type = excluded.author_type,
                     kind = excluded.kind,
                      repo = excluded.repo,
                      origin = excluded.origin,
                      app = excluded.app,
                      captured_by = excluded.captured_by""",
                (
                    row["id"],
                    row["content"],
                    row.get("source"),
                    row.get("timestamp"),
                    row.get("session_id", "default"),
                    row.get("importance", 0.5),
                    json.dumps(row.get("metadata") or {}),
                    row.get("veracity", "unknown"),
                    row.get("author_id"),
                    row.get("author_type"),
                    row.get("kind", "speech"),
                    row.get("repo", ""),
                    row.get("origin", "capture"),
                    row.get("app", "opencode"),
                    row.get("captured_by", ""),
                ),
            )
            if (
                self.vec_available
                and content_changed
                and row.get("origin") == "deliberate"
                and not (existing and existing["consolidated_at"])
            ):
                db_rowid = (
                    existing["rowid"]
                    if existing
                    else self.conn.execute(
                        "SELECT rowid FROM working_memory WHERE id = ?", (row["id"],)
                    ).fetchone()[0]
                )
                embedding = self.embed([row["content"]], origin="upsert-capture")[0]
                self._vec_delete("vec_working", db_rowid)
                self._vec_insert("vec_working", db_rowid, embedding)

    # --- sessions ----------------------------------------------------------

    def get_or_create_session(
        self,
        machine: str,
        tool: str,
        client_conversation_id: str,
        project: str = "",
        parent_conversation_id: str | None = None,
        initiator: str = "",
    ) -> str:
        """Register a session by its opaque client conversation id and return
        the store-owned session id. A child (parent_conversation_id given)
        registers its parent row first so the structural link always
        resolves — the registration line arrives before the parent has
        captured anything — and role derives from that link, not a knob.
        Re-registration changes nothing but a project that is still empty
        and an initiator that is still empty: resolution repeats per turn,
        and a later one may be the resolution that actually lands (rootless
        Cursor windows resolve on the first turn that names a workspace).
        `initiator` names who started the conversation ('human' | 'agent'),
        declared by the client layer from its own session metadata; a value
        never overwrites a stated one."""
        initiator = (initiator or "").strip().lower()
        if initiator not in ("human", "agent"):
            initiator = ""
        parent_id = (
            self.get_or_create_session(machine, tool, parent_conversation_id, project=project)
            if parent_conversation_id
            else None
        )
        with self._lock, self.conn:
            existing = self.conn.execute(
                "SELECT id, project, initiator, parent_session_id FROM session "
                "WHERE machine = ? AND tool = ? AND client_conversation_id = ?",
                (machine, tool, client_conversation_id),
            ).fetchone()
            if existing:
                # The parent link backfills: a write can create the row
                # before the registration line carrying the structural link
                # drains, and without this the link never lands — the
                # session stays unanchored for life (PRD
                # 20261114-lineage-gated-writes).
                if (
                    (project and not existing["project"])
                    or (initiator and not existing["initiator"])
                    or (parent_id and not existing["parent_session_id"])
                ):
                    self.conn.execute(
                        "UPDATE session SET "
                        "project = CASE WHEN ? != '' AND project = '' "
                        "THEN ? ELSE project END, "
                        "initiator = CASE WHEN ? != '' AND initiator = '' "
                        "THEN ? ELSE initiator END, "
                        "parent_session_id = COALESCE(parent_session_id, ?), "
                        "updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') "
                        "WHERE id = ?",
                        (
                            project,
                            project,
                            initiator,
                            initiator,
                            parent_id,
                            existing["id"],
                        ),
                    )
                return existing["id"]
            session_id = uuid.uuid4().hex
            self.conn.execute(
                """INSERT INTO session
                   (id, client_conversation_id, machine, tool, project,
                    parent_session_id, role, initiator)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    session_id,
                    client_conversation_id,
                    machine,
                    tool,
                    project,
                    parent_id,
                    "subagent" if parent_conversation_id else "main",
                    initiator,
                ),
            )
            return session_id

    def session_exists(self, machine: str, tool: str, client_conversation_id: str) -> bool:
        """Whether the registry already holds this conversation — the drain
        checks before resolving a turn's session, so it can tell a fresh
        registration (worth syncing to peers) from an idempotent
        re-resolution."""
        row = self.conn.execute(
            "SELECT 1 FROM session WHERE machine = ? AND tool = ? AND client_conversation_id = ?",
            (machine, tool, client_conversation_id or ""),
        ).fetchone()
        return row is not None

    def session_lineage(
        self, machine: str, tool: str, client_conversation_id: str
    ) -> tuple[str, int]:
        """Resolve a conversation to (root initiator, depth): the initiator
        stated at the ROOT of its parent chain, and how many links the
        conversation sits below that root. Depth is 0 for the conversation
        itself. A mid-chain initiator describes who started that node; the
        root's is the lineage that decides. Empty initiator at the root
        resolves agent — the refusing direction: the one-time backfill
        stamped every row that predates the column, so an empty initiator
        after it means this daemon failed to identify the lineage, and
        unidentified lineage never inherits the legacy pool's trust (PRD
        20261114-lineage-gated-writes). A cycle never reaches a root and
        resolves the same way. Runs under the store lock, like every other
        store touch — the drain and consolidation threads hold open
        transactions on this connection."""
        with self._lock:
            row = self.conn.execute(
                "SELECT id, parent_session_id, initiator FROM session "
                "WHERE machine = ? AND tool = ? AND client_conversation_id = ?",
                (machine, tool, client_conversation_id or ""),
            ).fetchone()
            if row is None:
                return "", -1
            depth = 0
            seen: set[str] = set()
            while row["id"] not in seen:
                seen.add(row["id"])
                parent_id = row["parent_session_id"]
                if not parent_id:
                    break
                parent = self.conn.execute(
                    "SELECT id, parent_session_id, initiator FROM session WHERE id = ?",
                    (parent_id,),
                ).fetchone()
                if parent is None:
                    # Broken link: treat the chain as ended here.
                    break
                row = parent
                depth += 1
            else:
                return "agent", depth + 1
            initiator = (row["initiator"] or "").strip().lower()
            # Only a stated "human" reads human; empty or unknown resolves
            # agent — the backfill stamped the rows that deserve the legacy
            # pool's trust, so an empty initiator is unidentified lineage.
            return ("human" if initiator == "human" else "agent"), depth

    def conversation_class(self, machine: str, tool: str, client_conversation_id: str) -> str:
        """The write-gate's class for a conversation (PRD
        20261114-lineage-gated-writes):

        - 'human'    — depth 0 under a human root: the session the human
                       types in. Full writes, human-voice attribution.
        - 'driven'   — deeper under a human root: agents doing the human's
                       work. Full writes, agent-chain attribution.
        - 'unanchored' — no human anywhere in the line (webhook bot, bare
                       scripts): observation writes only.
        - 'absent'   — no registry row for the conversation: treated like
                       unanchored everywhere, but distinguishable for
                       stamping (the drain resolves the session first, so
                       real captures never land here).

        The walk runs per call; chains are short and the registry is local
        SQLite, so no cache until a profile says otherwise."""
        initiator, depth = self.session_lineage(machine, tool, client_conversation_id)
        if initiator == "":
            return "absent"
        if initiator == "agent":
            return "unanchored"
        return "human" if depth == 0 else "driven"

    def record_capture_turn(self, row: dict) -> str | None:
        """Mirror a captured turn into session_history under its session row.
        Deliberate rows are refused — this mirror covers capture turns;
        deliberate writes reach the registry through the resolution in
        memory_remember (their content lives in agent_memory).
        Idempotent by primary key (replays write nothing), and the
        session_history id is the working_memory row's id, so the migration
        backfill later joins the two tables on it."""
        if row.get("origin") != "capture":
            return None
        session_id = self.get_or_create_session(
            machine=row.get("captured_by", "") or "",
            tool=row.get("app", "") or "",
            client_conversation_id=row.get("session_id") or "unknown",
            project=row.get("repo", ""),
            # The originating drain resolved this session from the client's
            # declaration; the mirror carries the same value so a replayed
            # record cannot create an unidentified (agent-resolving) row
            # remotely (PRD 20261114-lineage-gated-writes).
            initiator=row.get("initiator", ""),
        )
        with self._lock, self.conn:
            self.conn.execute(
                """INSERT OR IGNORE INTO session_history
                   (id, session_id, author_type, kind, content, ts)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    row["id"],
                    session_id,
                    row.get("author_type"),
                    row.get("kind", "speech"),
                    row["content"],
                    row.get("timestamp") or "",
                ),
            )
        return session_id

    def clear_force_flags(self, session_ids: list[str]) -> None:
        """Clear consolidation force flags for the named sessions, bare:
        any backoff state on the row survives. Owns the lock protocol and
        its ordering with conn for a consolidation-state write, so the
        consolidator never reaches into _lock itself."""
        with self._lock, self.conn:
            self.conn.executemany(
                "UPDATE consolidation_state SET force = 0 WHERE session_id = ?",
                [(session_id,) for session_id in session_ids],
            )

    # --- agent memory ------------------------------------------------------

    def upsert_agent(self, row: dict, *, force: bool = False) -> None:
        """Idempotent agent-memory upsert: the direct write path, and the
        record-log apply target (which calls with force=True — a
        full-payload upsert, so a metadata-only edit converges on every
        machine while a replayed record writes identical values back and
        content-unchanged applies never re-embed). Same content without
        force is a swallowed replay, which is what the record log wants.

        `force` is for edits that change only the other columns
        (importance, label, veracity) and would otherwise be swallowed as
        a replay.

        Metadata arrives as the parsed object (wire payloads) or the row's
        metadata_json string (caller-fetched rows, and the migration's
        legacy reads — which have carried junk in the wild; the source-
        columns migration guards the same field). An explicitly passed
        empty dict wins over a stale metadata_json in the same dict.

        created_at: set on INSERT from the row when present, else now.
        The conflict-update never rewrites it — an edit keeps the row's
        creation, and the wire's copies date their own arrival (the
        sibling tables' convention: created_at never travels)."""
        if row.get("metadata") is not None:
            metadata = row["metadata"]
        elif row.get("metadata_json"):
            try:
                metadata = json.loads(row["metadata_json"])
            except json.JSONDecodeError:
                metadata = {}
        else:
            metadata = {}
        with self._lock, self.conn:
            existing = self.conn.execute(
                "SELECT rowid, content FROM agent_memory WHERE id = ?", (row["id"],)
            ).fetchone()
            content_changed = not existing or existing["content"] != row["content"]
            if not content_changed and not force:
                return
            self.conn.execute(
                """INSERT INTO agent_memory
                   (id, session_id, scope, content, source, kind, timestamp,
                    importance, metadata_json, veracity, author_id, author_type,
                    repo, app, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                           COALESCE(?, CURRENT_TIMESTAMP))
                   ON CONFLICT(id) DO UPDATE SET
                     session_id = excluded.session_id,
                     scope = excluded.scope,
                     content = excluded.content,
                     source = excluded.source,
                     kind = excluded.kind,
                     timestamp = excluded.timestamp,
                     importance = excluded.importance,
                     metadata_json = excluded.metadata_json,
                     veracity = excluded.veracity,
                     author_id = excluded.author_id,
                     author_type = excluded.author_type,
                     repo = excluded.repo,
                     app = excluded.app""",
                (
                    row["id"],
                    row["session_id"],
                    row.get("scope", "project"),
                    row["content"],
                    row.get("source"),
                    # NULLs coerce here rather than at each caller: the
                    # legacy working-memory schema permitted NULL kind and
                    # importance, and a verbatim carry would either refuse
                    # the row (kind has NOT NULL here) or hand the scorers
                    # a None to crash on. A real 0 importance survives.
                    row.get("kind") or "speech",
                    row.get("timestamp"),
                    importance if (importance := row.get("importance")) is not None else 0.5,
                    json.dumps(metadata),
                    row.get("veracity") or "unknown",
                    row.get("author_id"),
                    row.get("author_type"),
                    row.get("repo", ""),
                    row.get("app", "opencode"),
                    row.get("created_at"),
                ),
            )
            if self.vec_available and content_changed:
                db_rowid = (
                    existing["rowid"]
                    if existing
                    else self.conn.execute(
                        "SELECT rowid FROM agent_memory WHERE id = ?", (row["id"],)
                    ).fetchone()[0]
                )
                embedding = self.embed([row["content"]], origin="upsert-agent")[0]
                self._vec_delete("vec_agent", db_rowid)
                self._vec_insert("vec_agent", db_rowid, embedding)

    def agent_record_payload(self, row_id: str) -> dict | None:
        """The wire payload for one agent row: the row fields plus the
        session's resolution triple. The registry id is per-machine (each
        machine names the same conversation differently), so records carry
        machine/tool/conversation_id and every receiving store resolves the
        triple to its own session row at apply time — never ship a session
        id."""
        row = self.conn.execute(
            """SELECT a.id, a.scope, a.content, a.source, a.kind, a.timestamp,
                      a.importance, a.veracity, a.author_id, a.author_type,
                      a.repo, a.app, a.metadata_json,
                      s.machine, s.tool, s.client_conversation_id, s.project
               FROM agent_memory a JOIN session s ON a.session_id = s.id
               WHERE a.id = ?""",
            (row_id,),
        ).fetchone()
        if row is None:
            return None
        payload = dict(row)
        payload["metadata"] = json.loads(payload.pop("metadata_json", None) or "{}")
        payload["session"] = {
            "machine": payload.pop("machine", ""),
            "tool": payload.pop("tool", ""),
            "conversation_id": payload.pop("client_conversation_id", ""),
            "project": payload.pop("project", ""),
        }
        return payload

    def agent_row(self, row_id: str) -> dict | None:
        """One agent_memory row by id, as a plain dict, or None."""
        row = self.conn.execute("SELECT * FROM agent_memory WHERE id = ?", (row_id,)).fetchone()
        return dict(row) if row else None

    def forget_homes(self, table: str, row_id: str | int) -> tuple[str, ...]:
        """The tables a forget of `row_id` must reach. A deliberate id's
        content lives in agent_memory and, only in the window before some
        machines' migrations drain their working copies, in working_memory
        as well; forgetting one must not leave the other home serving the
        content. Other tables, and a working row without an agent twin,
        route to themselves untouched."""
        if table not in ("working_memory", "agent_memory"):
            return (table,)
        homes = [table]
        other = "agent_memory" if table == "working_memory" else "working_memory"
        with self._lock:
            other_row = self.conn.execute(
                f"SELECT 1 FROM {other} WHERE id = ?", (row_id,)
            ).fetchone()
        if other_row:
            homes.append(other)
        return tuple(homes)

    def _emit_migrated(self, row_id: str, emit) -> bool:
        """Both wire records for one moved row: the agent record (row plus
        session triple) and the forget record for its working copy. emit
        carries the daemon's enqueue hook; it returns True (queued), False
        (swallowed by the enqueue-failure path) or raises a contract
        refusal — a False or a raise means the record is not on the
        queue."""
        shipped = True
        payload = self.agent_record_payload(row_id)
        if payload:
            shipped = emit("agent_memory", payload) is not False and shipped
        forgot = emit("forget", {"table": "working_memory", "id": row_id})
        shipped = forgot is not False and shipped
        return shipped

    def migrate_deliberate_rows(self, emit=None) -> int:
        """Move the legacy deliberate pool into agent_memory.

        Per row, in this order: anchor to the app's placeholder session
        (the pre-registry pool's conversation provenance was never
        recorded as registry data — the live pool reads all-'default'
        session ids, and an old write path could pass an explicit id the
        registry has no row for — so the placeholder, never a fabricated
        history), copy, then tombstone-delete the working copy. Anchor
        first: the copy's foreign key needs the session id.
        The copy carries created_at through: the pool keeps its true
        creation dates (the wire's copies date their own arrival — the
        sibling convention). Each row commits its own three writes, so a
        crash between them leaves the row in both homes — content readers
        serve it once (the straggler legs hide the twin by id) and the
        next boot's pass completes the move; a row whose agent twin exists
        copies nothing but still has its working copy drained. Rewrites
        naturally re-home rows on a real session (forget old + write new);
        what never gets touched keeps its placeholder.

        The wire: one agent_memory record per moved row plus one forget
        record for its working copy, emitted after the local move (the
        move is durable before its records queue). An emit failure — a
        contract refusal or a swallowed enqueue error — puts the row's id
        on a pending list in store_meta, and every boot heals pending
        rows first by re-emitting both records: where the agent record
        already landed it replays as a no-op, and the queue re-drains the
        rest. Without the heal, a durable local move with a lost wire
        would diverge the row across machines permanently. A drained
        survivor's ship failures are pending the same way. A pending
        entry is only cleared by a successful emit or by its row's agent
        twin vanishing (the row was forgotten; each machine's drain pass
        closes what its twin lost).

        Idempotent by this NOT-EXISTS scan, which runs under the lock:
        rows still arriving from old `memory` records land here on the
        next boot."""
        pending = [
            row_id
            for row_id in (self._meta_get("agent_migration_unshipped") or "").split(",")
            if row_id
        ]
        still_pending = []
        for row_id in pending:
            # Heal first: re-emit both records for a row whose move landed
            # durably but whose wire did not. A re-emitted agent record
            # replays as a no-op where it already landed.
            if emit is None:
                still_pending.append(row_id)
                continue
            if not self.agent_row(row_id):
                continue  # the twin is gone: its pending entry clears
            try:
                if not self._emit_migrated(row_id, emit):
                    still_pending.append(row_id)
            except Exception:
                still_pending.append(row_id)
        # Own transaction: a boot that marks unshipped rows and dies before
        # the next store write would otherwise lose the heal record —
        # close() commits nothing, and the moved rows are out of the scan,
        # so the next boot would have nothing to heal from.
        with self._lock, self.conn:
            self._meta_set("agent_migration_unshipped", ",".join(still_pending))
        with self._lock:
            rows = self.conn.execute(
                """SELECT id, content, source, timestamp, kind, importance,
                          metadata_json, veracity, author_id, author_type, repo, app,
                          created_at
                   FROM working_memory
                   WHERE origin = 'deliberate'
                     AND id NOT IN (SELECT id FROM agent_memory)"""
            ).fetchall()
        unshipped = list(still_pending)
        moved = 0
        with self._lock, self.conn:
            for row in rows:
                anchor = self.get_or_create_session(
                    machine=LEGACY_MACHINE,
                    tool=row["app"] or "opencode",
                    client_conversation_id=UNRECORDED_CONVERSATION,
                )
                self.upsert_agent({**dict(row), "session_id": anchor})
                self.forget("working_memory", row["id"])
                moved += 1
                if emit is not None:
                    try:
                        if not self._emit_migrated(row["id"], emit):
                            unshipped.append(row["id"])
                    except Exception:
                        unshipped.append(row["id"])
            # Drain pass: a deliberate working copy that survived the copy
            # loop — its agent twin came from sync apply, or a crash landed
            # before the tombstone. Two cases:
            # - Same content as the twin: forget the copy (verdicts stay —
            #   the content stands in the twin) and emit the forget record
            #   for the machines that have not drained yet.
            # - Different content: an edited straggler. An edit always
            #   re-lands in working_memory (the update routes there when
            #   no twin existed yet, and a remote edit's memory record
            #   re-lands here the same way), so the working copy holds the
            #   newest intent: fold it into the twin, re-ship the agent
            #   record, forget the copy. Draining a divergent copy without
            #   the fold would lose the edit everywhere.
            drained = 0
            for survivor in self.conn.execute(
                """SELECT id, source, timestamp, kind, importance,
                          metadata_json, veracity, author_id, author_type, repo, app,
                          created_at, content
                   FROM working_memory WHERE origin = 'deliberate'"""
            ).fetchall():
                twin = self.agent_row(survivor["id"])
                divergent = bool(twin) and twin["content"] != survivor["content"]
                if divergent:
                    self.upsert_agent(
                        {**dict(survivor), "session_id": twin["session_id"]}, force=True
                    )
                self.forget("working_memory", survivor["id"])
                drained += 1
                if emit is not None:
                    try:
                        forgot_ship = emit(
                            "forget", {"table": "working_memory", "id": survivor["id"]}
                        )
                        agent_ship = True
                        if divergent:
                            agent_ship = emit(
                                "agent_memory", self.agent_record_payload(survivor["id"])
                            )
                        if forgot_ship is False or agent_ship is False:
                            unshipped.append(survivor["id"])
                    except Exception:
                        unshipped.append(survivor["id"])
        if unshipped:
            with self._lock, self.conn:
                self._meta_set("agent_migration_unshipped", ",".join(unshipped))
        if moved or drained:
            print(
                f"agent migration: moved {moved} deliberate row(s); "
                f"drained {drained} surviving working copy(ies)",
                flush=True,
            )
        return moved

    # --- episodic ---------------------------------------------------------

    def upsert_episodic(self, row: dict) -> None:
        """Idempotent episodic upsert. Hub-produced rows apply on every
        machine; embedding happens here (vectors are never shipped)."""
        with self._lock, self.conn:
            existing = self.conn.execute(
                "SELECT rowid, content FROM episodic_memory WHERE id = ?", (row["id"],)
            ).fetchone()
            if existing and existing["content"] == row["content"]:
                return
            if existing:
                self.conn.execute(
                    """UPDATE episodic_memory SET
                         content = ?, source = ?, timestamp = ?, session_id = ?,
                         importance = ?, metadata_json = ?, veracity = ?,
                         repo = ?, origin = ?, app = ?, summary_of = ?
                       WHERE id = ?""",
                    (
                        row["content"],
                        row.get("source"),
                        row.get("timestamp"),
                        row.get("session_id", "default"),
                        row.get("importance", 0.5),
                        json.dumps(row.get("metadata") or {}),
                        row.get("veracity", "unknown"),
                        row.get("repo", ""),
                        row.get("origin", "consolidated"),
                        row.get("app", "memory-store"),
                        row.get("summary_of", ""),
                        row["id"],
                    ),
                )
                rowid = existing["rowid"]
            else:
                cursor = self.conn.execute(
                    """INSERT INTO episodic_memory
                       (id, content, source, timestamp, session_id, importance,
                        metadata_json, veracity, repo, origin, app, summary_of)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        row["id"],
                        row["content"],
                        row.get("source"),
                        row.get("timestamp"),
                        row.get("session_id", "default"),
                        row.get("importance", 0.5),
                        json.dumps(row.get("metadata") or {}),
                        row.get("veracity", "unknown"),
                        row.get("repo", ""),
                        row.get("origin", "consolidated"),
                        row.get("app", "memory-store"),
                        row.get("summary_of", ""),
                    ),
                )
                rowid = cursor.lastrowid
            if self.vec_available:
                embedding = self.embed([row["content"]], origin="upsert-episodic")[0]
                self._vec_delete("vec_episodes", rowid)
                self._vec_insert("vec_episodes", rowid, embedding)

    def deliberate_writes(self, since: str = "") -> dict:
        """Count deliberate writes newer than `since`, with the current high
        water mark. Whether the last one was honoured is a question about
        the store rather than about the conversation. An empty `since`
        establishes a baseline instead of counting all of history as
        compliance.

        The deliberate content lives in agent_memory; working-memory rows
        still carrying the origin tag are migration stragglers (replayed
        old records between boots) — matched with the same NOT-IN guard
        every content reader uses, so a row in both homes is counted once.
        Timestamps ride through the migration verbatim, so the watermark
        is continuous across it."""
        row = self.conn.execute(
            """SELECT COALESCE(SUM(CASE WHEN timestamp > ? THEN 1 ELSE 0 END), 0) AS written,
                      MAX(timestamp) AS watermark
               FROM (
                   SELECT timestamp FROM agent_memory
                   UNION ALL
                   SELECT timestamp FROM working_memory
                   WHERE origin = 'deliberate'
                     AND id NOT IN (SELECT id FROM agent_memory)
               )""",
            (since or "",),
        ).fetchone()
        return {
            "count": int(row["written"]) if since else 0,
            "watermark": row["watermark"] or "",
        }

    # --- tool enrollment -----------------------------------------------------

    def bind_tool(self, tool: dict, rule: dict) -> None:
        """Upsert one enrollment: the tool row and its binding, in one
        transaction (the apply target for the tool_rule record kind and
        the write path behind tool_rule_add). Ids are re-minted
        here from the payload's content — every machine applying the
        record lands the pair on the same rows (a replayed or
        divergent-id record re-inserts nothing), so the wire's own ids
        are advisory and convergence never depends on the emitter's
        arithmetic."""
        tool_id, rule_id = mint_tool_rule_ids(tool, rule)
        with self._lock, self.conn:
            self.conn.execute(
                """INSERT INTO tools (id, kind, key, created_by, created_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO NOTHING""",
                (
                    tool_id,
                    tool["kind"],
                    json.dumps(tool["key"]),
                    tool["created_by"],
                    tool["created_at"],
                ),
            )
            self.conn.execute(
                """INSERT INTO tool_rules
                       (id, tool_id, guidance_id, note, scope, project,
                        conversation_id, created_by, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO NOTHING""",
                (
                    rule_id,
                    tool_id,
                    rule.get("guidance_id"),
                    rule.get("note"),
                    rule["scope"],
                    rule.get("project", ""),
                    rule.get("conversation_id", ""),
                    rule["created_by"],
                    rule["created_at"],
                ),
            )

    def tool_bindings(self) -> list[dict]:
        """Every enrollment joined: one row per binding with the tool's
        kind and key parsed. The matcher's candidate set — small by
        construction (the fleet enrolls deliberately), so no index
        gymnastics at match time."""
        rows = self.conn.execute(
            """SELECT t.id AS tool_id, t.kind, t.key, t.created_by AS tool_created_by,
                      r.id AS rule_id, r.guidance_id, r.note, r.scope, r.project,
                      r.conversation_id, r.created_by, r.created_at
                 FROM tool_rules r JOIN tools t ON t.id = r.tool_id"""
        ).fetchall()
        parsed = []
        for row in rows:
            binding = dict(row)
            binding["key"] = json.loads(binding["key"])
            parsed.append(binding)
        return parsed

    def tool_rule(self, rule_id: str) -> dict | None:
        """One enrollment joined by binding id, or None. The promote/copy
        commands' source fetch: the joined tool row rides along because
        re-emitting the pair (never the rule alone) is the wire's shape."""
        row = self.conn.execute(
            """SELECT t.id AS tool_id, t.kind, t.key, t.created_by AS tool_created_by,
                      t.created_at AS tool_created_at,
                      r.id AS rule_id, r.guidance_id, r.note, r.scope, r.project,
                      r.conversation_id, r.created_by, r.created_at
                 FROM tool_rules r JOIN tools t ON t.id = r.tool_id
                WHERE r.id = ?""",
            (rule_id,),
        ).fetchone()
        if row is None:
            return None
        rule = dict(row)
        rule["key"] = json.loads(rule["key"])
        return rule

    def tool_rules_for_key(self, kind: str, key: list[str]) -> list[dict]:
        """Every enrollment on a tool key, joined — the cross-project
        lookup's read (PRJ-168): one key pins the tool row, the join fans
        out to the bindings any project hung on it. Rows carry their
        scope and project; the caller labels visibility against its own
        project (filtering here would hide the very rows the lookup
        exists to expose)."""
        tool_id = tool_key_id(kind, key)
        rows = self.conn.execute(
            """SELECT t.id AS tool_id, t.kind, t.key, t.created_by AS tool_created_by,
                      t.created_at AS tool_created_at,
                      r.id AS rule_id, r.guidance_id, r.note, r.scope, r.project,
                      r.conversation_id, r.created_by, r.created_at
                 FROM tool_rules r JOIN tools t ON t.id = r.tool_id
                WHERE r.tool_id = ?
                ORDER BY r.created_at, r.id""",
            (tool_id,),
        ).fetchall()
        parsed = []
        for row in rows:
            rule = dict(row)
            rule["key"] = json.loads(rule["key"])
            parsed.append(rule)
        return parsed

    def tool_fires_seen(self, tool_id: str, conversation_id: str) -> bool:
        return (
            self.conn.execute(
                "SELECT 1 FROM tool_fires WHERE tool_id = ? AND conversation_id = ?",
                (tool_id, conversation_id),
            ).fetchone()
            is not None
        )

    def record_tool_fire(self, tool_id: str, conversation_id: str, *, app: str, held: bool) -> None:
        """One execution of a bound tool per conversation. INSERT OR IGNORE:
        the first fire (held or not) is the row the hold-once check reads;
        later fires of the same tool in the same conversation change
        nothing — telemetry wants distinct executions, not a log."""
        with self._lock, self.conn:
            self.conn.execute(
                """INSERT OR IGNORE INTO tool_fires
                       (tool_id, conversation_id, app, held)
                   VALUES (?, ?, ?, ?)""",
                (tool_id, conversation_id, app, 1 if held else 0),
            )

    def stamp_usage(self, rows: list[tuple[str, str]]) -> None:
        """Bump count and last-used for rows an agent just read. One call
        that returned a row = one read, however many rows it carried back;
        a row returned twice by one call counts once (the agent did not
        read it twice). The stamp is a side table for a reason: counting
        on the memory rows themselves would push telemetry through the
        sync wire payloads and turn cross-machine replication into a
        merge problem. Only the Tools read handlers call this — automatic
        lookups (nudge pools, session-open, tool-recall, tool-moment, KB
        build, consolidation, sync) share the query helpers but never
        reach a stamp, which is the zero-stamp guarantee made structural."""
        if not rows:
            return
        # Dedupe within one call, keeping first-seen order (stable for tests).
        unique = list(dict.fromkeys(rows))
        with self._lock, self.conn:
            self.conn.executemany(
                """INSERT INTO usage_counters (row_id, tier, count, last_used_at)
                       VALUES (?, ?, 1, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
                   ON CONFLICT(row_id) DO UPDATE SET
                       count = count + 1,
                       tier = excluded.tier,
                       last_used_at = excluded.last_used_at""",
                unique,
            )

    # --- compliance ladder ---------------------------------------------------

    def compliance_state_for(self, conversation_id: str) -> dict | None:
        """The conversation's ladder row, or None when it never touched the
        ladder. One state row per client conversation; the active_turns and
        level columns are the daemon's whole decision surface."""
        row = self.conn.execute(
            "SELECT * FROM compliance_state WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchone()
        return dict(row) if row else None

    def compliance_bump_turn(self, conversation_id: str, app: str, machine: str) -> dict:
        """One active turn arrived: increment and return the row. The turn
        count is turns the *client* already filtered for substance — this
        layer only counts what it is told."""
        with self._lock, self.conn:
            self.conn.execute(
                """INSERT INTO compliance_state
                       (conversation_id, app, machine, active_turns, total_turns)
                       VALUES (?, ?, ?, 1, 1)
                   ON CONFLICT(conversation_id) DO UPDATE SET
                       active_turns = active_turns + 1,
                       total_turns = total_turns + 1,
                       app = excluded.app,
                       machine = excluded.machine,
                       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')""",
                (conversation_id, app, machine),
            )
        return self.compliance_state_for(conversation_id)

    def compliance_mark_pull(self, conversation_id: str, app: str, machine: str) -> None:
        """The agent pulled: counters reset, level forgotten, the pull kept
        for the aggregates. Whatever silence had accrued is over."""
        with self._lock, self.conn:
            self.conn.execute(
                """INSERT INTO compliance_state
                       (conversation_id, app, machine, last_pull_at, total_pulls)
                       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 1)
                   ON CONFLICT(conversation_id) DO UPDATE SET
                       active_turns = 0,
                       level = 0,
                       last_pull_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
                       total_pulls = total_pulls + 1,
                       app = excluded.app,
                       machine = excluded.machine,
                       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')""",
                (conversation_id, app, machine),
            )

    def compliance_open_event(
        self, conversation_id: str, app: str, machine: str, level: int, turns_at_fire: int
    ) -> dict:
        """Journal one escalation, and move the conversation's level with it
        (one write, so the fired ladder and its journal row never disagree).
        Returns the row so the daemon's span can record the event id and the
        reminder rides the state it came with."""
        with self._lock, self.conn:
            cursor = self.conn.execute(
                """INSERT INTO compliance_events
                       (conversation_id, app, machine, level, turns_at_fire)
                       VALUES (?, ?, ?, ?, ?)""",
                (conversation_id, app, machine, level, turns_at_fire),
            )
            self.conn.execute(
                """UPDATE compliance_state
                      SET level = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                    WHERE conversation_id = ?""",
                (level, conversation_id),
            )
            row = self.conn.execute(
                "SELECT * FROM compliance_events WHERE id = ?",
                (cursor.lastrowid,),
            ).fetchone()
        return dict(row)

    # --- deferred session-start facts ------------------------------------------

    def session_facts_defer(
        self, conversation_id: str, app: str, project: str, fact_ids: list[str]
    ) -> None:
        """Hold the opening request's facts for this conversation. A repeat
        session-open (a client retrying) replaces the ranking but never
        reopens a fetch or a hold that already happened."""
        with self._lock, self.conn:
            self.conn.execute(
                """INSERT INTO session_open_facts (conversation_id, app, project, fact_ids)
                       VALUES (?, ?, ?, ?)
                   ON CONFLICT(conversation_id) DO UPDATE SET
                       app = excluded.app,
                       project = excluded.project,
                       fact_ids = excluded.fact_ids""",
                (conversation_id, app, project, json.dumps(list(fact_ids))),
            )

    def session_facts_for(self, conversation_id: str) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM session_open_facts WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchone()
        if row is None:
            return None
        out = dict(row)
        out["fact_ids"] = json.loads(out["fact_ids"] or "[]")
        return out

    def session_facts_mark_fetched(self, conversation_id: str) -> None:
        with self._lock, self.conn:
            self.conn.execute(
                """UPDATE session_open_facts
                      SET fetched_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                    WHERE conversation_id = ? AND fetched_at IS NULL""",
                (conversation_id,),
            )

    def session_facts_take_hold(self, conversation_id: str) -> bool:
        """Claim the conversation's one hold: True for exactly one caller,
        and only while the facts are still unfetched, so two concurrent tool
        calls cannot both be refused."""
        with self._lock, self.conn:
            cursor = self.conn.execute(
                """UPDATE session_open_facts
                      SET held_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                    WHERE conversation_id = ? AND fetched_at IS NULL AND held_at IS NULL
                      AND fact_ids != '[]'""",
                (conversation_id,),
            )
        return cursor.rowcount == 1

    def deliberate_rows(self, ids: list[str]) -> list[dict]:
        """Rows by id from the deliberate home, then working memory, in the
        order asked. A forgotten row is gone from both and is skipped."""
        out = []
        for row_id in ids:
            for home in ("agent_memory", "working_memory"):
                row = self.conn.execute(f"SELECT * FROM {home} WHERE id = ?", (row_id,)).fetchone()
                if row is not None:
                    out.append(dict(row))
                    break
        return out

    def compliance_resolve_open(
        self, conversation_id: str, active_turns: int, now: str
    ) -> list[dict]:
        """A pull landed: every pending escalation of this conversation is
        closed as `recalled`, its turns_after computed from the caller's
        active_turns count (the pull read it before the reset). Returns the
        resolved rows for the daemon's span."""
        with self._lock, self.conn:
            self.conn.execute(
                """UPDATE compliance_events
                      SET outcome = 'recalled',
                          recalled_at = ?,
                          turns_after = ? - turns_at_fire
                    WHERE conversation_id = ? AND outcome = 'pending'""",
                (now, active_turns, conversation_id),
            )
            rows = self.conn.execute(
                """SELECT * FROM compliance_events
                    WHERE conversation_id = ? AND outcome = 'recalled' AND recalled_at = ?""",
                (conversation_id, now),
            ).fetchall()
        return [dict(row) for row in rows]

    def compliance_expire_open(
        self, conversation_id: str, active_turns: int, outcome_turns: int
    ) -> list[dict]:
        """Close pendings that have gone unanswered past the outcome window:
        no pull within K active turns of the escalation is the answer that
        escalation was ignored (the daemon decides when, by absolute turn
        counts — no timers, no lazy re-checks)."""
        with self._lock, self.conn:
            self.conn.execute(
                """UPDATE compliance_events
                      SET outcome = 'expired'
                    WHERE conversation_id = ? AND outcome = 'pending'
                      AND ? - turns_at_fire >= ?""",
                (conversation_id, active_turns, outcome_turns),
            )
            rows = self.conn.execute(
                """SELECT * FROM compliance_events
                    WHERE conversation_id = ? AND outcome = 'expired'""",
                (conversation_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def compliance_aggregates(self, window_days: int | None = None) -> dict:
        """The review aggregates: how many conversations were observed and
        how many pulled (the no-nudge base rate), the escalation events in
        the window (or ever) with their conversions per level, and the max
        level reached. The operator's review reads this, not the raw tables."""
        cutoff = ""
        if window_days is not None:
            if window_days == 0:
                cutoff = self.conn.execute(
                    """SELECT strftime('%Y-%m-%dT00:00:00Z','now') AS cutoff"""
                ).fetchone()["cutoff"]
            else:
                cutoff = self.conn.execute(
                    """SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now', ?) AS cutoff""",
                    (f"-{window_days} days",),
                ).fetchone()["cutoff"]
        window_sql = "WHERE escalated_at >= ?" if cutoff else ""
        window_args: tuple = (cutoff,) if cutoff else ()

        state = self.conn.execute(
            """SELECT COUNT(*) AS observed,
                      COALESCE(SUM(total_turns > 0), 0) AS observed_active,
                      COALESCE(SUM(total_pulls > 0), 0) AS with_pulls,
                      COALESCE(SUM(total_turns), 0) AS total_turns,
                      COALESCE(SUM(total_pulls), 0) AS total_pulls
                 FROM compliance_state"""
        ).fetchone()
        by_level = [
            dict(row)
            for row in self.conn.execute(
                f"""SELECT level, COUNT(*) AS fired,
                           SUM(outcome = 'recalled') AS recalled,
                           SUM(outcome = 'expired') AS expired,
                           SUM(outcome = 'pending') AS pending
                      FROM compliance_events {window_sql}
                  GROUP BY level ORDER BY level""",
                window_args,
            )
        ]
        totals = self.conn.execute(
            f"""SELECT COUNT(*) AS total,
                       COALESCE(MAX(level), 0) AS max_level,
                       SUM(outcome = 'recalled') AS recalled,
                       AVG(CASE WHEN outcome = 'recalled' THEN turns_after END)
                           AS avg_turns_after
                  FROM compliance_events {window_sql}""",
            window_args,
        ).fetchone()
        report = {
            "window_days": window_days,
            "conversations": {
                # Observed counts the conversations that ever carried an
                # active turn (a bare pull report is not a session to
                # compare against), and with_pulls is the no-nudge base
                # rate's numerator.
                "observed": state["observed_active"],
                "with_pulls": state["with_pulls"],
                "total_turns": state["total_turns"],
                "total_pulls": state["total_pulls"],
            },
            "events": {
                "total": totals["total"],
                "max_level": totals["max_level"],
                "recalled_total": totals["recalled"],
                "avg_turns_to_recall": (
                    round(totals["avg_turns_after"], 2)
                    if totals["avg_turns_after"] is not None
                    else None
                ),
            },
            "by_level": by_level,
        }
        return report

    # --- knowledge base -----------------------------------------------------

    def upsert_kb(self, record: dict) -> None:
        """Insert one KB build version (the apply target and the read-side
        wrapper). See _insert_kb for the resolution rules."""
        with self._lock, self.conn:
            self._insert_kb(record)

    def _insert_kb(self, record: dict) -> None:
        """Insert one KB build version under a caller-held transaction. The
        standing-winner rule is kb_current's read: the highest build_seq
        with the newest created_at wins, and a race's loser stays as
        history (its content is not lost — the seq-race note in kb.py).
        An identical id (a replayed record) re-inserts nothing."""
        self.conn.execute(
            """INSERT INTO knowledge_base
                   (id, project, doc, inputs, build_seq, created_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO NOTHING""",
            (
                record["id"],
                record["project"],
                record["doc"],
                json.dumps(record.get("inputs", [])),
                record["build_seq"],
                record["created_at"],
            ),
        )

    def kb_current(self, project: str | None = None) -> list[dict]:
        """The standing doc per project (or every project): one row each,
        the winning version carried. A seq contest resolves to the most
        recently composed row (deterministic on any machine), so two
        build passes that raced on the same seq converge to one doc."""
        projects = (
            [project]
            if project
            else [
                row["project"]
                for row in self.conn.execute("SELECT DISTINCT project FROM knowledge_base")
            ]
        )
        out = []
        for name in sorted(projects):
            row = self.conn.execute(
                """SELECT id, project, doc, inputs, build_seq, created_at
                     FROM knowledge_base WHERE project = ?
                     ORDER BY build_seq DESC, created_at DESC, id ASC LIMIT 1""",
                (name,),
            ).fetchone()
            if row:
                out.append(
                    {
                        "id": row["id"],
                        "project": row["project"],
                        "doc": row["doc"],
                        "inputs": json.loads(row["inputs"]),
                        "build_seq": row["build_seq"],
                        "created_at": row["created_at"],
                    }
                )
        return out

    # --- persona floor ------------------------------------------------------

    def persona_budget_state(self) -> dict:
        """Current budget accounting: sum of statement lengths across
        active rows, plus per-rule sizes for composing trades."""
        rows = self.conn.execute(
            """SELECT id, status, length(statement) AS size, substr(statement, 1, 60) AS head
               FROM persona_rules
               WHERE status = 'active'
               ORDER BY id"""
        ).fetchall()
        total = sum(r["size"] for r in rows)
        return {
            "budget": PERSONA_BUDGET,
            "total": total,
            "remaining": PERSONA_BUDGET - total,
            "rows": [dict(r) for r in rows],
        }

    def upsert_persona(self, row: dict) -> dict:
        """Insert or update a persona rule. Enforces the global budget across
        active rows at every write: an over-budget write is refused with the
        roster attached so the compensating trade is composed in-session.
        Retired rows are free. Returns budget accounting.

        The budget is measured after the edit, so shortening a rule passes
        even when the floor is already over its ceiling — which is how a
        floor that arrived over-budget trims itself back down."""
        with self._lock, self.conn:
            statement = row["statement"]
            status = row.get("status", "active")
            status = LEGACY_PERSONA_STATUSES.get(status, status)
            if status not in PERSONA_STATUSES:
                raise ValueError(f"invalid persona status {status!r}")
            existing = self.conn.execute(
                "SELECT id, status, length(statement) AS size FROM persona_rules WHERE id = ?",
                (row["id"],),
            ).fetchone()
            state = self.persona_budget_state()
            charge = len(statement)
            if status == "active":
                freed = existing["size"] if existing and existing["status"] == "active" else 0
                if state["total"] - freed + charge > PERSONA_BUDGET:
                    return {"status": "refused", "reason": "budget", "budget_state": state}
            self.conn.execute(
                """INSERT INTO persona_rules
                   (id, statement, status, topic, provenance, origin_machine)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     statement = excluded.statement,
                     status = excluded.status,
                     topic = CASE
                       WHEN excluded.topic = '' THEN persona_rules.topic
                       ELSE excluded.topic END,
                     provenance = CASE
                       WHEN excluded.provenance IS NULL THEN persona_rules.provenance
                       ELSE excluded.provenance END,
                     origin_machine = CASE
                       WHEN excluded.origin_machine IS NULL THEN persona_rules.origin_machine
                       ELSE excluded.origin_machine END,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')""",
                (
                    row["id"],
                    statement,
                    status,
                    normalize_topic(row.get("topic")),
                    row.get("provenance"),
                    row.get("origin_machine"),
                ),
            )
            return {"status": "ok", "budget_state": self.persona_budget_state()}

    # --- situational rules ----------------------------------------------------

    def upsert_situational(self, row: dict) -> None:
        # No fallbacks: a missing grader or stance is rejected below rather
        # than filled in. Every emitter selects both from NOT NULL columns,
        # so a wire row lacking one is malformed, not old.
        grader = row.get("grader")
        stance = row.get("stance")
        if grader not in SITUATIONAL_GRADERS:
            raise ValueError(f"invalid grader {grader!r}")
        if stance not in SITUATIONAL_STANCES:
            raise ValueError(f"invalid stance {stance!r}")
        with self._lock, self.conn:
            self.conn.execute(
                """INSERT INTO situational_rules
                   (id, situation, statement, rationale, grader, stance, scope,
                    status, provenance, origin_machine)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                     situation = excluded.situation,
                     statement = excluded.statement,
                     rationale = excluded.rationale,
                     grader = excluded.grader,
                     stance = excluded.stance,
                     scope = excluded.scope,
                     status = excluded.status,
                     provenance = CASE
                       WHEN excluded.provenance IS NULL THEN situational_rules.provenance
                       ELSE excluded.provenance END,
                     origin_machine = CASE
                       WHEN excluded.origin_machine IS NULL THEN situational_rules.origin_machine
                       ELSE excluded.origin_machine END,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')""",
                (
                    row["id"],
                    row["situation"],
                    row["statement"],
                    row.get("rationale"),
                    grader,
                    stance,
                    row.get("scope") or "",
                    row.get("status", "active"),
                    row.get("provenance"),
                    row.get("origin_machine"),
                ),
            )

    def apply_feedback(
        self,
        rule_id: int,
        rule_kind: str,
        signal: str,
        delta: float = 1.0,
        origin_machine: str | None = None,
        grounds: str | None = None,
        polarity: str | None = None,
        record_id: str | None = None,
    ) -> None:
        """Feedback is accumulative by construction (ADR record-log-sync):
        increments append to the log; confidence is derived, never stored.
        `grounds` records why — audit data, never interpreted. Situational
        signals are normalized onto the canonical vocabulary (accepting the
        agent-facing confirm|disconfirm|soft shape via `polarity`); the
        counter direction comes from SIGNAL_COUNTERS and the soft weighting
        lives in delta (the tool layer passes 0.25 for soft signals).
        Persona "apply" records stay as-is: an apply-count increment, not a
        grade.

        `record_id` makes a replay idempotent: the hub relays every record
        back to its origin, so an origin machine sees its own grading
        again — pass the wire record_id at both sites and the echo is a
        no-op (the partial UNIQUE index absorbs it; the counter moves only
        when the row actually inserted). Applies without a record_id are
        not deduped (legacy paths, tests)."""
        if signal == "apply" and rule_kind == "persona":
            canonical = "apply"
        else:
            canonical = normalize_signal(signal, polarity or "")
        with self._lock, self.conn:
            cursor = self.conn.execute(
                """INSERT OR IGNORE INTO feedback_log (rule_id, rule_kind, signal, delta,
                                                      origin_machine, grounds, record_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (rule_id, rule_kind, canonical, delta, origin_machine, grounds, record_id),
            )
            if record_id is not None and cursor.rowcount == 0:
                return  # already applied from this exact record
            column = SIGNAL_COUNTERS.get(canonical)
            if column and rule_kind == "situational":
                self.conn.execute(
                    f"UPDATE situational_rules SET {column} = {column} + ? WHERE id = ?",
                    (delta, rule_id),
                )
            elif canonical == "apply" and rule_kind == "persona":
                self.conn.execute(
                    """UPDATE persona_rules
                       SET apply_count = apply_count + ?,
                           last_applied_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
                       WHERE id = ?""",
                    (delta, rule_id),
                )

    def confidence(self, rule_id: int, k: float = 5.0, p0: float = 0.5) -> float | None:
        """Bayesian posterior shared by behaviors and predictions (thatch's
        constants; soft signals are already folded into delta at write time)."""
        row = self.conn.execute(
            "SELECT confirm_count, disconfirm_count FROM situational_rules WHERE id = ?",
            (rule_id,),
        ).fetchone()
        if row is None:
            return None
        confirm, disconfirm = row["confirm_count"], row["disconfirm_count"]
        return (confirm + k * p0) / (confirm + disconfirm + k)

    # --- forget ---------------------------------------------------------

    def forget(self, table: str, row_id: str | int) -> None:
        """Delete a row and its derived index entries. `forget` records ride
        the log; deletes must survive delayed replay of the original write, so
        forgets append to the tombstone table before deleting. Guards are
        per-table: a deliberate id's two homes are guarded independently, and
        the tombstone each home already carries from its own path (the
        migration tombstones working; a forget tombstones the table it acts
        on) is what refuses a delayed replay of either wire kind.

        The dedup verdicts clear when the id's content is gone from every
        deliberate home: a migrated row's working-copy delete leaves its
        content standing in agent_memory under the same id, so the verdicts
        naming a live pair survive the move."""
        if table == "entities":
            # An entry is forgotten by adding a row, and a tombstone would
            # refuse the records a restore needs.
            raise ValueError("entities are forgotten with forget_entity")
        allowed = set(FORGET_TABLES)
        if table not in allowed:
            raise ValueError(f"cannot forget from {table!r}")
        with self._lock, self.conn:
            # The KB's eviction scan needs the dead row's text: a folded
            # claim is prose in a composed sheet, and an id alone cannot
            # name it. Content rides the tombstone; existing tombstones
            # (NULL content) are skipped by every reader.
            body = None
            if table in ("working_memory", "agent_memory", "episodic_memory"):
                body = self.conn.execute(
                    f"SELECT content FROM {table} WHERE id = ?", (row_id,)
                ).fetchone()
            # Idempotent: the hub relays a machine's own forget records back
            # to it, so forget() runs again on replay. The tombstone's whole
            # semantic is "already forgotten" — re-inserting the same key is
            # a no-op, not a constraint violation (the UNIQUE failure here
            # poisoned the sync cursor, re-failing every cycle).
            self.conn.execute(
                "INSERT OR IGNORE INTO forget_tombstones (table_name, row_id) VALUES (?, ?)",
                (table, str(row_id)),
            )
            if body is not None:
                self.conn.execute(
                    """UPDATE forget_tombstones SET content = ?
                       WHERE table_name = ? AND row_id = ? AND content IS NULL""",
                    (body["content"], table, str(row_id)),
                )
            if table == "working_memory":
                row = self.conn.execute(
                    "SELECT rowid FROM working_memory WHERE id = ?", (row_id,)
                ).fetchone()
                if row and self.vec_available:
                    self._vec_delete("vec_working", row["rowid"])
                self.conn.execute("DELETE FROM working_memory WHERE id = ?", (row_id,))
            elif table == "agent_memory":
                row = self.conn.execute(
                    "SELECT rowid FROM agent_memory WHERE id = ?", (row_id,)
                ).fetchone()
                if row and self.vec_available:
                    self._vec_delete("vec_agent", row["rowid"])
                self.conn.execute("DELETE FROM agent_memory WHERE id = ?", (row_id,))
            elif table == "episodic_memory":
                row = self.conn.execute(
                    "SELECT rowid FROM episodic_memory WHERE id = ?", (row_id,)
                ).fetchone()
                if row and self.vec_available:
                    self._vec_delete("vec_episodes", row["rowid"])
                self.conn.execute("DELETE FROM episodic_memory WHERE id = ?", (row_id,))
            elif table == "persona_rules":
                self.conn.execute(
                    "UPDATE persona_rules SET status = 'retired' WHERE id = ?", (row_id,)
                )
            elif table == "tool_rules":
                # A binding's removal (PRJ-168 promote, or the agent's own
                # correction): the tombstone is what refuses the delayed
                # replay of the original tool_rule enrollment record on
                # every machine — without it, a promoted binding's
                # project-scoped row resurrects fleet-wide.
                self.conn.execute("DELETE FROM tool_rules WHERE id = ?", (row_id,))
            else:
                self.conn.execute("DELETE FROM situational_rules WHERE id = ?", (row_id,))
            # The verdict clears when the id's content is gone from every
            # deliberate home (see the docstring): a working-copy delete
            # with the agent twin standing — or vice versa — keeps verdicts
            # for a live pair.
            survives = self.conn.execute(
                "SELECT 1 FROM working_memory WHERE id = ? "
                "UNION ALL SELECT 1 FROM agent_memory WHERE id = ?",
                (row_id, row_id),
            ).fetchone()
            # Verdicts name content, not a table: a migrated id's content
            # stands in agent_memory under the same id, so the verdicts
            # naming a live pair survive a working-copy delete and clear
            # only when the id has no content in either home.
            if not survives:
                self.clear_dedup_verdicts(row_id)

    def is_tombstoned(self, table: str, row_id: str | int) -> bool:
        return (
            self.conn.execute(
                "SELECT 1 FROM forget_tombstones WHERE table_name = ? AND row_id = ?",
                (table, str(row_id)),
            ).fetchone()
            is not None
        )

    def clear_dedup_verdicts(self, row_id: str) -> None:
        """Drop every dedup verdict naming row_id (idempotent): a write that
        changed or deleted the row invalidates the pair's adjudication.
        A merged row may now duplicate something else and SHOULD re-flag."""
        with self._lock, self.conn:
            self.conn.execute(
                "DELETE FROM dedup_verdicts WHERE row_a = ? OR row_b = ?",
                (row_id, row_id),
            )

    # --- record log (relay-side; clients keep cursors, the hub keeps rows) ---

    def append_records(self, records: Iterable[dict], machine_id: str) -> None:
        with self._lock, self.conn:
            for record in records:
                self.conn.execute(
                    """INSERT OR IGNORE INTO record_log
                       (record_id, kind, machine_id, payload)
                       VALUES (?, ?, ?, ?)""",
                    (
                        record["record_id"],
                        record["kind"],
                        record.get("machine_id", machine_id),
                        json.dumps(record["payload"]),
                    ),
                )

    # --- entity directory ------------------------------------------------

    def apply_entity(self, payload: dict) -> None:
        """Apply one entity op, local or synced, and recompute the state it
        affects — one transaction, so no reader sees rows without the state
        derived from them.

        An insert carries its whole row, the writing session and timestamp
        included, so every machine stores the same row and a replay inserts
        nothing. The one column that differs between machines is
        session_id: each resolves the session to its own registry row. A
        removal names the row it ends and keeps the earliest deleted_at, so
        two machines ending the same row agree.

        A removal whose row has not arrived raises. The caller defers the
        record and retries it once the row is there (ADR 20261023-forward-
        compatible-sync), which is what keeps apply order-independent
        without a table of pending removals."""
        op = payload.get("op")
        row_id = payload.get("id")
        if op in ENTITY_INSERT_TABLES:
            table = ENTITY_INSERT_TABLES[op]
            fields = ENTITY_INSERT_FIELDS[op]
            defaults = ENTITY_INSERT_DEFAULTS.get(op, {})
            columns = ["id", *fields, *defaults, "session_id", "created_at"]
            values = [
                row_id,
                *(payload[field] for field in fields),
                *(payload.get(field, default) for field, default in defaults.items()),
                self._entity_session(payload.get("session")),
                payload["created_at"],
            ]
            with self._lock, self.conn:
                self.conn.execute(
                    f"INSERT OR IGNORE INTO {table} ({','.join(columns)}) "
                    f"VALUES ({','.join('?' * len(columns))})",
                    values,
                )
                self._rematerialize_for(op)
            return
        if op not in ENTITY_REMOVE_TABLES:
            raise ValueError(f"unknown entity op {op!r}")
        table = ENTITY_REMOVE_TABLES[op]
        deleted_at = payload["deleted_at"]
        with self._lock, self.conn:
            existing = self.conn.execute(
                f"SELECT deleted_at FROM {table} WHERE id = ?", (row_id,)
            ).fetchone()
            if existing is None:
                raise ValueError(f"entity {op}: row {row_id!r} is not here yet")
            if not existing["deleted_at"] or deleted_at < existing["deleted_at"]:
                self.conn.execute(
                    f"UPDATE {table} SET deleted_at = ? WHERE id = ?", (deleted_at, row_id)
                )
            self._rematerialize_for(op)

    def forget_entity(
        self,
        entity_id: str,
        forget_id: str,
        created_at: str,
        session: dict,
    ) -> None:
        """Forget an entry by adding a forget row — no delete, and no
        tombstone. The entry's own rows are what a restore brings back, and
        a tombstone would refuse the records that carry them."""
        session_id = self._entity_session(session)
        with self._lock, self.conn:
            self.conn.execute(
                "INSERT OR IGNORE INTO entity_forgets "
                "(id, entity_id, session_id, created_at) VALUES (?, ?, ?, ?)",
                (forget_id, entity_id, session_id, created_at),
            )
            self._materialize_entities()

    def _entity_session(self, session: dict | None) -> str:
        """This machine's registry id for the session a directory row came
        from, registered if it is not here yet."""
        session = session or {}
        return self.get_or_create_session(
            machine=session.get("machine") or "",
            tool=session.get("tool") or "",
            client_conversation_id=session.get("conversation_id") or "",
            project=session.get("project") or "",
        )

    def _rematerialize_for(self, op: str) -> None:
        """Recompute what this op changed. Observations have no derived
        state: reads resolve them through current_entities. Everything else
        can move a merge chain, so it recomputes the directory."""
        if op in ("observe", "unobserve"):
            return
        self._materialize_entities()

    def _materialize_entities(self) -> None:
        """Rebuild current_entities, current_relations and current_aliases
        from the append-only rows.

        Whole-directory rather than per-entry: a merge chain makes the set
        an edit affects open-ended, and recomputing everything is
        order-independent by construction, which is the property the
        append-only design exists to get. The directory holds people, so it
        stays small.

        Conflicting rows can meet here, written on two machines that had
        not synced, such as two acts_for rows for one agent. Newest wins
        (created_at, then id), so every machine settles the same way."""
        forgotten = {
            row["entity_id"]
            for row in self.conn.execute(
                "SELECT entity_id FROM entity_forgets WHERE deleted_at IS NULL"
            )
        }
        entities = {
            row["id"]: {"kind": row["kind"], "created_at": row["created_at"]}
            for row in self.conn.execute("SELECT id, kind, created_at FROM entities")
            if row["kind"] in ENTITY_KINDS and row["id"] not in forgotten
        }
        names: dict[str, str] = {}
        for row in self.conn.execute(
            "SELECT entity_id, display_name FROM entity_names ORDER BY created_at, id"
        ):
            if row["entity_id"] in entities:
                names[row["entity_id"]] = row["display_name"]

        relations = [
            dict(row)
            for row in self.conn.execute(
                "SELECT id, subject_id, verb, object_id, created_at FROM entity_relations "
                "WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC"
            )
            if row["verb"] in ENTITY_RELATION_VERBS
            and row["subject_id"] in entities
            and row["object_id"] in entities
        ]

        acts_for: dict[str, dict] = {}
        merged_into: dict[str, dict] = {}
        for relation in relations:
            subject, obj = relation["subject_id"], relation["object_id"]
            if relation["verb"] == "acts_for":
                if subject in acts_for:
                    continue  # an older row for the same agent
                if entities[subject]["kind"] != "agent" or entities[obj]["kind"] != "human":
                    continue
                acts_for[subject] = relation
            else:
                if subject in merged_into or subject == obj:
                    continue
                if entities[subject]["kind"] != entities[obj]["kind"]:
                    continue
                if self._merge_cycles(merged_into, subject, obj):
                    continue
                merged_into[subject] = relation

        self.conn.execute("DELETE FROM current_entities")
        self.conn.execute("DELETE FROM current_relations")
        self.conn.execute("DELETE FROM current_aliases")
        self.conn.executemany(
            "INSERT INTO current_entities (id, kind, display_name, acts_for, final_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            [
                (
                    entity_id,
                    entity["kind"],
                    names.get(entity_id),
                    (acts_for.get(entity_id) or {}).get("object_id"),
                    self._merge_target(merged_into, entity_id),
                    entity["created_at"],
                )
                for entity_id, entity in entities.items()
            ],
        )
        self.conn.executemany(
            "INSERT INTO current_relations (id, subject_id, verb, object_id, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            [
                (
                    relation["id"],
                    relation["subject_id"],
                    relation["verb"],
                    relation["object_id"],
                    relation["created_at"],
                )
                for relation in list(acts_for.values()) + list(merged_into.values())
            ],
        )
        self.conn.executemany(
            "INSERT INTO current_aliases "
            "(id, entity_id, owner_id, type, instance, value, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    row["id"],
                    self._merge_target(merged_into, row["entity_id"]),
                    row["entity_id"],
                    row["type"],
                    row["instance"],
                    row["value"],
                    row["created_at"],
                )
                for row in self.conn.execute(
                    "SELECT id, entity_id, type, instance, value, created_at "
                    "FROM entity_aliases WHERE deleted_at IS NULL"
                ).fetchall()
                if row["type"] in ENTITY_ALIAS_TYPES and row["entity_id"] in entities
            ],
        )

    @staticmethod
    def _merge_cycles(merged_into: dict[str, dict], subject: str, obj: str) -> bool:
        """Whether merging subject into obj closes a loop. Two machines can
        each merge the other's entry into theirs; taking rows newest first
        and dropping the one that closes the loop leaves the newer merge."""
        seen = {subject}
        current = obj
        while current in merged_into:
            if current in seen:
                return True
            seen.add(current)
            current = merged_into[current]["object_id"]
        return current == subject

    @staticmethod
    def _merge_target(merged_into: dict[str, dict], entity_id: str) -> str:
        """The end of entity_id's merge chain, or itself when unmerged."""
        seen = {entity_id}
        current = entity_id
        while current in merged_into:
            current = merged_into[current]["object_id"]
            if current in seen:
                break  # defensive: _merge_cycles keeps chains acyclic
            seen.add(current)
        return current

    def entity_observations(self, entity_id: str) -> list[dict]:
        """Open observations about an entry, newest first.

        An observation counts for the entry its row names resolves to, so
        a merge gathers the merged entry's observations under its target
        and a forgotten entry's drop out until it is restored. A human's
        list also holds the observations of the agents currently acting
        for them, judged on each agent's final entry: a merged-away
        agent's own acts_for row says nothing about who its target acts
        for. An agent's list holds only its own."""
        with self._lock:
            entry = self.conn.execute(
                "SELECT kind, final_id FROM current_entities WHERE id = ?", (entity_id,)
            ).fetchone()
            if entry is None:
                return []
            targets = [entry["final_id"]]
            if entry["kind"] == "human":
                targets += [
                    row["final_id"]
                    for row in self.conn.execute(
                        "SELECT a.final_id FROM current_entities a "
                        "JOIN current_entities h ON h.id = a.acts_for "
                        "WHERE h.final_id = ? AND a.id = a.final_id",
                        (entry["final_id"],),
                    )
                ]
            marks = ",".join("?" * len(targets))
            return [
                dict(row)
                for row in self.conn.execute(
                    "SELECT o.id, o.entity_id, e.final_id AS about, o.content, o.created_at "
                    "FROM entity_observations o "
                    "JOIN current_entities e ON e.id = o.entity_id "
                    f"WHERE o.deleted_at IS NULL AND e.final_id IN ({marks}) "
                    "ORDER BY o.created_at DESC, o.id DESC",
                    targets,
                )
            ]

    # --- deferred records (machine-local; see sync.retry_deferred) --------

    def defer_record(self, record: dict, reason: str, row_key: str | None = None) -> None:
        """Set a pulled record aside, or re-mark one that failed again.

        The raw record is stored rather than its parts: what makes it
        applyable later is a version of this machine that reads fields
        this one has nowhere to put."""
        with self._lock, self.conn:
            self.conn.execute(
                """INSERT INTO deferred_records
                   (record_id, seq, kind, row_key, record_json, reason)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(record_id) DO UPDATE SET
                     reason = excluded.reason,
                     attempts = attempts + 1,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')""",
                (
                    record["record_id"],
                    int(record["seq"]),
                    record["kind"],
                    row_key,
                    json.dumps(record),
                    reason,
                ),
            )

    def has_deferred_row(self, row_key: str) -> bool:
        return (
            self.conn.execute(
                "SELECT 1 FROM deferred_records WHERE row_key = ? LIMIT 1", (row_key,)
            ).fetchone()
            is not None
        )

    def deferred_records(self) -> list[dict]:
        """Deferred records oldest first, by the hub sequence they were
        logged at: retrying in log order is the closest a late apply gets
        to the order the records were written in."""
        rows = self.conn.execute(
            "SELECT record_id, seq, kind, row_key, record_json, reason, attempts "
            "FROM deferred_records ORDER BY seq, record_id"
        ).fetchall()
        return [dict(row, record=json.loads(row["record_json"])) for row in rows]

    def drop_deferred(self, record_id: str) -> None:
        with self._lock, self.conn:
            self.conn.execute("DELETE FROM deferred_records WHERE record_id = ?", (record_id,))

    def pull_records(self, cursor: int, limit: int = 100) -> dict:
        rows = self.conn.execute(
            """SELECT seq, record_id, kind, machine_id, payload
               FROM record_log WHERE seq > ? ORDER BY seq LIMIT ?""",
            (cursor, limit),
        ).fetchall()
        return {
            "records": [dict(r) for r in rows],
            "next_cursor": rows[-1]["seq"] if rows else cursor,
            "has_more": len(rows) == limit,
        }

    def close(self) -> None:
        self.conn.close()
