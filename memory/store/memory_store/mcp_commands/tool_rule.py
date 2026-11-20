"""The tool_rules domain (PRD 20261104, tool matching; PRJ-168 curation).

A tool rule is a note enrolled against a tool key — `["git","push"]` or
an MCP tool name — and it delivers deterministically when that tool
fires: no similarity roll, exact-moment. This module is the rule's whole
agent-facing lifecycle: add, look up across projects (each row labeled
visible or hidden for the calling project), promote a project-scoped
rule to global, copy a rule into the calling project, and remove one
(the store's tombstone keeps a promoted or removed rule from
resurrecting when its original enrollment record replays).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

import pydantic
from pydantic import BaseModel, Field

from memory_store.capture import detect_repo
from memory_store.mcp_commands.command import Command, ToolContext, commands
from memory_store.store import mint_tool_rule_ids, tool_key_id
from memory_store.toolmatch import tokenize as toolmatch_tokenize
from memory_store.tools import ToolError

_Scope = Literal["project", "global"]


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _tokens(kind: str, key: str) -> list[str]:
    """The key tokenized the way add does: a caller handing prose is the
    authoring error to catch at the boundary, not at match time. Shared
    by add and lookup so both accept exactly the same key spelling."""
    if kind == "mcp" and len(key.split()) != 1:
        raise ToolError("an mcp key is one tool name, not a command line")
    tokens = key.split() if kind == "mcp" else toolmatch_tokenize(key)
    if not tokens or any(not token for token in tokens):
        # A key of pure punctuation trims to empty tokens and would fire
        # on any command carrying a stray comma or semicolon.
        raise ToolError(f"key {key!r} tokenizes to nothing matchable")
    return tokens


class AddInput(BaseModel):
    """`extra=forbid` so a typo'd optional (scopes) errors loudly at the
    boundary instead of silently taking the default."""

    model_config = pydantic.ConfigDict(extra="forbid")

    kind: Literal["command", "mcp"] = Field(
        description=(
            "command adds a rule for a shell command key (tokenized at "
            "add time); mcp adds one for an MCP tool by its canonical "
            "name (single element)."
        )
    )
    key: str = Field(
        description=(
            "What to match: a command line fragment for kind=command "
            '(\'git push\' -> ["git","push"]) or the tool\'s name for '
            "kind=mcp. Matching is contiguous token-subsequence presence, "
            "so wrappers and chain operators around the tokens still fire, "
            "and quoted prose never matches."
        )
    )
    note: str = Field(
        description=(
            "The rule delivered at the tool's moment of use. One rule "
            "says one thing; correcting the note is a new rule."
        )
    )
    scope: _Scope | None = Field(
        default=None,
        description=(
            "'project' (default) fires only in this session's project; "
            "'global' is the deliberate widening."
        ),
    )
    cwd: str | None = Field(
        default=None, description="Session working directory (plugin-injected)."
    )
    conversation_id: str | None = Field(
        default=None,
        description=(
            "The enrolling session (plugin-injected); stored for the "
            "provenance walk, never part of the rule's identity."
        ),
    )

    @pydantic.field_validator("key", "note")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value


class LookupInput(BaseModel):
    """Cross-project discovery (PRJ-168): every rule enrolled on a key,
    each labeled for the calling project."""

    model_config = pydantic.ConfigDict(extra="forbid")

    kind: Literal["command", "mcp"] = Field(
        description=(
            "command looks up a shell command key; mcp looks up an MCP "
            "tool by its canonical name (single element)."
        )
    )
    key: str = Field(
        description=(
            "The key to look up, spelled exactly as add takes it "
            '(\'git push\' -> ["git","push"]; a single MCP tool name).'
        )
    )
    cwd: str | None = Field(
        default=None, description="Session working directory (plugin-injected)."
    )

    @pydantic.field_validator("key")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value


class PromoteInput(BaseModel):
    """Promotion names a row and judges it — no cwd: the rule id pins the
    source, and promoting another project's gate is the point."""

    model_config = pydantic.ConfigDict(extra="forbid")

    rule_id: str = Field(
        description="The tool rule's id (tr_…), as lookup or a delivery rendered it."
    )
    conversation_id: str | None = Field(
        default=None,
        description=(
            "The acting session (plugin-injected); stored on the global "
            "twin for the provenance walk."
        ),
    )


class RemoveInput(BaseModel):
    """Removal names a row, like promotion — no cwd: the rule id pins it."""

    model_config = pydantic.ConfigDict(extra="forbid")

    rule_id: str = Field(
        description="The tool rule's id (tr_…), as lookup or a delivery rendered it."
    )


class CopyInput(BaseModel):
    model_config = pydantic.ConfigDict(extra="forbid")

    rule_id: str = Field(
        description="The tool rule's id (tr_…), as lookup or a delivery rendered it."
    )
    cwd: str | None = Field(
        default=None, description="Session working directory (plugin-injected)."
    )
    conversation_id: str | None = Field(
        default=None,
        description=(
            "The acting session (plugin-injected); stored on the copied "
            "row for the provenance walk."
        ),
    )


def add_rule(ctx: ToolContext, args: AddInput) -> dict:
    """Enroll a rule for a tool key. The rule defaults to this session's
    project — conservative, a repo-specific gate never leaks fleet-wide
    by accident — and `scope='global'` is the deliberate widening. The
    enrollment is content-addressed, so re-adding the same
    key+note+scope lands on the same row and converges fleet-wide. A
    forgotten rule's tombstone refuses an identical re-add: a changed
    note is a new rule, and resurrecting forgotten content must be
    nobody's silent default."""
    tokens = _tokens(args.kind, args.key)
    # Global scope ignores projects everywhere — one row fleet-wide — so
    # the detected project is deliberately dropped, not stored.
    project = "" if args.scope == "global" else (detect_repo(args.cwd) if args.cwd else "")
    if (args.scope or "project") == "project" and not project:
        raise ToolError(
            "no project resolved from cwd; a project-scoped rule must name its "
            "project — pass cwd, or scope='global' deliberately"
        )
    now = _now()
    tool = {
        "id": tool_key_id(args.kind, tokens),
        "kind": args.kind,
        "key": tokens,
        "created_by": ctx.machine_id,
        "created_at": now,
    }
    rule = {
        "tool_id": tool["id"],
        "note": args.note,
        "scope": args.scope or "project",
        "project": project,
        "conversation_id": (args.conversation_id or "").strip(),
        "created_by": ctx.machine_id,
        "created_at": now,
    }
    _tool_id, rule_id = mint_tool_rule_ids(tool, rule)
    if ctx.store.is_tombstoned("tool_rules", rule_id):
        raise ToolError(
            "this exact rule was forgotten; a changed note or scope is a new "
            "rule — adjust one of them to re-enroll"
        )
    rule["id"] = rule_id
    ctx.store.bind_tool(tool, rule)
    shipped = ctx.emit("tool_rule", {"tool": tool, "rule": rule})
    ctx.on_write()
    return {
        "status": "ok",
        "tool_id": tool["id"],
        "rule_id": rule_id,
        "key": tokens,
        "scope": rule["scope"],
        "project": project,
        "shipped": shipped,
        "delivery": (
            "the rule delivers at the tool's moment of use; with the holds "
            "flag on, the first execution per conversation is rejected with "
            "this note as its error text, and later executions are "
            "informational"
        ),
    }


def lookup_rules(ctx: ToolContext, args: LookupInput) -> dict:
    """Every rule enrolled on a key across all projects (PRJ-168), each
    labeled for the calling project: a pure read — nothing is written,
    nothing stamps usage counters (tool rules are not memory rows), and
    a foreign project's row stays right where it is. Hidden rules never
    deliver automatically here; that is the matcher's membership check,
    unchanged. The label exists so a good gate one project invented can
    spread on judgment: read the note, then copy or promote deliberately."""
    tokens = _tokens(args.kind, args.key)
    project = detect_repo(args.cwd) if args.cwd else ""
    if not project:
        raise ToolError("no project resolved from cwd; visibility labels need a project — pass cwd")
    rows = ctx.store.tool_rules_for_key(args.kind, tokens)
    rules = []
    for row in rows:
        rules.append(
            {
                "rule_id": row["rule_id"],
                "tool_id": row["tool_id"],
                "kind": row["kind"],
                "key": row["key"],
                "scope": row["scope"],
                "project": row["project"],
                "note": row["note"],
                "guidance_id": row["guidance_id"],
                "created_by": row["created_by"],
                "created_at": row["created_at"],
                "visible_here": row["scope"] == "global" or row["project"] == project,
            }
        )
    return {
        "status": "ok",
        "tool_id": tool_key_id(args.kind, tokens),
        "key": tokens,
        "project": project,
        "count": len(rules),
        "rules": rules,
    }


def _source(ctx: ToolContext, rule_id: str) -> dict:
    """The joined enrollment a promote/copy acts on. The tool row rides
    along because the wire's shape is the pair — a rule record never
    travels without its enrollment."""
    source = ctx.store.tool_rule(rule_id)
    if source is None:
        raise ToolError(f"no tool rule {rule_id!r}")
    return source


def _source_tool(source: dict) -> dict:
    """The source's enrollment rebuilt for the pair record: the tool's
    own identity fields, verbatim — the twin/copy rides the same
    enrollment, it does not mint a new one."""
    return {
        "id": source["tool_id"],
        "kind": source["kind"],
        "key": source["key"],
        "created_by": source["tool_created_by"],
        "created_at": source["tool_created_at"],
    }


def _retire(ctx: ToolContext, rule_id: str) -> bool:
    """Forget one rule and ship the forget. The tombstone is what keeps the
    original enrollment record, still in every machine's record log, from
    resurrecting the rule on replay. Reports whether the record shipped."""
    ctx.store.forget("tool_rules", rule_id)
    shipped = ctx.emit("forget", {"table": "tool_rules", "id": rule_id})
    ctx.on_write()
    return shipped


def remove_rule(ctx: ToolContext, args: RemoveInput) -> dict:
    """Remove a rule that should not exist: wrong, superseded by a truer
    note, or no longer worth its moment. Only that row goes; a copy or a
    promoted twin of the same note is its own row and keeps delivering."""
    source = _source(ctx, args.rule_id)
    shipped = _retire(ctx, source["rule_id"])
    return {
        "status": "ok",
        "removed_rule_id": source["rule_id"],
        "key": source["key"],
        "scope": source["scope"],
        "project": source["project"],
        "shipped": shipped,
        "delivery": "the rule no longer delivers; the tool's other rules are unchanged",
    }


def promote_rule(ctx: ToolContext, args: PromoteInput) -> dict:
    """Widen a project-scoped rule to global (PRJ-168). The twin is a new
    content-addressed row (scope is part of the id — no in-place edit
    exists), and the source row is then forgotten so its project-scoped
    gate does not double-deliver forever. Record order is twin first,
    removal second: the worst-case window double-delivers in the origin
    project rather than dropping a gate. The forget's tombstone is what
    keeps the original enrollment record — still in every machine's
    record log — from resurrecting the source on replay. A twin that
    already exists (another project promoted the same note first)
    converges silently; the source is still removed."""
    source = _source(ctx, args.rule_id)
    if source["scope"] == "global":
        raise ToolError("this rule is already global; it delivers everywhere already")
    now = _now()
    tool = _source_tool(source)
    twin = {
        "tool_id": source["tool_id"],
        "guidance_id": source["guidance_id"],
        "note": source["note"],
        "scope": "global",
        "project": "",
        "conversation_id": (args.conversation_id or "").strip(),
        "created_by": ctx.machine_id,
        "created_at": now,
    }
    _tool_id, twin_id = mint_tool_rule_ids(tool, twin)
    twin["id"] = twin_id
    ctx.store.bind_tool(tool, twin)
    shipped_twin = ctx.emit("tool_rule", {"tool": tool, "rule": twin})
    shipped_forget = _retire(ctx, source["rule_id"])
    return {
        "status": "ok",
        "promoted_rule_id": twin_id,
        "retired_rule_id": source["rule_id"],
        "tool_id": source["tool_id"],
        "note": source["note"],
        "shipped": shipped_twin and shipped_forget,
        "delivery": (
            "the rule now delivers in every project; grading and the holds flag are unchanged"
        ),
    }


def copy_rule(ctx: ToolContext, args: CopyInput) -> dict:
    """Adopt a rule into this project (PRJ-168): a project-scoped row in
    the caller's project carrying the same note verbatim. The note stays
    single-source in spirit — the copy references the same enrollment and
    guidance row, so a correction to the note's source content lands
    through the shared ids (PRJ-172's grading attaches to the guidance
    row, not to any one project's copy). An identical row in this
    project (same note from any source) is refused: it would be the same
    content-addressed id, and the honest answer is that this project
    already carries the rule."""
    source = _source(ctx, args.rule_id)
    project = detect_repo(args.cwd) if args.cwd else ""
    if not project:
        raise ToolError(
            "no project resolved from cwd; a project-scoped copy must name its project — pass cwd"
        )
    if source["scope"] == "project" and source["project"] == project:
        raise ToolError("this rule already lives in this project; nothing to copy")
    now = _now()
    tool = _source_tool(source)
    rule = {
        "tool_id": source["tool_id"],
        "guidance_id": source["guidance_id"],
        "note": source["note"],
        "scope": "project",
        "project": project,
        "conversation_id": (args.conversation_id or "").strip(),
        "created_by": ctx.machine_id,
        "created_at": now,
    }
    _tool_id, rule_id = mint_tool_rule_ids(tool, rule)
    if ctx.store.tool_rule(rule_id) is not None:
        raise ToolError(
            "this project already carries an identical rule for this key; nothing to copy"
        )
    rule["id"] = rule_id
    ctx.store.bind_tool(tool, rule)
    shipped = ctx.emit("tool_rule", {"tool": tool, "rule": rule})
    ctx.on_write()
    return {
        "status": "ok",
        "rule_id": rule_id,
        "tool_id": source["tool_id"],
        "key": source["key"],
        "scope": rule["scope"],
        "project": project,
        "shipped": shipped,
        "delivery": (
            "the copied rule delivers at the tool's moment of use in this "
            "project, exactly as the source does in its own"
        ),
    }


COMMANDS = commands(
    Command(
        name="tool_rule_add",
        description=(
            "Add a tool rule: a note delivered whenever the named tool "
            "fires — deterministically at the tool's moment of use, not "
            "on a similarity roll. Add rules for the bounded actions "
            "worth gating: a publish gate on 'git push', a deploy "
            "checklist on an MCP deploy tool. The rule defaults to this "
            "session's project; scope='global' widens it deliberately."
        ),
        model=AddInput,
        handle=add_rule,
    ),
    Command(
        name="tool_rule_lookup",
        description=(
            "Look up every tool rule enrolled on a key across all "
            "projects, each labeled visible or hidden for this project. "
            "Discovery for cross-project curation: read what gates other "
            "projects carry, then copy one into this project or promote "
            "one to global on judgment. Pure read — nothing delivers "
            "from this call."
        ),
        model=LookupInput,
        handle=lookup_rules,
    ),
    Command(
        name="tool_rule_promote",
        description=(
            "Promote a project-scoped tool rule to global, so it delivers "
            "in every project. The source row is retired; the note stays "
            "exactly as authored. Use on judgment, after reading a rule "
            "that proved itself worth carrying fleet-wide."
        ),
        model=PromoteInput,
        handle=promote_rule,
    ),
    Command(
        name="tool_rule_copy",
        description=(
            "Copy a tool rule into this project, referencing the same "
            "tool key and guidance content as the source. The copy "
            "delivers in this project only; the source is untouched. Use "
            "to adopt another project's gate without widening it "
            "fleet-wide."
        ),
        model=CopyInput,
        handle=copy_rule,
    ),
    Command(
        name="tool_rule_remove",
        description=(
            "Remove a tool rule that should not exist: wrong, superseded, "
            "or not worth its moment. Takes the rule's id (tr_…), as a "
            "delivery or lookup shows it. Only that row goes: a copy or a "
            "global twin of the same note keeps delivering. A changed note "
            "is a new rule, so correcting one is tool_rule_add followed by "
            "this. Needs no permission."
        ),
        model=RemoveInput,
        handle=remove_rule,
    ),
)
