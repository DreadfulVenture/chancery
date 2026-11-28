"""Memory daemon: one process per machine serving the memory store.

Replaces the old four-process client stack (daemon + capture worker +
sync client as separate services) with one process:

  - MCP over stateless Streamable HTTP on loopback, serving the memory_*
    tools directly against the owned store — no package dispatch, no
    schema patching. Stateless because a client that caches its MCP
    connection has to survive this process restarting under it.
  - POST /session-open: the session-start KB delivery — the project's
    standing doc plus the opening request's top-k deliberate facts, no
    LLM call, nothing when the repo has no KB.
  - A capture-drain timer: the plugin writes raw turns to a queue file;
    the daemon classifies them (speech|exhibit|fork_summary), upserts,
    and enqueues capture records.
  - A sync timer: one push+pull cycle per interval against the hub.
  - Floor render on sync when a floor-changing record applied.

Single-writer rule: every store mutation goes through the Tools surface
below, which both writes and enqueues the matching record. The Store's
RLock serializes access across MCP-request and timer threads.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import threading
import time
from typing import Any

import anyio
import pydantic
import uvicorn
from mcp.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.types import CallToolResult, ListToolsResult, TextContent, Tool
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from memory_store.capture import (
    classify_capture,
    is_title_gen_template,
    resolve_workspace,
)
from memory_store.consolidation.client_consolidation import ClientConsolidator
from memory_store.consolidation.consolidation import pending_backlog
from memory_store.curated import render_floor
from memory_store import kb
from memory_store.nudge import nudge_score
from memory_store.recall import (
    fts_search_agent,
    fts_search_working,
    lexical_relevance,
    recall_tokens,
)
from memory_store import spans
from memory_store.store import Store
from memory_store.sync import RecordContractError, SyncClient
from memory_store import toolmatch
from memory_store import toolrecall
from memory_store.tools import (
    LINEAGE_REDACT_READS,
    OBSERVATION_LABELS,
    TOOL_DEFINITIONS,
    TOOL_PREFIXES,
    TOOLS_WITH_APP,
    UNANCHORED_WRITE_MESSAGE,
    UNREGISTERED_CONVERSATION_MESSAGE,
    WRITE_TOOLS,
    ToolError,
    Tools,
)

# The mcp_commands surface: new-style modules whose commands ride the same
# MCP endpoint as the legacy Tools class, validated against their own
# pydantic models.
from memory_store.mcp_commands import TOOL_RULE_COMMANDS
from memory_store.mcp_commands.command import ToolContext

MCP_PORT = int(os.environ.get("MEMORY_MCP_PORT", "17173"))
DATA_DIR = os.environ.get("MEMORY_DATA_DIR", os.path.expanduser("~/.local/services/memory/data"))
QUEUE_DIR = os.environ.get("MEMORY_QUEUE_DIR", os.path.expanduser("~/.local/services/memory/queue"))
HUB_URL = os.environ.get("MEMORY_HUB_URL", "")
DRAIN_INTERVAL_SECS = float(os.environ.get("MEMORY_DRAIN_INTERVAL", "20"))
SYNC_INTERVAL_SECS = float(os.environ.get("MEMORY_SYNC_INTERVAL", "300"))
# The consolidation backlog alarm, in pending speech rows. A healthy tick
# leaves far less than this awaiting consolidation, so crossing it means
# consolidating is stalled or draining: #88's deploy plan holds the
# backlog near 4,400 for roughly an hour while consolidation actively
# drains, and the line prints on every tick the whole way — so a silent
# freeze cannot recur.
CONSOLIDATION_BACKLOG_WARN = int(os.environ.get("MEMORY_CONSOLIDATION_BACKLOG_WARN", "500"))
CONSOLIDATION_DEBUG = os.environ.get("MEMORY_CONSOLIDATION_DEBUG", "") == "1"
FLOOR_PATH = os.path.join(DATA_DIR, "memory-floor.md")
# Where the client picks the floor up. Empty unless a deployment sets it, so
# nothing renders into a live rules directory by accident.
FLOOR_RULE_PATH = os.environ.get("MEMORY_FLOOR_RULE_PATH", "")
FLOOR_RULE_FRONTMATTER = """---
description: The user's standing preferences, always in force
alwaysApply: true
---

"""
# Cursor's hooks file, and the hook command its tool-time events run. Empty
# unless a deployment sets them. Those events' matchers are the tools the
# store has rules bound to, which change with the store rather than with a
# release, so their entries are the daemon's to write and the activation
# script leaves them alone.
CURSOR_HOOKS_PATH = os.environ.get("MEMORY_CURSOR_HOOKS_PATH", "")
CURSOR_HOOK_COMMAND = os.environ.get("MEMORY_CURSOR_HOOK_COMMAND", "")
CURSOR_SHELL_EVENT = "beforeShellExecution"
CURSOR_PRE_TOOL_EVENT = "preToolUse"
CURSOR_POST_TOOL_EVENT = "postToolUse"
# Every build installs the hook under a new store path, so an entry is ours
# by the tail of its command; matching the whole path would leave each
# previous build's entry firing beside the current one.
CURSOR_HOOK_SUFFIX = "/clients/cursor/hook"
# Cursor's names for tool calls, measured on 3.29: `Shell`, and `MCP:<tool>`
# with no server key.
CURSOR_SHELL_TOOL = "Shell"
CURSOR_MCP_PREFIX = "MCP:"
# Where a command token can start and end once shlex has had it:
# toolmatch trims these characters from token edges, so a key token can sit
# against any of them and still match.
_CURSOR_TOKEN_EDGE = r"[\s(){};`,!<>$\"'|&]"
# This daemon's own MCP tool names, canonical.
MCP_TOOL_NAMES = frozenset(
    {d["name"] for d in TOOL_DEFINITIONS} | {c.name for c in TOOL_RULE_COMMANDS}
)


def _alternation(names) -> str:
    # Longest first, so no alternative can shadow a longer one it prefixes.
    return "|".join(re.escape(name) for name in sorted(set(names), key=lambda n: (-len(n), n)))


def cursor_tool_matchers(bindings: list[dict]) -> dict[str, str]:
    """Cursor's matcher for each tool-time event, from the enrolled bindings.
    An empty string drops our entry for that event.

    The matchers only decide whether the hook process starts; /tool-moment
    decides what fires, so they may match wider than a binding, never
    narrower.

    - beforeShellExecution: a command naming the first token of any command
      key, as a whole token. A key fires anywhere in the chain, so this is
      not anchored to command position.
    - preToolUse: every tool, built-in or MCP. The deferred session-start
      facts hold the conversation's first call to any tool but this
      daemon's own, so the hook has to see them all; it answers from its
      state file without a daemon round trip once that hold is settled.
    - postToolUse: the calls an informational moment can be parked for.
    """
    command_heads = {b["key"][0] for b in bindings if b["kind"] == "command" and b["key"]}
    mcp_keys = {b["key"][0] for b in bindings if b["kind"] == "mcp" and b["key"]}
    shell = ""
    if command_heads:
        shell = (
            f"(?:^|{_CURSOR_TOKEN_EDGE})(?:{_alternation(command_heads)})(?={_CURSOR_TOKEN_EDGE}|$)"
        )
    pre = ".*"
    post_parts = []
    if command_heads:
        post_parts.append(re.escape(CURSOR_SHELL_TOOL))
    if mcp_keys:
        post_parts.append(f"{re.escape(CURSOR_MCP_PREFIX)}(?:{_alternation(mcp_keys)})")
    post = f"^(?:{'|'.join(post_parts)})$" if post_parts else ""
    return {
        CURSOR_SHELL_EVENT: shell,
        CURSOR_PRE_TOOL_EVENT: pre,
        CURSOR_POST_TOOL_EVENT: post,
    }


TOOL_RECALL_TIMEOUT_SECS = float(os.environ.get("MEMORY_TOOL_RECALL_TIMEOUT", "2"))
SESSION_OPEN_TIMEOUT_SECS = float(os.environ.get("MEMORY_SESSION_OPEN_TIMEOUT", "5"))


# The holds flag (PRD 20261104 req 2): the operator's master cutoff for tool-moment
# gates. Ships ON: a bound tool's first execution per conversation is
# rejected with the bound rule as its error text (reject-once), and later
# executions are informational. MEMORY_TOOL_HOLDS=0 (or off/false) makes
# every moment informational. Flipping it is a deployment change, not a
# runtime switch.
def _holds_enabled(raw: str | None) -> bool:
    return (raw or "").strip().lower() not in ("0", "off", "false")


TOOL_HOLDS = _holds_enabled(os.environ.get("MEMORY_TOOL_HOLDS"))
# The deferred-facts hold's error text. Cursor delivers a refusal's
# user_message as the tool's result, so this is what the agent reads.
SESSION_FACTS_HOLD_TEXT = (
    "Held by the memory store: this conversation's session-start facts have "
    "not been fetched. Call knowledge_read with no arguments first; it returns the "
    "stored facts matched to the opening request. Then retry this call: the "
    "hold fires once per conversation."
)
TOOL_MOMENT_TIMEOUT_SECS = float(os.environ.get("MEMORY_TOOL_MOMENT_TIMEOUT", "2"))
COMPLIANCE_TIMEOUT_SECS = float(os.environ.get("MEMORY_COMPLIANCE_TIMEOUT", "1"))
# The session-start block's fact rows. A render cap, not a quality claim:
# the scorer ranks more candidates than the block shows, and anything
# dropped is one tool call away.
KB_TOPK = int(os.environ.get("MEMORY_KB_TOPK", "5"))

# The compliance ladder (PRD 20261104, PRJ-179). The recall discipline is
# taught in instructions, and instructions do not observe themselves: this
# ladder is the one that speaks up, cheaply and honestly, when a conversation
# goes long without a single agent-initiated pull. It observes only that the
# agent pulled — turn counts and pull events, never the prompt text, which
# the clients do not even send — and never fires on any similarity roll, so
# there is nothing here to calibrate against content.
#
# The tiers are named after the PRD's quiet -> firm -> louder; every tier is
# a code constant, so removing or retuning a useless one is a code change on
# a data review (the compliance_report aggregates exist for exactly that
# review) — never a runtime switch.
LADDER_FIRST_AT = 6  # active turns with zero pulls that fire the first tier
LADDER_EVERY = 6  # further active turns of silence between escalations
# An escalation whose next LADDER_OUTCOME_TURNS of silence pass without a
# pull is closed as expired: the reminder was ignored. With the interval at
# parity, a tier expires exactly when the next one fires.
LADDER_OUTCOME_TURNS = 6

# The reading verbs — exactly PRJ-178's agent-initiated stamp set. A pull
# report names one of these (any read of store content counts as compliance,
# per the PRJ-178 ruling that the no-usage check counts any genuine agent
# touch); the daemon re-validates membership from the canonical name so the
# clients cannot accidentally widen the set.
COMPLIANCE_PULL_TOOLS = frozenset(
    {
        "memory_recall",
        "memory_get",
        "memory_list",
        "memory_find_conversations",
        "memory_find_duplicates",
        "knowledge_read",
        "rule_recall",
    }
)

COMPLIANCE_HEADING = "## Memory nudge"

COMPLIANCE_TIERS = (
    "Memory note, level 1 of {total}: this session has run {turns} active "
    "turns without one recall — nothing has been looked up in stored memory "
    "in all that time. Nothing is wrong either way: recall what is useful "
    "for the current work, ignore this if not.",
    "Memory note, level 2 of {total}: still no recall after even more active "
    "turns. Instructions do not observe themselves, which is why this exists. "
    "Before the next non-trivial step, query the store for what applies — "
    "corrections, conventions, prior attempts — or decide plainly that this "
    "session needs nothing.",
    "Memory note, level 3 of {total} (final): a whole session of active "
    "turns and not one agent-initiated recall. Either the store has nothing "
    "for this work — in which case say so where the record can show it — or "
    "the discipline the instructions teach is being skipped, and this "
    "reminder exists for exactly that.",
)

# Appended to every fired tier. The compliance tail is its own constant:
# same need as the heading, separately owned, so a wording change here never
# re-renders the heading's text.
COMPLIANCE_TAIL = " System reminder, not user input; do not reply to it."


# Tool-moment framing, the PRD's injection requirements: advisory, judge
# relevance, corrections are the agent's own move. The note itself is the
# body; this is the wrapper every delivery carries.
TOOL_MOMENT_SECTION = (
    "## Tool rule\n\n"
    "A rule bound to this tool, delivered at its moment of use. Judge "
    "relevance and act on what applies; this never assigns tasks. Correct "
    "a rule you disagree with by writing the truer rule with "
    "tool_rule_add (a changed note is a new rule), and drop the wrong one "
    "with tool_rule_remove(rule_id=<its tr_ id>)."
)

# Two deliveries, because the clients reach the agent at different moments.
# Cursor can only speak by refusing the call, so its text arrives before the
# command runs and has to end with the command being run rather than
# abandoned: the turn this exists for is the one where credentials have
# expired, and an agent that reads "this needs re-auth" and gives up has
# failed the way recall was meant to prevent. Cursor also appends its own
# line telling the agent not to work around the block, which reads as "give
# up" unless this says otherwise. The other delivery arrives after the tool
# ran, where the command may already have failed.
TOOL_DELIVERIES = ("before", "after")


def matcher_rerender_kinds(by_kind: dict) -> bool:
    """Whether this pull's landed records should re-derive the tool matcher.
    The matchers come from the tool bindings, so the kinds that move them
    are enrolment records (tool_rule, bound on apply) and forgets (which
    retire a binding). A rule enrolled on another machine re-renders this
    one's matchers the way a local enrolment does."""
    return bool(by_kind.get("tool_rule") or by_kind.get("forget"))


def tool_recall_section(tools: list[str], delivery: str) -> str:
    named = ", ".join(f"`{tool}`" for tool in tools)
    if delivery == "before":
        body = (
            f"Nothing is wrong with the command. It was held back once so you would "
            f"read what is already written down about {named}, which you have not "
            f"been shown in this conversation and will not be shown again.\n\n"
            "Read it, then run the command — unchanged if none of it applies, "
            "adjusted if it does, and do the setup it names first if it names any. "
            "Do not treat this as a reason to skip the work or to route around the "
            "tool."
        )
    else:
        body = (
            f"Written down about {named}, shown once per conversation and attached "
            "here because this turn used it. If the command above failed, the answer "
            "is likely below: do what it says and run the command again. This is not "
            "a reason to skip the work, declare it blocked, or route around the tool."
        )
    # The tool-moment delivery reads the deliberate pool (agent_memory), not
    # the episodic tier, so the episodic half of the correction instruction
    # cannot apply here.
    return (
        f"## Recalled memory\n\n{body} Where live evidence contradicts a memory, fix "
        "it in the same turn with memory_update, or memory_forget if it should not "
        "exist at all."
    )


class RecordEmittingTools(Tools):
    """Tools that also enqueue the sync record for every mutation — the
    single-writer path: nothing else in this process writes the store."""

    def __init__(
        self,
        store: Store,
        machine_id: str,
        sync: SyncClient,
        floor_path: str = "",
        floor_rule_path: str | None = None,
        cursor_hooks_path: str | None = None,
        cursor_hook_command: str = "",
    ):
        super().__init__(store, machine_id)
        self.sync = sync
        # Per-instance so a caller holding a store somewhere else renders
        # beside it. The module default is a deployed machine's real data
        # directory, and a test store rendering into that overwrites the
        # floor the session running the test is working from.
        self.floor_path = floor_path or FLOOR_PATH
        self.floor_rule_path = FLOOR_RULE_PATH if floor_rule_path is None else floor_rule_path
        self.cursor_hooks_path = (
            CURSOR_HOOKS_PATH if cursor_hooks_path is None else cursor_hooks_path
        )
        self.cursor_hook_command = cursor_hook_command or CURSOR_HOOK_COMMAND
        # Unknown rather than empty, so the first render writes whatever is
        # in the file out of the way. A process that assumed the file agreed
        # with it would leave a matcher from a previous store in place for
        # the life of the daemon.
        self.tool_matcher = None

    def _record_payload(self, table: str, row_id: str) -> dict | None:
        columns = {
            "working_memory": (
                "id, content, source, timestamp, session_id, importance, "
                "metadata_json, veracity, author_id, author_type, kind, "
                "repo, origin, app"
            ),
            "episodic_memory": (
                "id, content, source, timestamp, session_id, importance, "
                "metadata_json, veracity, repo, origin, app, summary_of"
            ),
        }.get(table)
        if table == "agent_memory":
            # The deliberate home carries its session as the resolution
            # (the registry triple), never a session id — each machine
            # resolves the same conversation to its own registry row.
            return self.store.agent_record_payload(row_id)
        if columns is None:
            return None
        row = self.store.conn.execute(
            f"SELECT {columns} FROM {table} WHERE id = ?", (row_id,)
        ).fetchone()
        if row is None:
            return None
        payload = dict(row)
        payload["metadata"] = json.loads(payload.pop("metadata_json", None) or "{}")
        return payload

    def _emit(self, kind: str, payload: dict, record_id: str | None = None) -> bool:
        """Returns True when the enqueue path was satisfied: the record is
        on the outbound queue when a hub is configured; with no hub the
        enqueue short-circuits (nothing to converge with), True is still
        the return, and there is nothing to heal. False = an enqueue
        failure swallowed the record — callers that must not lose a
        record check the return; everyone else keeps the convention that
        a queue failure never fails a write, and the print states it.
        RecordContractError still raises."""
        try:
            self.sync.enqueue(kind, payload, record_id=record_id)
        except RecordContractError:
            # The one enqueue failure that is not the transport's fault.
            # A record this host cannot legally send means the input that
            # built it was wrong, and the caller is an agent mid-turn who
            # can fix it or raise it. The local write has already landed,
            # which is the right way round: the store keeps what the agent
            # asked for and the agent learns the record did not ship.
            raise
        except Exception as error:  # a hub that is down must never fail the write
            print(f"record enqueue deferred: {error!r}", flush=True)
            return False
        return True

    def memory_remember(self, **kwargs) -> dict:
        result = super().memory_remember(**kwargs)
        payload = self._record_payload("agent_memory", result["id"])
        if payload:
            self._emit("agent_memory", payload)
        self._render_tool_matcher()
        return result

    def memory_update(self, id: str = "", **kwargs) -> dict:
        kwargs["id"] = id
        result = super().memory_update(**kwargs)
        # The route resolves after the write, from row presence — the one
        # source of truth, shared with the tools layer: the edit rides the
        # agent_memory kind when the agent row exists, the memory kind for a
        # straggler edit. The tools layer resolves its own route pre-write;
        # this resolves post-write from row presence — a twin a concurrent
        # apply creates between the two checks self-corrects at the next
        # boot's drain fold.
        routed = "agent_memory" if self.store.agent_row(id) else "working_memory"
        payload = self._record_payload(routed, result["id"])
        if payload:
            self._emit("agent_memory" if routed == "agent_memory" else "memory", payload)
        self._render_tool_matcher()
        return result

    def memory_forget(self, table: str = "", id: str = "", **_) -> dict:
        # Deliberate ids (m-prefixed by the write path) tombstone BOTH homes
        # unconditionally: tombstones are idempotent where a home never held
        # the row, and a twin a concurrent apply creates before or during
        # this forget is refused at the apply-time guard instead of
        # surviving it. Capture ids never have a twin (the prefixes are the
        # write paths' contract), so they forget their one table and never
        # litter agent tombstones.
        homes = (
            ("agent_memory", "working_memory")
            if table in ("working_memory", "agent_memory") and str(id).startswith("m")
            else (table,)
        )
        result = super().memory_forget(table=table, id=id, homes=homes)
        for home in homes:
            self._emit("forget", {"table": home, "id": id})
        self._render_tool_matcher()
        return result

    def rule_forget(self, **kwargs) -> dict:
        result = super().rule_forget(**kwargs)
        self._emit("forget", {"table": "situational_rules", "id": str(result["rule_id"])})
        return result

    def rule_codify(self, **kwargs) -> dict:
        result = super().rule_codify(**kwargs)
        # Reconcile returns without a rule_id: the write was refused, so
        # there is no new row to journal and the caller rediscovers the
        # standing rule it names.
        if result.get("status") == "reconcile":
            return result
        row = self.store.conn.execute(
            "SELECT id, situation, statement, rationale, grader, stance, "
            "scope, status, provenance, origin_machine FROM situational_rules "
            "WHERE id = ?",
            (result["rule_id"],),
        ).fetchone()
        if row:
            payload = dict(row)
            payload["target"] = "situational"
            self._emit("rule", payload)
        return result

    def rule_feedback(
        self,
        rule_id: int = 0,
        signal: str = "",
        delta: float = 1.0,
        polarity: str = "",
        grounds: str | None = None,
        **kwargs,
    ) -> dict:
        # The record_id is generated HERE, once, and used for both the
        # local apply and the wire record: the hub relays this record back,
        # and feedback applies accumulatively — sharing the id is what
        # makes the relay-back replay a store-level no-op instead of a
        # second counter bump on the origin machine.
        record_id = f"{self.machine_id}-{time.time_ns():x}"
        # `id` is the agent-facing alias for rule_id (ADR 20260921) — the
        # injection and rule_list render it as `id`, so forward it through
        # rather than letting it drop in kwargs. Coerced here so the emitted
        # wire payload carries the integer, not a copied string.
        try:
            rule_id = int(rule_id or kwargs.pop("id", 0) or 0)
        except (TypeError, ValueError):
            from memory_store.tools import ToolError

            raise ToolError("rule_id and signal (confirm|disconfirm|soft) required") from None
        # The result carries the canonical wire signal AND the effective
        # delta (0.25 for soft): the wire must not ship the agent-facing
        # shorthand (the vocabulary drift) or the pre-weight delta (which
        # made receiving machines weight soft gradings at full strength).
        result = super().rule_feedback(
            rule_id=rule_id,
            signal=signal,
            delta=delta,
            polarity=polarity,
            grounds=grounds,
            record_id=record_id,
        )
        self._emit(
            "feedback",
            {
                "rule_id": rule_id,
                "rule_kind": result.get("rule_kind", "situational"),
                "signal": result.get("signal", signal),
                "delta": result.get("delta", delta),
                "grounds": grounds,
                "origin_machine": self.machine_id,
            },
            record_id=record_id,
        )
        return result

    def persona_codify(self, **kwargs) -> dict:
        result = super().persona_codify(**kwargs)
        if result.get("status") == "refused":
            return result
        self._render_floor()
        row = self.store.conn.execute(
            "SELECT id, statement, status, topic, origin_machine, "
            "provenance FROM persona_rules WHERE id = ?",
            (result["id"],),
        ).fetchone()
        if row:
            payload = dict(row)
            payload["target"] = "persona"
            self._emit("rule", payload)
        return result

    def persona_update(self, **kwargs) -> dict:
        result = super().persona_update(**kwargs)
        self._render_floor()
        row = self.store.conn.execute(
            "SELECT id, statement, status, topic, origin_machine, "
            "provenance FROM persona_rules WHERE id = ?",
            (result.get("id") or kwargs.get("rule_id"),),
        ).fetchone()
        if row:
            payload = dict(row)
            payload["target"] = "persona"
            self._emit("rule", payload)
        return result

    def _render_floor(self) -> None:
        try:
            floor = render_floor(self.store)
        except Exception as error:
            print(f"floor render deferred: {error!r}", flush=True)
            return
        try:
            with open(self.floor_path, "w", encoding="utf-8") as floor_file:
                floor_file.write(floor)
        except Exception as error:
            print(f"floor render deferred: {error!r}", flush=True)
        if self.floor_rule_path:
            self._write_floor_rule(floor)

    def _write_floor_rule(self, floor: str) -> None:
        """The floor as a rule file, which is how it reaches a session at all
        — nothing injects it. An empty corpus takes the file away instead of
        leaving frontmatter with nothing under it, which every request would
        pay for and no request would learn from."""
        try:
            if not floor.strip():
                if os.path.exists(self.floor_rule_path):
                    os.remove(self.floor_rule_path)
                return
            parent = os.path.dirname(self.floor_rule_path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(self.floor_rule_path, "w", encoding="utf-8") as rule_file:
                rule_file.write(FLOOR_RULE_FRONTMATTER + floor)
        except Exception as error:
            print(f"floor rule write deferred: {error!r}", flush=True)

    def _render_tool_matcher(self) -> None:
        """Keep Cursor's tool-time matchers in step with the tools the store
        has rules bound to. Enrolling a tool is a write, so the enrolment
        has to reach hooks.json on the write and not at the next deploy.
        """
        if not self.cursor_hooks_path or not self.cursor_hook_command:
            return
        try:
            matchers = cursor_tool_matchers(self.store.tool_bindings())
        except Exception as error:
            print(f"tool matcher render deferred: {error!r}", flush=True)
            return
        if matchers == self.tool_matcher:
            return
        try:
            self._write_cursor_tool_hooks(matchers)
        except Exception as error:
            print(f"tool matcher write deferred: {error!r}", flush=True)
            return
        self.tool_matcher = matchers

    def _is_our_hook(self, entry) -> bool:
        if not isinstance(entry, dict):
            return False
        command = str(entry.get("command", ""))
        return command == self.cursor_hook_command or command.endswith(CURSOR_HOOK_SUFFIX)

    def _write_cursor_tool_hooks(self, matchers: dict[str, str]) -> None:
        """Our entries in a file Cursor shares with every other tool the user
        installs, so this reads what is there, replaces only its own entries,
        and renames the result into place — Cursor rereads the file live and
        must never catch it half-written."""
        if not any(matchers.values()) and not os.path.exists(self.cursor_hooks_path):
            return  # nothing to say and nothing to clean up
        try:
            with open(self.cursor_hooks_path, encoding="utf-8") as handle:
                config = json.load(handle)
        except Exception:
            config = {}
        if not isinstance(config, dict):
            config = {}
        config["version"] = 1
        hooks = config.get("hooks")
        hooks = hooks if isinstance(hooks, dict) else {}
        config["hooks"] = hooks
        for event, matcher in matchers.items():
            entries = hooks.get(event)
            entries = entries if isinstance(entries, list) else []
            entries = [entry for entry in entries if not self._is_our_hook(entry)]
            # No tools means no matcher, and a Cursor entry without one fires
            # on every call. Drop ours instead of registering the widest
            # possible hook.
            if matcher:
                entries.append({"command": self.cursor_hook_command, "matcher": matcher})
            if entries:
                hooks[event] = entries
            else:
                hooks.pop(event, None)
        parent = os.path.dirname(self.cursor_hooks_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        temporary = f"{self.cursor_hooks_path}.{os.getpid()}.tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(config, handle, indent=2)
            handle.write("\n")
        os.replace(temporary, self.cursor_hooks_path)


def drain_captures(
    store: Store,
    sync: SyncClient,
    queue_dir: str = QUEUE_DIR,
    machine_id: str = "local",
    consolidator=None,
) -> dict:
    """Classify queued raw turns, upsert speech, enqueue capture records.
    The queue file is the plugin's append-only JSONL; rename-then-process
    so concurrent appends continue into a fresh file. On failure the
    unprocessed tail (the line in flight included) goes back on the queue:
    a retried line re-upserts under a fresh id, so the worst case is a
    duplicate capture row — and its duplicate session_history mirror — the
    old behavior unlinked the processing file on any exception and silently
    dropped the undrained tail."""
    pattern = os.path.join(queue_dir, "capture.jsonl")
    if not os.path.exists(pattern):
        return {"drained": 0}
    processing = f"{pattern}.{time.time_ns()}.processing"
    os.rename(pattern, processing)
    drained = 0
    compactions: list[str] = []
    queue_file = open(processing, encoding="utf-8")
    try:
        pending = ""
        for line in queue_file:
            pending = line
            line = line.strip()
            if not line:
                continue
            try:
                turn = json.loads(line)
            except json.JSONDecodeError:
                continue
            content = (turn.get("text") or "").strip()
            if turn.get("kind") == "compaction":
                # Resolved after the loop: the marker may precede its
                # conversation's turn lines in this same batch, and the
                # force decision counts rows, which must see them.
                if turn.get("conversation_id"):
                    compactions.append(turn["conversation_id"])
                else:
                    print(
                        "compaction dropped: queued record names no conversation_id",
                        flush=True,
                    )
                continue  # boundary marker, not a turn
            if turn.get("kind") == "session":
                # Registration line: provenance only, no turn text. Children
                # never capture, so the registry learns them here alone; the
                # parent row is registered too if the child arrived first.
                conversation_id = (turn.get("conversation_id") or "").strip()
                app = (turn.get("app") or "").strip()
                if app and conversation_id:
                    parent = (turn.get("parent_conversation_id") or "").strip() or None
                    project = resolve_workspace(turn.get("cwd"))
                    initiator = (turn.get("initiator") or "").strip().lower()
                    store.get_or_create_session(
                        machine=machine_id,
                        tool=app,
                        client_conversation_id=conversation_id,
                        project=project,
                        parent_conversation_id=parent,
                        initiator=initiator,
                    )
                    try:
                        sync.enqueue(
                            "session",
                            {
                                "machine": machine_id,
                                "tool": app,
                                "conversation_id": conversation_id,
                                "parent_conversation_id": parent,
                                "project": project,
                                "initiator": initiator,
                            },
                        )
                    except Exception as error:
                        print(f"session record deferred: {error!r}", flush=True)
                    drained += 1
                continue
            if not content:
                continue
            if is_title_gen_template(content):
                continue
            repo = resolve_workspace(turn.get("cwd"))
            conversation_id = turn.get("conversation_id") or "unknown"
            # Naming the client is the queueing client's job. Storing one
            # under a guess is worse than losing it: the row looks authored
            # by whichever client the guess named. Skip rather than raise,
            # so one malformed record cannot wedge the drain.
            app = (turn.get("app") or "").strip()
            if not app:
                print("capture dropped: queued record names no app", flush=True)
                continue
            kind = classify_capture(content)
            # Lineage (PRD 20261114): resolve the session before the mirror
            # so the class reads the stored initiator, and a user turn in a
            # driven or unanchored conversation is stamped as the agent
            # voice it is — the "user" role there is the driving agent or
            # the webhook, never the human. A turn that registers a fresh
            # session also ships the registration to peers: only the
            # kind:"session" lines used to carry it, and a conversation
            # whose first event is a turn never sent one.
            initiator = (turn.get("initiator") or "").strip().lower()
            was_registered = store.session_exists(machine_id, app, conversation_id)
            store.get_or_create_session(
                machine=machine_id,
                tool=app,
                client_conversation_id=conversation_id,
                project=repo,
                initiator=initiator,
            )
            if not was_registered:
                try:
                    sync.enqueue(
                        "session",
                        {
                            "machine": machine_id,
                            "tool": app,
                            "conversation_id": conversation_id,
                            "project": repo,
                            "initiator": initiator,
                        },
                    )
                except Exception as error:
                    print(f"session record deferred: {error!r}", flush=True)
            conversation_class = store.conversation_class(machine_id, app, conversation_id)
            if turn.get("role") == "user":
                author_type = "agent" if conversation_class in ("driven", "unanchored") else "human"
            else:
                author_type = "assistant"
            row_id = f"c{time.time_ns():x}"
            row = {
                "id": row_id,
                "content": content,
                # source is the label slot; captures carry no label
                # (kind says speech/exhibit/fork). Provenance is
                # columns: origin/repo/app.
                "source": "",
                "timestamp": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ",
                    time.gmtime(turn.get("ts") or time.time()),
                ),
                "session_id": conversation_id,
                "kind": kind,
                "repo": repo,
                "origin": "capture",
                "app": app,
                "captured_by": machine_id,
                "initiator": initiator,
                "author_type": author_type,
            }
            store.upsert_capture(row)
            # Mirror into the registry before the sync enqueue: a failure
            # here restores the whole line (and its retry) like any other
            # mid-line failure, rather than syncing a turn whose mirror
            # never landed.
            store.record_capture_turn(row)
            try:
                sync.enqueue("capture", row)
            except Exception as error:
                print(f"capture record deferred: {error!r}", flush=True)
            drained += 1
        queue_file.close()
        os.unlink(processing)
    except BaseException:
        try:
            remainder = queue_file.read()
        finally:
            queue_file.close()
        tail = (pending + remainder) if pending else remainder
        if tail.strip():
            try:
                with open(pattern, "a", encoding="utf-8") as restore:
                    restore.write(tail if tail.endswith("\n") else tail + "\n")
            except OSError as error:
                print(f"capture drain: restore deferred: {error!r}", flush=True)
        try:
            os.unlink(processing)
        except OSError:
            pass
        raise
    # A compaction boundary forces only when the conversation still has
    # unconsolidated speech to summarize — a fully-consolidated
    # conversation's compaction writes no flag, so flags cannot
    # accumulate on sessions that can never group again.
    #
    # Resolving here, after the except block: the queue file is closed
    # and unlinked by now, so a failure inside the resolution must not
    # fall into the requeue path — that path requeues mid-file state and
    # would mask the resolution's own error behind a phantom drain
    # failure (review 267, count 1).
    if consolidator:
        for conversation_id in dict.fromkeys(compactions):
            if pending_backlog(store, conversation_id) > 0:
                consolidator.force(conversation_id)
    return {"drained": drained}


def consolidation_tick(store: Store, consolidator) -> dict[str, int]:
    """One consolidation tick plus its log policy: the tick result at the
    usual line, and a per-tick warning while the pending backlog exceeds
    the alarm threshold. An all-zero tick prints nothing by default
    (ruling 2026-11-18); MEMORY_CONSOLIDATION_DEBUG=1 opts the idle line
    back in for temporary analysis."""
    result = consolidator.tick()
    backlog = pending_backlog(store)
    if backlog > CONSOLIDATION_BACKLOG_WARN:
        print(
            f"CONSOLIDATION BACKLOG: {backlog} unconsolidated speech rows pending",
            flush=True,
        )
    if result["groups"] or result["skipped"]:
        print(f"client consolidation: {result}", flush=True)
    elif CONSOLIDATION_DEBUG:
        # Opt-in debug channel: silent by default (ruling 2026-11-18).
        print(f"client consolidation: idle {result}", flush=True)
    return result


class MCPEndpoint:
    """The MCP session manager as a routable ASGI app.

    A class instance is what makes Starlette route this raw rather than
    wrap it as a request/response handler, and routing rather than
    mounting is the point: a Mount answers a bare POST /mcp with a 307 to
    /mcp/, and an MCP client is under no obligation to follow a redirect
    on a POST."""

    def __init__(self, sessions: StreamableHTTPSessionManager):
        self.sessions = sessions

    async def __call__(self, scope, receive, send):
        await self.sessions.handle_request(scope, receive, send)


# Tools the daemon's plugin layer may stamp a session link into (the same
# set as TOOLS_WITH_APP on the legacy surface): the layer that knows the
# session injects conversation_id, and anything else strips it. The gate
# resolves every command's conversation before validation; only these
# authoring verbs' models carry the field (PRD
# 20261114-lineage-gated-writes).
MCP_COMMANDS_WITH_SESSION = frozenset({"tool_rule_add", "tool_rule_promote", "tool_rule_copy"})


class DaemonState:
    """Everything the HTTP handlers and timers share, behind one lock."""

    def __init__(self, store: Store, tools: RecordEmittingTools, sync: SyncClient):
        self.store = store
        self.tools = tools
        self.sync = sync
        # The mcp_commands context: same store and emitter as the legacy
        # surface, composed once here (the composition root).
        self.command_context = ToolContext(
            store=store,
            machine_id=tools.machine_id,
            emit=tools._emit,
            on_write=tools._render_tool_matcher,
        )
        # The disambiguation set for undecorated-vs-decorated wire names
        # (memory_ tools under a memory_ decoration).
        self.mcp_tool_names = MCP_TOOL_NAMES
        self.lock = threading.RLock()
        # Scorer gate: one scored request runs at a time; excess requests get
        # an immediate 503 instead of piling up as abandoned work the client
        # already gave up on (the pile-up amplifier in the 2026-09-18 wedge
        # outages).
        self.nudge_gate = threading.BoundedSemaphore(value=1)

    def tool_recall(self, body: dict[str, Any]) -> dict:
        """What the store has to say about the tools a command is about to
        run, for the ones this conversation has not been told about yet.

        Keyed on the tool rather than on similarity: the caller is a hook
        holding a command line, not a prompt, and `gcloud logging read`
        bears no resemblance to the sentence describing what to do when its
        credentials have expired.
        """
        command = (body.get("command") or "").strip()
        if not command:
            raise ToolError("command is required")
        # No default: the two deliveries say opposite things about whether the
        # command has run, and guessing wrong tells the agent to re-run a
        # command that was never allowed to start.
        delivery = (body.get("delivery") or "").strip()
        if delivery not in TOOL_DELIVERIES:
            raise ToolError(
                "delivery is required: 'before' if the command is held back "
                "pending this, 'after' if it has already run"
            )
        seen = {str(tool) for tool in (body.get("seen_tools") or [])}
        with spans.span("tool.recall", command_chars=len(command), seen=len(seen)) as node:
            tools = toolrecall.derive_tools(self.store)
            named = toolrecall.tools_in_command(command, tools)
            fresh = [tool for tool in named if tool not in seen]
            node.set(named=len(named), fresh=len(fresh))
            if not fresh:
                return {"status": "ok", "tools": [], "memories": []}
            memories = toolrecall.recall_for_tools(self.store, fresh, command)
            node.set(
                returned=len(memories)
            )  # The tools go back whether or not they had anything to say, so
            # a tool the store knows but has nothing ranked for is asked
            # about once rather than on every command.
            return {
                "status": "ok",
                "tools": fresh,
                "memories": memories,
                "section": tool_recall_section(fresh, delivery),
            }

    def tool_moment(self, body: dict[str, Any]) -> dict:
        """Tool-moment delivery (PRJ-170): what the enrolled tool_rules say
        at the moment a bound tool fires. Deterministic — the matcher is a
        token comparison, not a similarity roll — so this neither takes
        the scorer's gate nor needs one; the cheapest route on the daemon.

        A command event is tokenized and matched on contiguous
        subsequence; an MCP event matches its canonical (undecorated)
        name exactly. Project-scoped bindings fire only in their project;
        global ones fire everywhere. With the holds flag on, a matched
        tool's first execution in the conversation is held — the caller
        rejects the call with the rendered rule as the error text — and
        every later execution is informational. A fire is recorded in
        both modes, so flipping the flag on never re-rejects a
        conversation that already ran the tool."""
        event = body.get("event") or {}
        kind = event.get("kind")
        conversation_id = str(body.get("conversation_id") or "").strip()
        if kind not in ("command", "mcp", "tool") or not conversation_id:
            raise ToolError("event.kind (command|mcp|tool) and conversation_id are required")
        app = str(body.get("app") or "").strip()
        with spans.span("tool.moment", kind=kind, app=app) as node:
            if kind == "command":
                command = str(event.get("command") or "")
                if not command.strip():
                    raise ToolError("event.command is required for a command event")
                node.set(command_chars=len(command))
            else:
                decorated = str(event.get("tool") or "").strip()
                if not decorated:
                    raise ToolError(f"event.tool is required for a {kind} event")
                command = (
                    toolmatch.canonical_mcp_name(app, decorated, known=self.mcp_tool_names)
                    if kind == "mcp"
                    else decorated
                )
                node.set(tool=command)
            # The deferred-facts hold answers before any binding, and is not
            # the holds flag's to switch off: it exists to make the fetch
            # happen. This store's own tools pass; reading memory is what the
            # hold is asking for. A refused call records no binding fire, so
            # a rule bound to the same tool still holds on the retry.
            exempt = kind == "mcp" and command in self.mcp_tool_names
            if not exempt and self.store.session_facts_take_hold(conversation_id):
                node.set(held=True, gate="session_facts")
                return {
                    "status": "ok",
                    "held": True,
                    "error": SESSION_FACTS_HOLD_TEXT,
                    "deliveries": [],
                    "facts_gate": "held",
                }
            if kind == "tool":
                return {"status": "ok", "deliveries": [], "held": False, "facts_gate": "clear"}
            project = body.get("workspace") or resolve_workspace(body.get("cwd"))
            deliveries: list[dict] = []
            held_any = False
            # The seen-check and fire-record are one decision: under the
            # daemon lock so two concurrent moments for the same
            # (tool, conversation) cannot both observe unseen and both
            # report a hold. The loop is cheap — token matching over the
            # enrolled bindings, no scorer underneath.
            with self.lock:
                for binding in self.store.tool_bindings():
                    if not self._binding_covers(binding, kind, command):
                        continue
                    if binding["scope"] == "project" and binding["project"] != project:
                        continue
                    seen = self.store.tool_fires_seen(binding["tool_id"], conversation_id)
                    held = TOOL_HOLDS and not seen
                    self.store.record_tool_fire(
                        binding["tool_id"], conversation_id, app=app, held=held
                    )
                    held_any = held_any or held
                    deliveries.append(self._render_binding(binding, held))
            node.set(matched=len(deliveries), held=held_any)
            if not deliveries:
                return {"status": "ok", "deliveries": [], "held": False}
            return {
                "status": "ok",
                "held": held_any,
                # Held fires reject with one error text; informational ones
                # deliver as their own block beside the tool's result.
                "error": self._hold_text(deliveries) if held_any else "",
                "deliveries": deliveries,
            }

    def compliance(self, body: dict[str, Any]) -> dict:
        """The compliance ladder's one route (PRD 20261104, PRJ-179). The
        clients report two event kinds and nothing else: `turn` — an active
        (non-trivial) prompt arrived, filtered client-side — and `pull` —
        the agent executed one of the reading verbs. The daemon owns every
        decision: turn arithmetic, tier timing, the pull reset, the journal.
        The clients stay dumb because they restart constantly, and a client
        that forgot a conversation's earlier pulls would falsely remind a
        session that already recalled.

        The route never sees or stores prompt text; the only content
        matching anywhere in it is the exact membership check that a pull
        names one of the reading verbs."""
        event_type = str(body.get("type") or "").strip()
        conversation_id = str(body.get("conversation_id") or "").strip()
        if event_type not in ("turn", "pull") or not conversation_id:
            raise ToolError("type (turn|pull) and conversation_id are required")
        app = str(body.get("app") or "").strip()
        machine = self.tools.machine_id
        with spans.span("compliance", kind=event_type, app=app) as node:
            with self.lock:
                if event_type == "pull":
                    canonical = toolmatch.canonical_mcp_name(
                        app, str(body.get("tool") or ""), known=self.mcp_tool_names
                    )
                    if canonical not in COMPLIANCE_PULL_TOOLS:
                        # Not one of the reading verbs: nothing the ladder
                        # recognizes, which is not an error — hooks report
                        # whole tool surfaces and the daemon narrows.
                        node.set(tool=canonical or "-", recognized=0)
                        return {"status": "ok", "reminder": "", "section": ""}
                    # Read the state before the reset: turns_after needs the
                    # active count as it stood when the pull arrived.
                    state = self.store.compliance_state_for(conversation_id)
                    resolved = []
                    if state and state["active_turns"]:
                        resolved = self.store.compliance_resolve_open(
                            conversation_id,
                            state["active_turns"],
                            time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        )
                    self.store.compliance_mark_pull(conversation_id, app, machine)
                    node.set(
                        recognized=1,
                        resolved=len(resolved),
                        level=int(state["level"]) if state else 0,
                    )
                    return {
                        "status": "ok",
                        "reminder": "",
                        "section": "",
                        "resolved": [event["id"] for event in resolved],
                    }

                state = self.store.compliance_bump_turn(conversation_id, app, machine)
                active = int(state["active_turns"])
                expired = self.store.compliance_expire_open(
                    conversation_id, active, LADDER_OUTCOME_TURNS
                )
                # Which tier the turn count has reached, and whether the
                # next unfired one is due. Tiers fire in sequence at their
                # absolute thresholds since the last pull; the count never
                # resets on a fire (only a pull does), so a tier expires
                # exactly when its successor fires.
                reached = -1
                if active >= LADDER_FIRST_AT:
                    reached = (active - LADDER_FIRST_AT) // LADDER_EVERY
                fired = None
                reminder = ""
                level = int(state["level"])
                if reached >= level and level < len(COMPLIANCE_TIERS):
                    tier = level
                    level = tier + 1
                    event = self.store.compliance_open_event(
                        conversation_id, app, machine, level, active
                    )
                    reminder = (
                        COMPLIANCE_TIERS[tier].format(turns=active, total=len(COMPLIANCE_TIERS))
                        + COMPLIANCE_TAIL
                    )
                    fired = event
                    node.set(fire=fired["id"], level=level, turns=active)
                node.set(turns=active, expired=len(expired), level=level)
                return {
                    "status": "ok",
                    "active_turns": active,
                    "level": level,
                    "reminder": reminder,
                    "section": f"{COMPLIANCE_HEADING}\n\n{reminder}" if reminder else "",
                }

    @staticmethod
    def _binding_covers(binding: dict, kind: str, name_or_command: str) -> bool:
        if binding["kind"] != kind:
            return False
        if kind == "mcp":
            return toolmatch.mcp_matches(name_or_command, binding["key"])
        return toolmatch.command_matches(name_or_command, binding["key"])

    @staticmethod
    def _render_binding(binding: dict, held: bool) -> dict:
        """One fired binding, framed per the PRD's injection requirements:
        provenance stamp, advisory framing, the correction pointer."""
        return {
            "rule_id": binding["rule_id"],
            "tool_id": binding["tool_id"],
            "key": binding["key"],
            "scope": binding["scope"],
            "project": binding["project"],
            "note": binding["note"] or "",
            "held": held,
            "created_at": binding["created_at"],
            "section": TOOL_MOMENT_SECTION,
        }

    @staticmethod
    def _hold_text(deliveries: list[dict]) -> str:
        """The rejection error: every fired rule's note, one block. The
        agent reads why the call was refused and decides — run again (the
        hold is once per conversation) or change course."""
        notes = "\n".join(f"- {d['note']} (rule {d['rule_id']})" for d in deliveries)
        return (
            "Held by a stored tool rule (first execution of this tool in "
            f"this conversation):\n{notes}\n"
            "Re-running the tool will proceed; this hold fires once per "
            "conversation. Judge the rule and act accordingly — this never "
            "assigns tasks. A rule that is wrong goes with "
            "tool_rule_remove(rule_id=<its id>)."
        )

    def session_open(self, body: dict[str, Any]) -> dict:
        """The session-start KB delivery (PRJ-176): the project's standing
        doc plus the opening request's top-k deliberate facts. No LLM call
        and no daemon-side once-per-session state — the plugin owns the
        gate, so a daemon restart cannot re-inject mid-session.

        Silence is the honest answer for a repo with no KB, an unknown
        repo, or an empty request: `{doc: None}`, which the plugin renders
        as nothing."""
        prompt = (body.get("prompt") or "").strip()
        # Lineage registration rides the first prompt (PRD
        # 20261114-lineage-gated-writes): the client layer names the
        # initiator, and resolving the session here — synchronously, before
        # any tool call the opening turn makes — closes the window where a
        # fresh session's writes would gate on a registry row that has not
        # drained yet. Registration happens before the KB early-returns: a
        # repo with no standing doc still gets its session on the books.
        conversation_id = str(body.get("conversation_id") or "").strip()
        app = (body.get("app") or "").strip()
        initiator = (body.get("initiator") or "").strip().lower()
        if app and conversation_id and initiator in ("human", "agent"):
            self.store.get_or_create_session(
                self.tools.machine_id,
                app,
                conversation_id,
                project=resolve_workspace(body.get("cwd")),
                initiator=initiator,
            )
        # Workspace is the server's job (one detect_project
        # implementation); a client-supplied value is only an override.
        repo = body.get("workspace") or resolve_workspace(body.get("cwd"))
        if not prompt or not repo:
            return {"status": "ok", "doc": None}
        with spans.span("session.open", prompt_chars=len(prompt)) as node:
            current = self.store.kb_current(repo)
            if not current:
                node.set(doc=False)
                return {"status": "ok", "doc": None}
            row = current[0]
            # kb_current hands back the audit journal already parsed.
            folded = set(row["inputs"] or [])
            node.set(doc=True, folded=len(folded))
            ranked = self._session_open_topk(repo, prompt, folded)[:KB_TOPK]
            out = {
                "status": "ok",
                # The ADR's name for this concept; the repo-named internals
                # underneath are PRJ-192's to rename.
                "project": row["project"],
                "doc": row["doc"],
                "doc_created_at": row["created_at"],
                # Count of the doc's folded input ids — the build's journal,
                # not a claim that all N still stand (a forget can retire one).
                "inputs_count": len(folded),
            }
            # A client that cannot inline the facts (Cursor) asks for them
            # to be held for a knowledge_read fetch instead, under its
            # conversation id; the first-tool hold rides the same row.
            conversation_id = str(body.get("conversation_id") or "").strip()
            if body.get("defer_facts") and conversation_id:
                if ranked:
                    self.store.session_facts_defer(
                        conversation_id,
                        str(body.get("app") or ""),
                        row["project"],
                        [fact["id"] for fact in ranked],
                    )
                node.set(deferred=len(ranked))
                out["facts_pending"] = len(ranked)
            else:
                out["topk"] = ranked
            return out

    def _session_open_topk(self, repo: str, prompt: str, excluded: set) -> list[dict]:
        """Deliberate facts matching the opening request, ranked from the
        project's own pool. The nudge scorer is the ranking, scoped here to
        the repo (a busier sibling repo must not crowd the project out of
        its own block), with the caller's exclusions and the episodic tier
        suppressed inside the scorer — the render cap applies to eligible
        rows only, never to slots the caller would drop. The no-model
        fallback ranks the same pool."""
        try:
            scored = nudge_score(
                self.store,
                prompt,
                workspace=repo,
                limit=KB_TOPK,
                scope_to_workspace=True,
                exclude_ids=excluded,
                include_episodic=False,
            )
        except RuntimeError:
            return self._session_open_lexical(repo, prompt, excluded)
        return [
            {
                key: row[key]
                for key in (
                    "id",
                    "content",
                    "timestamp",
                    "created_at",
                    "veracity",
                    "author_type",
                    "score",
                )
            }
            for row in scored
        ]

    def _session_open_lexical(self, repo: str, prompt: str, excluded: set[str]) -> list[dict]:
        """The no-model ranking: FTS candidates over the same pool the
        scorer ranks — the deliberate home plus translated rows still in
        their working-memory home — filtered to the repo and the caller's
        exclusions, ordered by lexical relevance with the FTS rank as the
        tie-break. Threshold-free: with no model there is no similarity
        to threshold on, and relevance above zero is the honest bar."""
        rows_by_id: dict[str, dict] = {}
        for search, home in (
            (fts_search_agent, "agent"),
            (fts_search_working, "working"),
        ):
            hits = search(self.store.conn, prompt, k=KB_TOPK * 4)
            if not hits:
                continue
            ids = [hit["id"] for hit in hits]
            ranks = {hit["id"]: hit["rank"] for hit in hits}
            placeholders = ",".join("?" * len(ids))
            if home == "agent":
                rows = self.store.conn.execute(
                    f"""SELECT a.id, a.content, a.timestamp, a.created_at,
                               a.veracity, a.author_type
                          FROM agent_memory a
                         WHERE a.repo = ? AND a.id IN ({placeholders})""",
                    (repo, *ids),
                ).fetchall()
            else:
                rows = self.store.conn.execute(
                    f"""SELECT a.id, a.content, a.timestamp, a.created_at,
                               a.veracity, a.author_type
                          FROM working_memory a
                         WHERE a.repo = ? AND a.id IN ({placeholders})
                           AND a.origin = 'deliberate'
                           AND a.id NOT IN (SELECT id FROM agent_memory)""",
                    (repo, *ids),
                ).fetchall()
            for row in rows:
                rows_by_id[row["id"]] = {**dict(row), "rank": ranks[row["id"]]}
        tokens = recall_tokens(prompt)
        query_lower = prompt.lower()
        ranked = []
        for row in rows_by_id.values():
            if row["id"] in excluded:
                continue
            relevance = lexical_relevance(tokens, row["content"], query_lower)
            if relevance <= 0:
                continue
            ranked.append(
                {
                    key: row[key]
                    for key in (
                        "id",
                        "content",
                        "timestamp",
                        "created_at",
                        "veracity",
                        "author_type",
                    )
                }
                | {"score": round(relevance, 4), "rank": row["rank"]}
            )
        ranked.sort(key=lambda r: (-r["score"], r["rank"]))
        return ranked[:KB_TOPK]

    def _lineage_gate(self, app: str, connection_initiator: str, name: str, arguments: dict) -> str:
        """The lineage gate and the redaction class in one place (PRD
        20261114-lineage-gated-writes). Runs before any handler sees the
        arguments and returns the conversation's class — 'human', 'driven',
        'unanchored', 'absent' — for every call.

        Writes require a human in the conversation's line; an unanchored
        caller keeps only the observation grant on memory_remember, and
        its attribution is stamped here, never taken from the model. The
        initiator is read off the connection, never off the arguments: a
        model-supplied value is a forged lineage, the same way a
        model-supplied app or conversation id is a forged pointer. The
        connection's declaration only decides conversations the registry
        has not seen yet."""
        conversation = str(arguments.get("conversation_id") or "").strip()
        arguments.pop("initiator", None)
        arguments.pop("author_id", None)
        arguments.pop("author_type", None)
        root, depth = self.store.session_lineage(self.tools.machine_id, app, conversation)
        if root == "human":
            cls = "human" if depth == 0 else "driven"
        elif root == "agent":
            cls = "unanchored"
        else:
            cls = {"human": "human", "agent": "unanchored"}.get(connection_initiator, "absent")
        if name == "memory_remember":
            if cls in ("unanchored", "absent"):
                label = (arguments.get("source") or "").strip() or "fact"
                if label not in OBSERVATION_LABELS:
                    raise ToolError(UNANCHORED_WRITE_MESSAGE)
                arguments["source"] = label
                arguments["author_type"] = "agent"
                # The observation grant carries no self-certified metadata:
                # an unanchored row is the agent's say-so, and the store's
                # trust vocabulary (importance, veracity, scope) stays in
                # human hands until a human session adopts the finding.
                arguments["scope"] = "project"
                arguments["importance"] = min(_coerce_importance(arguments.get("importance")), 0.5)
                arguments["veracity"] = "inferred"
                # The row this call creates must not read legacy-human, or
                # the caller's next write passes the gate open.
                arguments["initiator"] = "agent"
            elif cls == "driven":
                arguments["author_type"] = "agent"
            else:
                arguments["initiator"] = "human"
        elif name in WRITE_TOOLS and cls in ("unanchored", "absent"):
            raise ToolError(
                UNREGISTERED_CONVERSATION_MESSAGE if cls == "absent" else UNANCHORED_WRITE_MESSAGE
            )
        return cls

    def call_tool(
        self, name: str, arguments: dict, *, app: str, connection_initiator: str = ""
    ) -> dict:
        arguments = dict(arguments or {})
        # The gate runs before anything else touches the arguments and
        # before any state changes: it reads the conversation off the
        # arguments and the initiator off the connection, then the
        # stripping below decides which of them a handler may see.
        gate_class = self._lineage_gate(app, connection_initiator, name, arguments)

        # The mcp_commands surface: new-style commands validate against
        # their pydantic model (the same one whose schema the client saw)
        # and receive the composed context. `conversation_id` passes for
        # the authoring commands the same way it does for memory_remember —
        # the plugin injects it, and a model-supplied value is a forged
        # pointer everywhere else.
        command = next((c for c in TOOL_RULE_COMMANDS if c.name == name), None)
        if command is not None:
            arguments.pop("app", None)
            if name not in MCP_COMMANDS_WITH_SESSION:
                arguments.pop("conversation_id", None)
            arguments.pop("initiator", None)
            try:
                parsed = command.model.model_validate(arguments)
            except pydantic.ValidationError as error:
                details = "; ".join(
                    f"{'.'.join(str(part) for part in item['loc'])}: {item['msg']}"
                    for item in error.errors()[:5]
                )
                raise ToolError(details) from None
            with self.lock, spans.span("tool.call", tool=name) as node:
                node.set(args=len(json.dumps(arguments)))
                return command.handle(self.command_context, parsed)

        handler = getattr(self.tools, name, None)
        if handler is None or not name.startswith(TOOL_PREFIXES):
            raise ToolError(f"unknown tool {name!r}")
        # The connection decides the client, never the payload, so a value
        # that arrived in the arguments is discarded rather than trusted.
        arguments.pop("app", None)
        arguments.pop("homes", None)
        # The session link is the same kind of decision: only a write binds
        # one, and on a plugin client the layer that knows the session
        # injects conversation_id itself, overwriting whatever the model
        # put in the arguments — a value the model supplies is a forged
        # pointer, not provenance. Every other tool strips it. A client
        # without a plugin layer still passes the write through with
        # whatever the model named until that client stamps at its own
        # layer; the placeholder anchor is what a write with no link gets.
        # knowledge_read takes it for the same reason in the other direction: the
        # client knows which conversation's deferred facts to hand back.
        if name not in ("memory_remember", "knowledge_read"):
            arguments.pop("conversation_id", None)
        # initiator passed only where the gate put a decided value for the
        # handler to create the session row with (memory_remember).
        if name != "memory_remember":
            arguments.pop("initiator", None)
        if name in TOOLS_WITH_APP:
            arguments["app"] = app
        # The gate only spans the scorer path; tool calls stay serialized on
        # the shared store connection via the daemon lock (write paths).
        with self.lock:
            with spans.span("tool.call", tool=name) as node:
                node.set(args=len(json.dumps(arguments)))
                result = handler(**arguments)
        if gate_class in ("unanchored", "absent") and name in LINEAGE_REDACT_READS:
            return _redact_lineage_pointers(result)
        return result


def _coerce_importance(value) -> float:
    """Junk in the importance slot becomes the 0.5 default here instead of
    an AttributeError deep in the gate — a malformed argument is the
    caller's mistake, and the gate answers mistakes, it does not crash."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.5


def _redact_lineage_pointers(result: dict) -> dict:
    """Strip session ids and the summaries that name them from a read's
    result for callers with no human in their line: an injected bot must
    not learn a valid parent session id to claim as its own. Episodic
    summaries carry the same pointer as `summary_of`, so that key goes
    too. Counts and previews stay — the shape degrades, the content does
    not."""
    if isinstance(result, dict):
        return {
            key: _redact_lineage_pointers(value)
            for key, value in result.items()
            if key not in ("session_id", "source_conversation", "summary_of")
        }
    if isinstance(result, list):
        return [_redact_lineage_pointers(item) for item in result]
    return result


def calling_client(context) -> tuple[str, str]:
    """Which client is on the other end, read off the MCP connection, and
    the lineage initiator that connection declares (PRD
    20261114-lineage-gated-writes).

    The name is stored on every deliberate memory, so it has to be something
    the deployment controls rather than the model: each client is registered
    with its own URL, and an `app` that arrived in the arguments is discarded
    before the call runs. A client hook could fill one in — Cursor's
    preToolUse rewrites MCP arguments, which is how the Cursor client adds a
    working directory — but a per-call argument is also a per-call omission,
    and the recorded origin of a write should not depend on the hook having
    fired. A connection that declares nothing is refused rather than assigned
    a name.

    The initiator rides the same URL and the same reasoning: it is the
    deployment's declaration of who starts this client's sessions, so the
    lineage gate never has to take the model's word for it. It only decides
    conversations the registry has not seen yet."""
    request = getattr(context, "request", None)
    if request is None:
        return "", ""
    name = (request.query_params.get("app") or "").strip()
    initiator = (request.query_params.get("initiator") or "").strip().lower()
    if initiator not in ("human", "agent"):
        initiator = ""
    if not name:
        raise ToolError("this MCP connection declares no client; register it as /mcp?app=<client>")
    return name, initiator


def build_app(state: DaemonState) -> Starlette:
    """The daemon's whole HTTP surface: the MCP endpoint and the plain
    POST routes the clients' hooks call. Separate from main() so the wire
    format can be exercised without a socket or the timer threads."""

    mcp_definitions = [
        {
            "name": definition["name"],
            "description": definition["description"],
            "inputSchema": definition.get("input_schema")
            or {
                "type": "object",
                "properties": {},
            },
        }
        for definition in TOOL_DEFINITIONS
    ] + [
        {
            "name": command.name,
            "description": command.description,
            "inputSchema": command.json_schema(),
        }
        for command in TOOL_RULE_COMMANDS
    ]

    async def on_list_tools(_context, _params):
        return ListToolsResult(tools=[Tool(**definition) for definition in mcp_definitions])

    async def on_call_tool(context, params):
        app, connection_initiator = calling_client(context)

        def call():
            return state.call_tool(
                params.name,
                dict(params.arguments or {}),
                app=app,
                connection_initiator=connection_initiator,
            )

        result = await anyio.to_thread.run_sync(call)
        return CallToolResult(
            content=[TextContent(type="text", text=json.dumps(result, default=str))]
        )

    server = Server("memory", on_list_tools=on_list_tools, on_call_tool=on_call_tool)
    # Stateless: no session id is issued and none is validated, so a client
    # that cached its connection keeps working across a daemon restart
    # instead of holding an id this process never heard of. The price is the
    # server-to-client back-channel — server-initiated requests raise and
    # notifications drop — and nothing here has ever used it.
    sessions = StreamableHTTPSessionManager(app=server, stateless=True)

    async def handle_tool_recall(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        # The caller is a hook holding a tool call open, so work it has
        # already abandoned must not queue behind work it is still waiting
        # on: one scored request at a time, excess calls get the busy 503.
        if not state.nudge_gate.acquire(blocking=False):
            return Response(
                json.dumps({"status": "busy"}),
                status_code=503,
                headers={"Retry-After": "2"},
                media_type="application/json",
            )
        try:
            with anyio.fail_after(TOOL_RECALL_TIMEOUT_SECS):
                result = await anyio.to_thread.run_sync(
                    lambda: state.tool_recall(body),
                    abandon_on_cancel=True,
                )
        except ToolError as error:
            return Response(
                json.dumps({"status": "error", "error": str(error)}),
                status_code=400,
                media_type="application/json",
            )
        except TimeoutError:
            return Response(
                json.dumps({"status": "busy"}),
                status_code=503,
                headers={"Retry-After": "5"},
                media_type="application/json",
            )
        finally:
            state.nudge_gate.release()
        return Response(json.dumps(result, default=str), media_type="application/json")

    async def handle_session_open(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        with spans.span("session.open.http") as node:
            # The caller is a hook holding the first prompt open, and the
            # scorer underneath is the same expense: one scored request at
            # a time, excess calls get the busy 503.
            if not state.nudge_gate.acquire(blocking=False):
                node.set(outcome=503, gate="blocked")
                return Response(
                    json.dumps({"status": "busy"}),
                    status_code=503,
                    headers={"Retry-After": "2"},
                    media_type="application/json",
                )
            node.set(gate="acquired")
            try:
                with anyio.fail_after(SESSION_OPEN_TIMEOUT_SECS):
                    result = await anyio.to_thread.run_sync(
                        lambda: state.session_open(body),
                        abandon_on_cancel=True,
                    )
            except TimeoutError:
                node.set(status="timeout-503")
                return Response(
                    json.dumps({"status": "busy"}),
                    status_code=503,
                    headers={"Retry-After": "5"},
                    media_type="application/json",
                )
            finally:
                state.nudge_gate.release()
            node.set(status=200)
            return Response(json.dumps(result, default=str), media_type="application/json")

    async def handle_tool_moment(request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        try:
            # Bounds the whole moment pass (match + fire record). With
            # abandon_on_cancel a timed-out run can still finish in the
            # background and record its fire — fail-open by design, and
            # the same shape as the gated routes: the client has already
            # given up, the guard keeps a pathological run from holding
            # the request slot forever.
            with anyio.fail_after(TOOL_MOMENT_TIMEOUT_SECS):
                result = await anyio.to_thread.run_sync(
                    lambda: state.tool_moment(body),
                    abandon_on_cancel=True,
                )
        except ToolError as error:
            return Response(
                json.dumps({"status": "error", "error": str(error)}),
                status_code=400,
                media_type="application/json",
            )
        except TimeoutError:
            return Response(
                json.dumps({"status": "busy"}),
                status_code=503,
                headers={"Retry-After": "2"},
                media_type="application/json",
            )
        return Response(json.dumps(result, default=str), media_type="application/json")

    async def handle_compliance(request: Request):
        """The compliance ladder's event route (PRJ-179): cheap — no scorer,
        no gate, a bounded SQL write under the daemon lock — so it runs the
        tool-event shape (no semaphore) and only a pathological run can
        outlast the client's one-second budget."""
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        try:
            with anyio.fail_after(COMPLIANCE_TIMEOUT_SECS):
                result = await anyio.to_thread.run_sync(
                    lambda: state.compliance(body),
                    abandon_on_cancel=True,
                )
        except ToolError as error:
            return Response(
                json.dumps({"status": "error", "error": str(error)}),
                status_code=400,
                media_type="application/json",
            )
        except TimeoutError:
            return Response(
                json.dumps({"status": "busy"}),
                status_code=503,
                headers={"Retry-After": "2"},
                media_type="application/json",
            )
        return Response(json.dumps(result, default=str), media_type="application/json")

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        # The session manager demands its run() context be active for as
        # long as the app serves requests.
        async with sessions.run():
            yield

    return Starlette(
        routes=[
            Route("/session-open", endpoint=handle_session_open, methods=["POST"]),
            Route("/tool-recall", endpoint=handle_tool_recall, methods=["POST"]),
            Route("/tool-moment", endpoint=handle_tool_moment, methods=["POST"]),
            Route("/compliance", endpoint=handle_compliance, methods=["POST"]),
            Route(
                "/mcp",
                endpoint=MCPEndpoint(sessions),
                methods=["GET", "POST", "DELETE"],
            ),
        ],
        lifespan=lifespan,
    )


def _retry_deferred_at_startup(sync) -> None:
    """Apply what an older version set aside. A failure here is logged and
    never stops the daemon: the next pull retries the same records."""
    try:
        retried = sync.retry_deferred()
        if retried["applied"] or retried["deferred"]:
            print(f"deferred records at startup: {retried}", flush=True)
    except Exception as error:
        print(f"deferred retry failed: {error!r}", flush=True)


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(QUEUE_DIR, exist_ok=True)

    machine_id = os.environ.get("MEMORY_MACHINE_ID", os.uname().nodename).strip().lower()
    store = Store(os.path.join(DATA_DIR, "memory.db"))
    sync = SyncClient(
        store,
        HUB_URL,
        machine_id,
        api_key=os.environ.get("MEMORY_HUB_API_KEY", ""),
        queue_dir=QUEUE_DIR,
    )
    tools = RecordEmittingTools(store, machine_id, sync)
    # The deliberate pool's migration runs here, not inside the store
    # open, so the moved rows' records enqueue through the same _emit
    # path as every write: a boot that finds an unmigrated legacy pool
    # leaves with the pool moved AND its records queued for the hub.
    # The migration handles its own emit failures per row (pending-list
    # heal on the next boot); this catch is for the legacy data itself —
    # anything the copy raises defers that row onward, the commits before
    # it stay moved, and the next boot completes the rest. The readers
    # keep serving both pools meanwhile: a legacy pool that fails
    # deterministically degrades to the two-home behavior, never to an
    # outage.
    try:
        store.migrate_deliberate_rows(emit=tools._emit)
    except Exception as error:
        print(f"agent migration: deferred to next boot ({error!r})", flush=True)
    state = DaemonState(store, tools, sync)
    # VERSION is the build stamp a nix bundle writes at the bundle root, one
    # level above the package. In a source tree nothing writes it and the
    # fallback below covers that.
    version_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "VERSION",
    )
    try:
        with open(version_path, encoding="utf-8") as version_file:
            consolidator_version = version_file.read().strip()
    except FileNotFoundError:
        consolidator_version = os.environ.get("MEMORY_CONSOLIDATOR_VERSION", "dirty:source")
    consolidator = ClientConsolidator(
        store,
        sync,
        machine_id,
        consolidator_version,
        idle_secs=float(os.environ.get("MEMORY_CONSOLIDATION_IDLE_SECS", "600")),
        adopt_unowned=os.environ.get("MEMORY_CONSOLIDATION_ADOPT_UNOWNED", "") == "1",
    )

    # --- floor render + initial drain + timers ---------------------------

    def sync_cycle():
        with spans.span("sync.cycle") as node:
            try:
                result = sync.run_cycle()
                node.set(
                    applied=result.get("applied", 0),
                )
                # Re-render only when rule-affecting records landed: the hub
                # pull signal is the trigger; feedback and quiet cycles don't
                # render.
                by_kind = result.get("by_kind") or {}
                if by_kind.get("rule") or by_kind.get("forget"):
                    tools._render_floor()
                if matcher_rerender_kinds(by_kind):
                    tools._render_tool_matcher()
            except Exception as error:
                print(f"sync cycle failed: {error!r}", flush=True)
                node.set(status="error", error=repr(error)[:120])

    def sync_timer():
        while True:
            time.sleep(SYNC_INTERVAL_SECS)
            sync_cycle()

    def drain_timer():
        while True:
            time.sleep(DRAIN_INTERVAL_SECS)
            try:
                with spans.span("drain.cycle") as node:
                    result = drain_captures(store, sync, QUEUE_DIR, machine_id, consolidator)
                    node.set(drained=result.get("drained", 0))
            except Exception as error:
                print(f"capture drain failed: {error!r}", flush=True)

    def consolidation_timer():
        while True:
            time.sleep(DRAIN_INTERVAL_SECS)
            try:
                consolidation_tick(store, consolidator)
            except Exception as error:
                print(f"client consolidation failed: {error!r}", flush=True)
            # The KB pass rides the same cadence: it is the build's only
            # scheduler, and its own failure shape (per-project release,
            # pending-list heal) keeps a bad build from taking the timer
            # down. Hubless daemons still compose — the local doc is the
            # artifact; enqueue just short-circuits.
            try:
                kb_result = kb.kb_build_pass(store, emit=tools._emit)
                if kb_result["built"] or kb_result["released"]:
                    print(f"kb build pass: {kb_result}", flush=True)
            except Exception as error:
                print(f"kb build pass failed: {error!r}", flush=True)

    if sync.enabled:
        threading.Thread(target=sync_timer, daemon=True).start()
    else:
        print("sync disabled: no MEMORY_HUB_URL configured", flush=True)
    threading.Thread(target=drain_timer, daemon=True).start()
    threading.Thread(target=consolidation_timer, daemon=True).start()
    # Before the first cycle, so records an older version set aside apply
    # on upgrade even when the hub is unreachable and the pull never runs.
    _retry_deferred_at_startup(sync)
    if sync.enabled:
        sync_cycle()  # immediate first cycle
    try:
        drain_captures(store, sync, QUEUE_DIR, machine_id, consolidator)
    except Exception as error:
        print(f"initial drain failed: {error!r}", flush=True)
    tools._render_floor()
    tools._render_tool_matcher()

    config = uvicorn.Config(build_app(state), host="127.0.0.1", port=MCP_PORT, log_level="warning")
    print(f"memory daemon listening on 127.0.0.1:{MCP_PORT}", flush=True)
    # Surfaces any span stuck open past MEMORY_SPAN_STUCK_SECS, binding it
    # with origin + trace ids: the only record a never-closing span leaves.
    spans.start_watchdog()
    anyio.run(uvicorn.Server(config).serve)


if __name__ == "__main__":
    main()
