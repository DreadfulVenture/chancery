"""Scratch-root guard for the test suite — plugin-tests/sandbox.ts's Python
mirror. Imported FIRST by every test module, before daemon/store/hub/sync
bind their module constants: it relocates HOME and the XDG roots and points
every MEMORY_* location at one per-process scratch directory, so a suite
that forgets a path still degrades into scratch instead of into the
developer's live memory directory. RecordEmittingTools takes explicit
floor paths for exactly this reason (see its constructor comment); the
sandbox extends the same idea to everything a suite forgot to pass.

The daemon's module constants bind at import time, so import order is part
of the contract: `import sandbox` precedes `import daemon` / `from store
import ...` in each file. The tripwire test in test_daemon asserts the
constants actually resolved here.

Only locations live here. Whether a suite embeds (MEMORY_DISABLE_EMBEDDINGS,
stub embedders) is that suite's choice; the fastembed/uv caches resolve
through the relocated HOME and stay scratch.
"""

from __future__ import annotations

import os
import tempfile

ROOT = tempfile.mkdtemp(prefix="memory-tests-")


def _inside(value: str) -> bool:
    return value == ROOT or value.startswith(ROOT + os.sep)


_PATH_VARS = {
    "HOME": os.path.join(ROOT, "home"),
    "XDG_DATA_HOME": os.path.join(ROOT, "xdg", "data"),
    "XDG_CONFIG_HOME": os.path.join(ROOT, "xdg", "config"),
    "XDG_CACHE_HOME": os.path.join(ROOT, "xdg", "cache"),
    "MEMORY_DATA_DIR": os.path.join(ROOT, "memory", "data"),
    "MEMORY_QUEUE_DIR": os.path.join(ROOT, "memory", "queue"),
    "MEMORY_CURSOR_HOOKS_PATH": os.path.join(ROOT, "cursor-hooks.json"),
    "MEMORY_FLOOR_RULE_PATH": os.path.join(ROOT, "memory-floor-rule.md"),
}

for _name, _value in _PATH_VARS.items():
    if _name.startswith("XDG_") or _name == "HOME":
        base = _value.rsplit(os.sep, 1)[0]
        os.makedirs(base, exist_ok=True)
    os.environ[_name] = _value

# Refuse to run silently mis-homed: every location this module owns must be
# inside the scratch root, or the guarantee the import claims is false.
for _name, _value in _PATH_VARS.items():
    if not _inside(_value):
        raise AssertionError(f"sandbox: {_name!r} escaped the scratch root: {_value!r}")
