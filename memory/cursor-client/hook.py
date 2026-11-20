#!/usr/bin/env python3
"""Cursor client: capture conversation turns and deliver what the daemon
says at session start and at tool moments.

The counterpart to memory/opencode-client/memory.ts, doing the same jobs for the other
client. Cursor runs a fresh process per hook event, so everything the plugin
keeps in memory for a session lives in a per-conversation state file here.

Delivery is event-shaped (ADR 20261104-retire-per-message-delivery): the
only stored content that rides a prompt is the session-start block on a
conversation's first. beforeSubmitPrompt captures the user's turn,
reports it to the compliance ladder, and on a conversation's first prompt
delivers the project knowledge base. afterAgentResponse captures
the assistant's turn. preCompact records the moment the IDE is about to
summarize the conversation away. beforeShellExecution and preToolUse ask the
daemon whether a bound tool rule speaks for the call, and postToolUse
delivers the informational ones beside the tool's result. preToolUse also
refuses a conversation's first tool call once while the facts matched at
session start sit unfetched.

Pure stdlib, and every network path fails open: a slow or dead daemon costs
context, never a stalled prompt or a blocked tool.
"""

import contextlib
import fcntl
import json
import os
import re
import sys
import time
import urllib.request

# Cursor invokes this with the system interpreter, which on macOS is 3.9,
# so nothing here may use syntax or stdlib added after it. The test suite
# runs under 3.12 and will not catch a violation; the interpreter check in
# memory_store/tests/test_cursor_hook.py is what does.
#
# Cursor runs hooks with a login environment that knows nothing about the
# daemon, so the port and queue directory a deployment chose cannot reach the
# hook that way. Whoever installs the daemon writes them here instead.
CONFIG_PATH = os.environ.get("MEMORY_CLIENT_CONFIG") or os.path.expanduser(
    "~/.local/services/memory/client.json"
)


def _config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


CONFIG = _config()

# Point observations, off unless the level says otherwise. Level name and
# line shape match the daemon's, so one setting turns on both sides of a
# round trip and the two logs read alike. Cursor starts a fresh process per
# event, so there is no span context to hang these off — each line stands
# alone and names its conversation.
DEBUGGING = (os.environ.get("MEMORY_SPAN_LOG") or CONFIG.get("log_level") or "").lower() == "debug"


def _debug(op, **attrs):
    if not DEBUGGING:
        return
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    body = " ".join(f"{key}={value}" for key, value in sorted(attrs.items()))
    line = f"{stamp} level=debug op={op} {body}"
    print(line, file=sys.stderr, flush=True)
    # Cursor owns this process's stderr and writes it nowhere a reader can
    # reach, so the line above only surfaces when the hook is run by hand
    # with a payload someone already has. The file is what makes a real
    # invocation observable. DEBUG_LOG is resolved below, after the
    # deployment's queue directory it sits in.
    try:
        os.makedirs(os.path.dirname(DEBUG_LOG), exist_ok=True)
        with open(DEBUG_LOG, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass  # observing a turn must never be what breaks it


def _setting(key, env_var):
    """A location only the deployment knows, with no fallback.

    Guessing here fails silently in the worst way: a hook pointed at a port
    nobody serves recalls nothing, and one appending to a directory nothing
    drains loses every captured turn, both without a word.
    """
    value = os.environ.get(env_var) or CONFIG.get(key)
    if not value:
        raise SystemExit(
            f"[memory] no {key}: set {env_var}, or have the deployment write it to {CONFIG_PATH}"
        )
    return value


QUEUE_DIR = _setting("queue_dir", "MEMORY_QUEUE_DIR")
QUEUE_FILE = os.path.join(QUEUE_DIR, "capture.jsonl")
STATE_DIR = os.path.join(QUEUE_DIR, "cursor-sessions")
DEBUG_LOG = os.path.join(QUEUE_DIR, "cursor-hook.log")

DAEMON_URL = _setting("daemon_url", "MEMORY_DAEMON_URL")
SESSION_OPEN_URL = f"{DAEMON_URL}/session-open"
SESSION_OPEN_TIMEOUT = float(os.environ.get("MEMORY_SESSION_OPEN_CLIENT_TIMEOUT", "5.0"))
# A failed session-open is retried on a later prompt, but not on every one:
# a wedged daemon must not collect a timeout from each prompt in turn.
SESSION_OPEN_BACKOFF_SECS = 30.0
# The plugin's closing line, so the block reads the same on both clients.
SESSION_CLOSING = (
    "Judge relevance and ignore what does not apply; this never assigns tasks. "
    "Correct it the same way you correct any memory: write the truer fact with "
    "memory_remember (a newer fact wins at the next build) or forget the row that "
    "carried the claim. When a reply uses this material, say it came from the "
    "memory store. The standing doc and everything beyond this block: knowledge_read."
)
TOOL_MOMENT_URL = f"{DAEMON_URL}/tool-moment"
# Tight: this runs with the tool call held open, where the user is watching.
TOOL_MOMENT_TIMEOUT = float(os.environ.get("MEMORY_TOOL_MOMENT_CLIENT_TIMEOUT", "2.0"))
# Compliance ladder (PRD-179): the turn report runs per prompt, so the
# budget stays tight — the daemon decides everything from counters.
COMPLIANCE_URL = f"{DAEMON_URL}/compliance"
COMPLIANCE_TIMEOUT = float(os.environ.get("MEMORY_COMPLIANCE_CLIENT_TIMEOUT", "1.0"))

# Cursor names an MCP tool `MCP:<tool>` — its own prefix, with no server key
# — and its shell tool `Shell`. Measured on 3.29: the prefix is the same on
# preToolUse and postToolUse.
MCP_PREFIX = "MCP:"
SHELL_TOOL = "Shell"

# The reading verbs (PRJ-178's stamp set), canonical. The daemon re-validates
# membership from what arrives.
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

# The memory tools that resolve provenance from a working directory. The
# daemon never fabricates one, so a call that arrives without it stores an
# empty project. Same set as the OpenCode plugin's.
CWD_TOOLS = frozenset(
    {
        "memory_remember",
        "memory_recall",
        "rule_recall",
        "rule_codify",
        "tool_rule_add",
        "tool_rule_lookup",
        "tool_rule_copy",
    }
)

# The writes whose row links to the session that wrote it, plus the reads
# whose provenance pointers the daemon's lineage gate redacts for callers
# with no human in their line — the gate needs the conversation to decide.
# Only the client knows which conversation it is in, so the hook supplies
# it; a write that arrives without one anchors to the provenance-
# unrecorded session. Mirrors the OpenCode plugin's set (PRD
# 20261114-lineage-gated-writes).
CONVERSATION_TOOLS = frozenset(
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
        "memory_recall",
        "memory_list",
        "memory_find_conversations",
        # Not a write: the conversation is how knowledge_read finds the facts
        # deferred at session start.
        "knowledge_read",
    }
)

APP = "cursor"

# Pending informational moments waiting for their postToolUse. A call that
# never reaches postToolUse (cancelled, or failed before Cursor reports it)
# leaves its entry behind, so the map is bounded rather than trusted to
# drain.
MAX_PENDING_MOMENTS = 20

COMPACTION_KIND = "compaction"

TRIVIAL = re.compile(
    r"^(y|n|yes|no|ok|okay|sure|thanks|thank you|yep|nope|yeah|nah|continue|"
    r"go ahead|do it|proceed|stop)\b[.!]*$",
    re.IGNORECASE,
)
TOOL_PREAMBLE = re.compile(
    r"^(I'?ll|Let me|I'?m going to|I will|Now I'?ll|First,?\s+I'?ll)\s+"
    r"(run|use|execute|check|read|look|search|edit|write|create|inspect|find)",
    re.IGNORECASE,
)


def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def decline():
    """No opinion on this call. Cursor's permission hooks block on a response
    they cannot validate, and a bare allow would approve a call past whatever
    gating the user has in front of it. Failing is the one documented outcome
    that does neither: the call proceeds down its normal path."""
    raise SystemExit(1)


def meaningful_assistant(text):
    stripped = text.strip()
    if len(stripped) < 100:
        return False
    if TOOL_PREAMBLE.match(stripped) and len(stripped) < 200:
        return False
    return True


def canonical_tool(tool_name):
    if tool_name.startswith(MCP_PREFIX):
        return tool_name[len(MCP_PREFIX) :]
    return tool_name


# --- per-conversation state -------------------------------------------------


def _state_path(conversation_id):
    conversation_id = (conversation_id or "").strip()
    if not conversation_id:
        return None
    return os.path.join(STATE_DIR, f"{conversation_id[:16]}.json")


def _blank_state():
    return {
        "session_open_done": False,
        "session_open_retry_at": 0.0,
        # Facts deferred at session start and not yet settled: fetched, or
        # the daemon's one first-tool refusal spent. While it is zero every
        # built-in tool call is declined here, without a daemon round trip.
        "facts_pending": 0,
        "moments": {},
    }


def _load_state(path):
    if not path:
        return _blank_state()
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return _blank_state()
    if not isinstance(data, dict):
        return _blank_state()
    state = _blank_state()
    state["session_open_done"] = bool(data.get("session_open_done"))
    try:
        state["session_open_retry_at"] = float(data.get("session_open_retry_at") or 0.0)
    except (TypeError, ValueError):
        pass
    try:
        state["facts_pending"] = int(data.get("facts_pending") or 0)
    except (TypeError, ValueError):
        pass
    moments = data.get("moments")
    if isinstance(moments, dict):
        state["moments"] = {str(key): str(value) for key, value in moments.items()}
    return state


def _save_state(path, state):
    if not path:
        return
    moments = state["moments"]
    while len(moments) > MAX_PENDING_MOMENTS:
        moments.pop(next(iter(moments)))
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "session_open_done": state["session_open_done"],
                    "session_open_retry_at": state["session_open_retry_at"],
                    "facts_pending": state["facts_pending"],
                    "moments": moments,
                },
                handle,
            )
    except Exception:
        pass  # best-effort; a lost write risks one repeat, never the turn


@contextlib.contextmanager
def _locked_state(path):
    """The conversation's state for one read-modify-write, saved on exit if
    it changed. Cursor runs a process per event and parallel tool calls run
    their hooks at once, so without the lock two of them can load the same
    file and the later save drops the other's parked moment. Never hold it
    across a daemon round trip: every other hook for the conversation waits
    on it."""
    if not path:
        yield _blank_state()
        return
    lock = None
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        lock = open(f"{path}.lock", "a")
        fcntl.flock(lock, fcntl.LOCK_EX)
    except OSError:
        # A lock that cannot be had degrades to the unlocked write, which
        # risks one lost moment rather than the call.
        if lock:
            lock.close()
        lock = None
    try:
        state = _load_state(path)
        before = json.dumps(state, sort_keys=True)
        yield state
        if json.dumps(state, sort_keys=True) != before:
            _save_state(path, state)
    finally:
        if lock:
            lock.close()


# --- daemon round trip ------------------------------------------------------


def _post(url, body, timeout):
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _compliance(event_kind, conversation_id, tool=None):
    """One compliance-report event to the daemon (PRD-179). The hook only
    reports — an active prompt arrived, or the agent executed a reading
    verb — and every decision lives daemon-side."""
    body = {
        "type": event_kind,
        "app": APP,
        "conversation_id": conversation_id,
    }
    if tool:
        body["tool"] = tool
    return _post(COMPLIANCE_URL, body, COMPLIANCE_TIMEOUT)


# --- session start ----------------------------------------------------------


def format_session_block(data):
    """The session-start block, the OpenCode plugin's text without the
    system-reminder frame, which Cursor puts around additional_context
    itself: what it is and when it was composed, the standing doc, the
    instruction to fetch the facts matching the opening request, then the
    advisory line, the correction protocol, attribution on use, and the pull
    pointer.

    The facts are fetched rather than inlined because Cursor 3.29.9 inlines
    at most 10,000 characters of additional_context per turn, summed over
    every hook on the event. The doc's 6,000-character cap fits under that
    with room for the frame and other hooks; the doc plus five facts of up
    to 1,200 characters each does not."""
    parts = [
        f"Project knowledge: {data.get('project') or ''} — composed "
        f"{data.get('doc_created_at') or 'at an unknown time'}, folded from "
        f"{data.get('inputs_count') or 0} recorded row(s).",
        "",
        str(data.get("doc") or ""),
    ]
    pending = data.get("facts_pending") or 0
    if pending:
        parts += [
            "",
            f"{pending} stored fact(s) match this request. Before anything else, "
            "call knowledge_read with no arguments to read them. Until you do, your "
            "first call to any other tool is refused once.",
        ]
    parts += ["", SESSION_CLOSING]
    return "\n".join(parts)


def session_block(text, cwd, conversation_id):
    """The session-start block for this conversation, at most once.

    An answer from the daemon settles the conversation for good, including
    the honest silence of a project with no knowledge base: a build that
    lands later reaches the next conversation, not this one. A failed fetch
    leaves it unsettled and backs off."""
    state_path = _state_path(conversation_id)
    if not state_path:
        return None
    with _locked_state(state_path) as state:
        if state["session_open_done"] or time.time() < state["session_open_retry_at"]:
            return None
    try:
        data = _post(
            SESSION_OPEN_URL,
            {
                "prompt": text,
                "cwd": cwd,
                "conversation_id": conversation_id,
                "app": APP,
                "defer_facts": True,
            },
            SESSION_OPEN_TIMEOUT,
        )
    except Exception as error:
        _debug("session.open.failed", conversation=conversation_id, error=repr(error)[:120])
        with _locked_state(state_path) as state:
            state["session_open_retry_at"] = time.time() + SESSION_OPEN_BACKOFF_SECS
        return None
    has_doc = isinstance(data, dict) and bool(data.get("doc"))
    pending = 0
    if has_doc:
        try:
            pending = int(data.get("facts_pending") or 0)
        except (TypeError, ValueError):
            pending = 0
    with _locked_state(state_path) as state:
        state["session_open_done"] = True
        if has_doc:
            state["facts_pending"] = pending
    if not has_doc:
        _debug("session.open", conversation=conversation_id, doc=0)
        return None
    block = format_session_block(data)
    _debug(
        "session.open",
        conversation=conversation_id,
        doc=1,
        project=data.get("project") or "-",
        facts_pending=state["facts_pending"],
        chars=len(block),
    )
    return block


# --- tool moments -----------------------------------------------------------


def format_moment(delivery):
    project = delivery.get("project") or ""
    scope = delivery.get("scope") or "unknown"
    rule_id = delivery.get("rule_id")
    return (
        f"{delivery.get('section') or ''}\n\n"
        f"- [{delivery.get('created_at') or 'unknown time'}] "
        f"({scope}{': ' + project if project else ''}) {delivery.get('note') or ''}"
        f"{f' (rule {rule_id})' if rule_id else ''}"
    )


def _moment_key(tool_use_id, tool_name, detail):
    """The key that pairs a pre-call fetch with its postToolUse. Cursor sends
    the same tool_use_id on both; the fallback only has to pair calls that
    lack one, and a collision costs one block shown beside the wrong call."""
    if tool_use_id:
        return f"id\0{tool_use_id}"
    return f"call\0{tool_name}\0{detail}"


def tool_moment(event, cwd, conversation_id, key):
    """Ask the daemon what the bound rules say about this call.

    Returns the rejection text when the daemon held the call, and None
    otherwise. An informational answer is parked in the conversation's state
    under `key` for postToolUse to deliver beside the result. Any failure is
    no answer: the call runs."""
    if not conversation_id:
        return None
    try:
        data = _post(
            TOOL_MOMENT_URL,
            {"app": APP, "conversation_id": conversation_id, "cwd": cwd, "event": event},
            TOOL_MOMENT_TIMEOUT,
        )
    except Exception as error:
        _debug("tool.moment.failed", conversation=conversation_id, error=repr(error)[:120])
        return None
    if not isinstance(data, dict):
        return None
    if data.get("facts_gate"):
        # The daemon answered the deferred-facts hold, so it is settled.
        _settle_facts(conversation_id)
    deliveries = [d for d in (data.get("deliveries") or []) if isinstance(d, dict)]
    _debug(
        "tool.moment",
        conversation=conversation_id,
        kind=event.get("kind") or "-",
        matched=len(deliveries),
        held=int(bool(data.get("held"))),
    )
    if data.get("held") and data.get("error"):
        return str(data["error"])
    if deliveries:
        with _locked_state(_state_path(conversation_id)) as state:
            state["moments"][key] = "\n\n".join(format_moment(d) for d in deliveries)
    return None


def pending_moment(conversation_id, keys):
    """The parked block for this call, consumed whether or not it is shown,
    so a stale block never narrates a later call's result."""
    state_path = _state_path(conversation_id)
    if not state_path:
        return None
    found = None
    with _locked_state(state_path) as state:
        for key in keys:
            text = state["moments"].pop(key, None)
            if text and found is None:
                found = text
    return found


# --- tool input -------------------------------------------------------------


def tool_input_with_stamps(arguments, tool, cwd, conversation_id):
    """`arguments` with this window's directory and conversation added where
    the tool takes them, or None when nothing changes — which keeps the
    response to a bare allow rather than a rewrite that changes nothing.

    A value already in the arguments is replaced rather than kept, matching
    the OpenCode plugin's unconditional assignment. A memory belongs to the
    project of the window it was learned in and the conversation it was
    learned in, and the model can observe neither, so its guess does not get
    to win over what the client knows.

    preToolUse hands MCP arguments over as an object, measured rather than
    documented: the docs' only example is a Shell call, and the MCP-specific
    hooks describe their own tool_input as a JSON string instead. Any shape
    but a mapping declines rather than guessing, so the call still goes
    through unstamped if that ever changes."""
    if not isinstance(arguments, dict):
        return None
    updated = dict(arguments)
    if cwd and tool in CWD_TOOLS:
        updated["cwd"] = cwd
    if conversation_id and tool in CONVERSATION_TOOLS:
        updated["conversation_id"] = conversation_id
        # Cursor sessions are always interactive, and the lineage
        # initiator lives on the MCP connection's URL (the nix module
        # writes it there, PRD 20261114-lineage-gated-writes). Nothing the
        # model puts in the arguments reaches the gate.
    return updated if updated != arguments else None


# --- capture ----------------------------------------------------------------


def enqueue(record):
    try:
        os.makedirs(QUEUE_DIR, exist_ok=True)
        with open(QUEUE_FILE, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception:
        pass  # never block the turn on a capture failure


def record_compaction(data, cwd, conversation_id):
    """Ask the daemon to consolidate now, at the compaction boundary.

    The daemon distills the conversation into an episodic summary, normally
    not written until the session has been idle ten minutes, long after it
    was wanted. Riding the same queue as the turns is what makes the timing
    work: the drain reads lines in order, so everything captured before the
    marker is already ingested when it lands."""
    enqueue(
        {
            "kind": COMPACTION_KIND,
            "cwd": cwd,
            "app": APP,
            "conversation_id": conversation_id,
            "trigger": data.get("trigger") or "",
            "ts": time.time(),
        }
    )


# --- events -----------------------------------------------------------------


def before_shell(data, cwd, conversation_id):
    # Denying is the only way to reach the agent before a command runs.
    # `agent_message` is accepted and validated by Cursor and then never
    # delivered, on an allow or a deny alike; `user_message` on a deny is
    # the one field that arrives, and it arrives as the tool's result.
    # So a held command is refused once with the rule as its result, and an
    # informational rule waits for postToolUse instead.
    command = data.get("command") or ""
    if not command.strip():
        decline()
    key = _moment_key(data.get("tool_use_id"), SHELL_TOOL, command)
    held = tool_moment({"kind": "command", "command": command}, cwd, conversation_id, key)
    if not held:
        decline()
    emit({"permission": "deny", "user_message": held})


def _settle_facts(conversation_id):
    """Mark this conversation's deferred facts settled, so no later call
    asks the daemon about them. Reports whether they were still pending."""
    state_path = _state_path(conversation_id)
    if not state_path:
        return False
    with _locked_state(state_path) as state:
        if not state["facts_pending"]:
            return False
        state["facts_pending"] = 0
    return True


def before_builtin_tool(data, cwd, conversation_id):
    # preToolUse matches every tool so the deferred-facts hold can catch the
    # first one, but no rule binds a built-in tool by name, so once the hold
    # is settled there is nothing to ask. Settling before the round trip
    # means a dead daemon costs one timeout per conversation, not one per
    # call.
    tool_name = data.get("tool_name") or ""
    if not tool_name or not _settle_facts(conversation_id):
        decline()
    key = _moment_key(data.get("tool_use_id"), tool_name, "")
    held = tool_moment({"kind": "tool", "tool": tool_name}, cwd, conversation_id, key)
    if not held:
        decline()
    # user_message is the field Cursor delivers to the agent on a built-in
    # tool's deny, as the tool's result; agent_message is not delivered.
    emit({"permission": "deny", "user_message": held, "agent_message": held})


def before_tool(data, cwd, conversation_id):
    tool_name = data.get("tool_name") or ""
    if not tool_name.startswith(MCP_PREFIX):
        before_builtin_tool(data, cwd, conversation_id)
        return
    tool = canonical_tool(tool_name)
    if tool == "knowledge_read":
        # The stamped conversation is what makes this call the fetch.
        _settle_facts(conversation_id)
    # The compliance pull report rides ahead of everything else: the agent
    # executed a reading verb, which resets the ladder regardless of what the
    # permission flow does with the call.
    if conversation_id and tool in COMPLIANCE_PULL_TOOLS:
        try:
            _compliance("pull", conversation_id, tool=tool)
        except Exception as error:
            _debug("compliance.pull.failed", conversation=conversation_id, error=repr(error)[:120])
    arguments = data.get("tool_input")
    key = _moment_key(
        data.get("tool_use_id"), tool_name, json.dumps(arguments, sort_keys=True, default=str)
    )
    held = tool_moment({"kind": "mcp", "tool": tool_name}, cwd, conversation_id, key)
    if held:
        # Which of the two fields reaches the model on an MCP deny is not
        # documented; both carry the same text so either one is enough.
        emit({"permission": "deny", "user_message": held, "agent_message": held})
        return
    updated = tool_input_with_stamps(arguments, tool, cwd, conversation_id)
    _debug(
        "tool.stamp",
        tool=tool_name,
        cwd=cwd or "-",
        shape=type(arguments).__name__,
        stamped=int(updated is not None),
    )
    if tool not in CWD_TOOLS and tool not in CONVERSATION_TOOLS:
        decline()
    response = {"permission": "allow"}
    if updated is not None:
        response["updated_input"] = updated
    emit(response)


def after_tool(data, conversation_id):
    tool_name = data.get("tool_name") or ""
    arguments = data.get("tool_input")
    if tool_name == SHELL_TOOL:
        detail = (arguments or {}).get("command", "") if isinstance(arguments, dict) else ""
    else:
        detail = json.dumps(arguments, sort_keys=True, default=str)
    keys = [_moment_key(data.get("tool_use_id"), tool_name, detail)]
    if data.get("tool_use_id"):
        keys.append(_moment_key("", tool_name, detail))
    text = pending_moment(conversation_id, keys)
    emit({"additional_context": text} if text else {})


def before_prompt(data, cwd, conversation_id):
    text = (data.get("prompt") or "").strip()
    response = {"continue": True}
    if not text or text.startswith("/"):
        emit(response)
        return
    blocks = []
    trivial = bool(TRIVIAL.match(text))
    if not trivial:
        # The compliance ladder's turn leg (PRD-179). The reminder leads the
        # block, ahead of the session-start block on a first prompt.
        try:
            reply = _compliance("turn", conversation_id)
            if isinstance(reply, dict) and reply.get("section"):
                blocks.append(str(reply["section"]))
        except Exception as error:
            _debug("compliance.failed", conversation=conversation_id, error=repr(error)[:120])
    # A "continue" opening still deserves the session-start block, so the
    # check runs on trivial prompts too.
    opening = session_block(text, cwd, conversation_id)
    if opening:
        blocks.append(opening)
    if blocks:
        # additional_context on beforeSubmitPrompt is undocumented, but it is
        # the channel that works. Hooks do not fire under `cursor-agent -p`
        # either way, so this is an IDE-only path.
        response["additional_context"] = "\n\n".join(blocks)
    if not trivial:
        enqueue(
            {
                "role": "user",
                "text": text,
                "cwd": cwd,
                "app": APP,
                "conversation_id": conversation_id,
                # Cursor sessions are interactive; the drain resolves the
                # session from this declaration (PRD
                # 20261114-lineage-gated-writes).
                "initiator": "human",
                "model": data.get("model") or "",
                "ts": time.time(),
            }
        )
    emit(response)


def after_response(data, cwd, conversation_id):
    text = (data.get("text") or "").strip()
    if meaningful_assistant(text):
        enqueue(
            {
                "role": "assistant",
                "text": text,
                "cwd": cwd,
                "app": APP,
                "conversation_id": conversation_id,
                "initiator": "human",
                "model": data.get("model") or "",
                "ts": time.time(),
            }
        )
    emit({})


def main():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        emit({"continue": True})
        return

    event = data.get("hook_event_name") or ""
    # The payload is the only source: this process runs in ~/.cursor, so its
    # own directory names nothing. Measured on Cursor 3.23.12, a window
    # opened from a saved .code-workspace reports `workspace_roots: []` on
    # every event (28 of 28 here), while a single-root window reports its
    # path. The only other field carrying one is `transcript_path`, and it
    # does not help: it slugifies the workspace *file* under Cursor's support
    # directory rather than a checkout, the slug collapses `/`, ` ` and `.`
    # to `-` so it cannot be reversed, and the path it reversed to here
    # matches no file that exists. So a rootless window stays rootless, and
    # the lever is to open the project in a window of its own.
    cwd = (data.get("workspace_roots") or [None])[0] or data.get("cwd") or ""
    conversation_id = data.get("conversation_id") or data.get("session_id") or ""
    # Which events actually arrive, and what the deployment resolved to. A
    # hook Cursor never invokes and a hook that runs and declines look the
    # same from outside the process.
    _debug(
        "hook.event",
        event=event or "-",
        conversation=conversation_id or "-",
        cwd=cwd or "-",
        daemon=DAEMON_URL,
        queue=QUEUE_DIR,
        # Which fields Cursor actually sends, and what it says about roots.
        # A window resolving to no directory is indistinguishable from a
        # window Cursor told nothing about, and only one of those is ours to
        # fix. Serialized rather than printed bare so the three cases read
        # apart: absent is `null`, present and empty is `[]`.
        keys=",".join(sorted(data)) or "-",
        roots=json.dumps(data.get("workspace_roots"), separators=(",", ":")),
    )

    if event == "preCompact":
        record_compaction(data, cwd, conversation_id)
        emit({})
    elif event == "beforeShellExecution":
        before_shell(data, cwd, conversation_id)
    elif event == "preToolUse":
        before_tool(data, cwd, conversation_id)
    elif event == "postToolUse":
        after_tool(data, conversation_id)
    elif event == "beforeSubmitPrompt":
        before_prompt(data, cwd, conversation_id)
    elif event == "afterAgentResponse":
        after_response(data, cwd, conversation_id)
    else:
        emit({"continue": True})


if __name__ == "__main__":
    main()
