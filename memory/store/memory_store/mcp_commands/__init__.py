"""The store's MCP command surface, scoped by domain.

Each module defines its commands against mcp_commands.command.Command —
name, description, pydantic input model (validation and the published
schema from one definition), handler — and exports them via
commands(...). This file is barrel exports only.
"""

from memory_store.mcp_commands import tool_rule
from memory_store.mcp_commands.command import Command, ToolContext
from memory_store.tools import ToolError

TOOL_RULE_COMMANDS = tool_rule.COMMANDS

__all__ = ["TOOL_RULE_COMMANDS", "Command", "ToolContext", "ToolError"]
