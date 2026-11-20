"""The command contract every mcp_commands module defines tools against.

A Command carries everything one tool is: its name, the description an
agent reads, the pydantic model its arguments validate against (which is
also the schema the MCP surface publishes), and the handler that runs.
Handlers are plain functions over an injected ToolContext — no base
class, no subclass overriding to add side effects; the daemon composes
one context at boot and every command receives it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from collections.abc import Callable

from pydantic import BaseModel

from memory_store.store import Store

# A mutation's sync-record emitter (daemon-injected): kind, payload,
# optional record id. Commands that never mutate never call it; the
# default is the no-op a hub-less deployment runs. Returns True when the
# enqueue path was satisfied (same contract as daemon._emit).
EmitHook = Callable[[str, dict, str | None], bool]

# Post-mutation renders the daemon owns (floor, Cursor matcher): fired
# after any command that changed publishable state.
WriteHook = Callable[[], None]


@dataclass(frozen=True)
class ToolContext:
    store: Store
    machine_id: str
    emit: EmitHook = lambda kind, payload, record_id=None: True
    on_write: WriteHook = lambda: None


@dataclass(frozen=True)
class Command:
    name: str
    description: str
    model: type[BaseModel]
    handle: Callable[[ToolContext, Any], dict]

    def json_schema(self) -> dict:
        return self.model.model_json_schema()


def commands(*items: Command) -> tuple[Command, ...]:
    """A module's exported command set: the tuple consumers iterate."""
    return items
