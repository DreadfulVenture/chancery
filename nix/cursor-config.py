"""Merge memory-store's Cursor wiring into ~/.cursor/mcp.json and hooks.json.

Both files are mutable and shared with every other tool the user installs, so
this touches only its own keys and leaves the rest of the file alone. Anything
else writing them has to hold the same discipline. Idempotent — running it
twice leaves the files identical.

These are the files Cursor rereads when it rebuilds its state, which is why
the wiring lives here rather than in a plugin: a plugin delivered by a
workspaceOpen hook is dropped whenever the extension host restarts, because
the rebuild does not re-run the hook.
"""

import argparse
import json
import os


def load(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


def dump(path, obj):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(obj, handle, indent=2)
        handle.write("\n")


def _is_ours(entry, suffixes):
    """Ours by the tail of the command, not by the whole path: the directory
    it sits in moves on every rebuild, since the hook command comes out of a
    store path. Matching the whole path would leave each previous
    location's registration firing alongside the current one."""
    if not isinstance(entry, dict):
        return False
    command = str(entry.get("command", ""))
    return any(command.endswith(suffix) for suffix in suffixes)


def set_hook(hooks, event, command, suffixes, matcher=None):
    """Register our command for one event, replacing any earlier copy of
    ours. `matcher` is Cursor's per-entry regex over the thing the event is
    about — the tool name, for the tool events — and an event registered
    without one runs the hook every time it fires."""
    entries = hooks.get(event)
    entries = entries if isinstance(entries, list) else []
    entries = [entry for entry in entries if not _is_ours(entry, suffixes)]
    entry = {"command": command}
    if matcher:
        entry["matcher"] = matcher
    entries.append(entry)
    hooks[event] = entries


def prune_hook(hooks, keep_events, suffixes, skip_events=()):
    """Drop our own registration from events we no longer answer, leaving
    every other tool's hooks in place. Without this, narrowing the event list
    leaves a stale registration firing forever.

    `skip_events` are the ones the daemon registers for itself, because
    their matcher is derived from the store and changes between deploys.
    Activation does not know what belongs there, so it leaves them alone
    rather than deleting the daemon's entry on every rebuild."""
    for event in list(hooks):
        if event in keep_events or event in skip_events:
            continue
        entries = hooks.get(event)
        if not isinstance(entries, list):
            continue
        kept = [entry for entry in entries if not _is_ours(entry, suffixes)]
        if len(kept) == len(entries):
            continue
        if kept:
            hooks[event] = kept
        else:
            hooks.pop(event, None)


def set_server(cursor_dir, server_name, url):
    path = os.path.join(cursor_dir, "mcp.json")
    mcp = load(path)
    servers = mcp.get("mcpServers")
    mcp["mcpServers"] = servers if isinstance(servers, dict) else {}
    mcp["mcpServers"][server_name] = {"type": "streamable-http", "url": url}
    dump(path, mcp)


def main_with_args(
    cursor_dir,
    server_name,
    server_url,
    hook_command,
    owned_suffixes,
    events,
    matchers=None,
    daemon_events=(),
):
    os.makedirs(cursor_dir, exist_ok=True)

    set_server(cursor_dir, server_name, server_url)

    matchers = matchers or {}
    daemon_events = set(daemon_events or ())
    hooks_path = os.path.join(cursor_dir, "hooks.json")
    hooks = load(hooks_path)
    hooks["version"] = 1
    hooks.setdefault("hooks", {})
    for event in events:
        if event in daemon_events:
            continue
        set_hook(hooks["hooks"], event, hook_command, owned_suffixes, matchers.get(event))
    prune_hook(hooks["hooks"], set(events), owned_suffixes, daemon_events)
    dump(hooks_path, hooks)


def parse_matchers(pairs):
    """`event=regex` strings into a mapping. A regex may hold an `=`, so only
    the first one separates."""
    matchers = {}
    for pair in pairs or []:
        event, separator, matcher = pair.partition("=")
        if not separator or not event:
            raise SystemExit(f"--matcher wants event=regex, got {pair!r}")
        matchers[event] = matcher
    return matchers


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cursor-dir", required=True)
    parser.add_argument("--server-name", required=True)
    parser.add_argument("--server-url", required=True)
    parser.add_argument("--hook-command", required=True)
    parser.add_argument(
        "--owned-suffix",
        nargs="+",
        required=True,
        dest="owned_suffixes",
        help="Command tails that mark a registration as ours, current and superseded alike.",
    )
    parser.add_argument("--events", nargs="*", default=[])
    parser.add_argument(
        "--matcher",
        nargs="*",
        default=[],
        dest="matchers",
        metavar="EVENT=REGEX",
        help="Per-event matcher regex; an event without one runs on every fire.",
    )
    parser.add_argument(
        "--daemon-event",
        nargs="*",
        default=[],
        dest="daemon_events",
        help="Events the daemon registers itself; left untouched here.",
    )
    args = parser.parse_args()
    main_with_args(
        cursor_dir=args.cursor_dir,
        server_name=args.server_name,
        server_url=args.server_url,
        hook_command=args.hook_command,
        owned_suffixes=args.owned_suffixes,
        events=args.events,
        matchers=parse_matchers(args.matchers),
        daemon_events=args.daemon_events,
    )
    print(
        f"cursor wiring updated: {args.server_name}, {' '.join(args.events)} -> {args.hook_command}"
    )


if __name__ == "__main__":
    main()
