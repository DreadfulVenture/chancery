"""Token matching for tool-moment delivery: which enrolled tool keys a
firing event speaks for.

Token-array lookup. The event string is tokenized at match time
(shlex-class, tolerant — never raise on malformed quoting; best-effort
whitespace fallback), and a key fires on contiguous token-subsequence
presence. Wrappers, assignments, chain operators, and redirects sit
harmlessly around matched tokens; quoted prose is one token and never
matches — **when shlex succeeds**; a malformed-quote command falls back
to whitespace splitting, which can slice a quoted phrase into matchable
tokens. That is the accepted price of tolerance: a false match on a
broken command line, never a crash. `regit` never matches `git`. Breadth
is the enrolling agent's deliberate choice, and a key fires anywhere in
the chain. One matcher definition, both clients.
"""

from __future__ import annotations

import shlex

# Shell punctuation that may wrap a matched token without changing what
# runs: subshells and process substitutions open before a command and
# close after it (`$(git push)`, `(git push)`, `>(git push)`), and a
# command's own punctuation (a trailing `;` or `,` in a list) is not part
# of its name. Stripping these edges is what lets subshell-wrapped
# commands match while `regit` (no punctuation edge) still never matches.
# Quoted prose needs no defense here — shlex already folds a quoted
# phrase into one token, which a multi-token key can never equal.
_PUNCTUATION = "(){};`,!<>$"

# Command events match command keys; MCP events match MCP keys. An MCP
# tool name is an opaque identifier matched whole — no tokenization, no
# subsequence: `memory_remember` never fires for `memory_recall`.


def tokenize(command: str) -> list[str]:
    """The event string as tokens. Tolerant: malformed quoting falls back
    to whitespace splitting rather than raising, and shell punctuation is
    trimmed from token edges so wrappers and subshell syntax sit
    harmlessly around a match."""
    try:
        tokens = shlex.split(command)
    except ValueError:
        tokens = command.split()
    return [_trim_edges(token) for token in tokens]


def _trim_edges(token: str) -> str:
    # `$(`, `>(` nest, so punctuation and the substitution markers trim
    # together, per token — positions are preserved and a quoted phrase
    # stays one token.
    return token.strip(_PUNCTUATION)


def key_matches(tokens: list[str], key: list[str]) -> bool:
    """Contiguous token-subsequence presence."""
    width = len(key)
    if not width or width > len(tokens):
        return False
    return any(tokens[start : start + width] == key for start in range(len(tokens) - width + 1))


def command_matches(command: str, key: list[str]) -> bool:
    """A command event against a command key."""
    return key_matches(tokenize(command), key)


def mcp_matches(tool_name: str, key: list[str]) -> bool:
    """An MCP call event against an MCP key: single-element, exact."""
    return len(key) == 1 and tool_name == key[0]


# Clients decorate MCP tool names with the serving server's name
# (opencode exposes this daemon's memory_remember as memory_memory_
# remember). The alias is per client, derived from its actual surface —
# a client that decorates differently gets its own entry, and the
# canonical key in the registry stays the tool's own name.
MCP_NAME_PREFIXES = {
    "opencode": "memory_",
    # Cursor's own prefix, carrying no server key (`MCP:memory_recall`).
    "cursor": "MCP:",
}


def canonical_mcp_name(app: str, decorated: str, known: frozenset[str] = frozenset()) -> str:
    """Strip a client's decoration from an MCP tool name. A client with
    no known decoration is matched verbatim — the registry keys are
    canonical, so a client whose prefix is missing from
    MCP_NAME_PREFIXES never matches an mcp binding, without a word.

    `known` (the daemon's own canonical tool names) breaks the one real
    ambiguity: this server's tools are named memory_*, and opencode
    decorates with the server name, so a wire name can itself start with
    the prefix without being decorated. A name that already IS canonical
    passes through; anything else loses one prefix."""
    if decorated in known:
        return decorated
    prefix = MCP_NAME_PREFIXES.get(app, "")
    if prefix and decorated.startswith(prefix):
        return decorated[len(prefix) :]
    return decorated
