"""The memory-store application: the daemon and hub, sync, and the store.

Modules group as the app composes them: ``server/`` holds the two entry
points (the daemon serving the MCP surface, the hub serving the record
log), ``consolidation/`` the hub and client summarize loops, and
``mcp_commands/`` the command surface's domain modules; the rest are
single-module surfaces (capture, sync, recall, nudge, kb, curated rules,
tools) over the ``store``/``spans`` base.
"""
