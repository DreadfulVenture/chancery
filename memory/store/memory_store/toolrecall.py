"""Before-use recall: which tools the store knows, and what it says about them.

Prompt-time recall matches what the user typed, so a row about a tool only
surfaces when the prompt happens to mention it. The rows that matter most —
how to re-authenticate, which flag is wrong, which project to pass — are
wanted at the moment the agent reaches for the tool, which is usually
several turns later and matches nothing the user said.

The tool set is derived from the store rather than configured. A tool the
user has written three notes about is one worth interrupting for, and a tool
nobody has written about has nothing to say, so the clients' matcher stays
current without anyone maintaining a list.
"""

from __future__ import annotations

import re

# How many rows have to name a command before it counts as a tool. One
# mention is a passing reference; the threshold is what keeps the matcher
# off every word that ever appeared inside backticks.
MIN_ROWS = 3
# Rows per tool in one injection. The whole point is to be read mid-turn,
# next to a tool result, so it competes with the output of the command.
ROWS_PER_TOOL = 3
# Weight added per leading word a row's own command shares with the one
# about to run, beyond the tool name itself: `gcloud logging read` lifts the
# logging rows without displacing a high-importance row about auth.
USAGE_BONUS = 0.1

# Rows somebody chose to write, as against the captured turns that share
# the table. Every content-returning channel in `tools.py` filters the same
# way: a capture is a transcript line and reads like one, and it is reached
# deliberately through memory_find_conversations, never returned as content.
# The pool's home is agent_memory; working-memory rows still carrying the
# origin tag are migration stragglers (old replays between boots), read as
# a union with this predicate so every tool-moment reader sees one pool.
DELIBERATE = "origin = 'deliberate' AND id NOT IN (SELECT id FROM agent_memory)"

_SPAN = re.compile(r"`([^`\n]+)`")
# Hyphens are in (pre-commit), underscores are out: a name with one is far
# more likely to be a config attribute (`force_destroy = true`) than a
# command. Two characters minimum for the same reason.
_HEAD = re.compile(r"[a-z][a-z0-9-]*[a-z0-9]$")
# Backticked code that is not a command line. Assignments (`stage = "GA"`,
# `python = "3.11.*"`) and imports (`from datetime import UTC`) both put a
# plausible head in front of plausible arguments, and both are quoting a
# file rather than something anyone runs.
_NOT_A_COMMAND = re.compile(r"(?:^|\s)(?:=|import)(?:\s|$)|^\S+=")

# Words that start a command line without being a tool. Shell grammar and
# builtins only: this list belongs to the shell, so unlike a list of the
# user's tools it does not grow.
BUILTINS = frozenset(
    """
    alias bg bind break builtin case cd command compgen complete continue declare
    dirs disown do done echo elif else esac eval exec exit export fc fg fi for
    function getopts hash help history if in jobs kill let local logout popd
    printf pushd pwd read readonly return select set shift shopt source suspend
    test then time times trap true false type typeset ulimit umask unalias
    unset until wait while
    """.split()
)

# Words between a separator and the tool that are still not the tool. Each
# takes a command as its argument, so the thing after them is what runs.
_WRAPPERS = r"sudo|env|nice|nohup|time|exec|command|xargs(?:\s+-\S+)*|timeout\s+\S+"
# A shell assignment prefix: `MEMORY_DATA_DIR=/tmp gcloud ...`.
_ASSIGNMENT = r"[A-Za-z_][A-Za-z0-9_]*=\S*"
# Where a command can start: the beginning, after a separator, inside a
# substitution, or just inside a quote (`bash -c "gcloud ..."`).
_START = r"(?:^|[;&|(\n]|\$\(|[\"'`])"
# What may follow the name. Deliberately excludes `-` and word characters so
# that `go` does not match `gofmt` or `go-task`.
_END = r"(?=[\s;&|)\"'`<>]|$)"


def _spans(content):
    """The backticked spans in one row, split into tokens, minus the ones
    that are quoting code rather than a command."""
    out = []
    for span in _SPAN.findall(content or ""):
        span = span.strip()
        if not span or _NOT_A_COMMAND.search(span):
            continue
        tokens = span.split()
        if not _HEAD.match(tokens[0]) or tokens[0] in BUILTINS:
            continue
        out.append(tokens)
    return out


def derive_tools(store, min_rows: int = MIN_ROWS) -> list[str]:
    """Every command the store names in at least `min_rows` written-down rows.

    Counted once per row rather than per mention, so one row rehearsing the
    same command eight times does not elect it on its own.

    Captured turns are left out, the same rows recall leaves out: a tool
    elected by transcript chatter has nothing written about it to show, and
    the interruption would be for nothing.
    """
    counts: dict[str, int] = {}
    for (content,) in store.conn.execute(
        "SELECT content FROM agent_memory UNION ALL "
        f"SELECT content FROM working_memory WHERE {DELIBERATE}"
    ):
        for head in {tokens[0] for tokens in _spans(content) if len(tokens) >= 2}:
            counts[head] = counts.get(head, 0) + 1
    return sorted(head for head, rows in counts.items() if rows >= min_rows)


def matcher_pattern(tools) -> str:
    """The regex both sides run: Cursor's matcher, which decides whether the
    hook process starts at all, and the hook's own check, which decides.

    One string so the two cannot drift. It matches a tool in command
    position, which is the difference between starting the hook on half of
    all Shell calls and starting it on 86% of them — `go`, `git` and `make`
    turn up in paths and arguments everywhere.
    """
    names = sorted(tools, key=len, reverse=True)
    if not names:
        return ""
    alternation = "|".join(re.escape(name) for name in names)
    return f"{_START}\\s*(?:(?:{_WRAPPERS}|{_ASSIGNMENT})\\s+)*({alternation}){_END}"


def tools_in_command(command: str, tools) -> list[str]:
    """The tools this command line runs, in the order they appear.

    Cursor's matcher says only that the hook should start, never what it
    matched, and the payload carries nothing but the command — so the same
    pattern is run again here to find out.
    """
    pattern = matcher_pattern(tools)
    if not pattern or not command:
        return []
    found = []
    for match in re.finditer(pattern, command):
        if match.group(1) not in found:
            found.append(match.group(1))
    return found


def _shared_leading_words(span_tokens, command_tokens) -> int:
    shared = 0
    for mine, theirs in zip(span_tokens, command_tokens, strict=False):
        if mine != theirs:
            break
        shared += 1
    return shared


def _command_tail(command: str, tool: str) -> list[str]:
    """The command from the tool name onward, so `cd x && gcloud auth login`
    is compared against the rows about `gcloud auth`, not against `cd`."""
    position = command.find(tool)
    if position < 0:
        return [tool]
    return command[position:].split()[:4]


def recall_for_tools(
    store, tools, command: str = "", limit_per_tool: int = ROWS_PER_TOOL
) -> list[dict]:
    """The written-down rows worth reading before these tools run, best first.

    Ranked on importance, because what is recorded about a tool is mostly
    standing advice and the user's own weighting is the only ordering the
    store has for it, plus a nudge toward the subcommand actually being run.
    """
    columns = (
        "id, content, source, timestamp, created_at, author_id, author_type, veracity, importance"
    )
    out: list[dict] = []
    for tool in tools:
        tail = _command_tail(command, tool)
        scored = []
        # The LIKE narrows the scan; `_spans` is what decides. Tool names
        # are derived under `_HEAD`, so none of them can carry a wildcard
        # into the pattern.
        rows = store.conn.execute(
            f"""SELECT {columns} FROM agent_memory WHERE content LIKE ?
                UNION ALL
                SELECT {columns} FROM working_memory
                WHERE {DELIBERATE} AND content LIKE ?""",
            (f"%`{tool}%", f"%`{tool}%"),
        ).fetchall()
        for row in rows:
            mine = [tokens for tokens in _spans(row["content"]) if tokens[0] == tool]
            if not mine:
                continue
            shared = max(_shared_leading_words(tokens, tail) for tokens in mine)
            score = (row["importance"] or 0) + USAGE_BONUS * max(0, shared - 1)
            scored.append((score, dict(row)))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        for score, row in scored[:limit_per_tool]:
            row.pop("importance", None)
            row["tier"] = "working"
            row["tool"] = tool
            row["score"] = round(score, 4)
            out.append(row)
    return out
