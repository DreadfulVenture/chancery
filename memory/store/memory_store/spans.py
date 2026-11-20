"""Span-scoped logging context: every log line carries trace/parent/span ids.

Uses opentelemetry-api only (already in the venv via mcp) for W3C id
generation and context propagation — no SDK, no exporter. The log line on
span close IS the span record: `op=... span=... parent=... took_ms=...`
plus caller attrs (e.g. the embed origin tag). A wedged span never emits
its close line; the watchdog thread's OUTSTANDING print (age > threshold)
is the only visibility into it, with the origin that held it.
"""

from __future__ import annotations

import os
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any
from collections.abc import Iterator  # noqa: F401

try:  # opentelemetry-api ships via the mcp 2.0 dependency chain
    from opentelemetry import trace as otel_trace  # type: ignore
except ImportError:  # pragma: no cover - bare environments still work
    otel_trace = None


_LEVELS = {"debug": 10, "info": 20, "error": 40}
MIN_LEVEL = _LEVELS.get(os.environ.get("MEMORY_SPAN_LOG", "info").lower(), 20)
STUCK_SECS = float(os.environ.get("MEMORY_SPAN_STUCK_SECS", "30"))

# Log sinks: the daemon keeps the default (stdout under launchd); tests
# append a recorder. Replace venue-aware printf: append-only sinks keep the
# single-writer contract.
_sinks: list[Any] = [print]

_current: ContextVar = ContextVar("span_current", default=None)
_active: dict[int, dict[str, Any]] = {}
_activelock = threading.Lock()


def sink(func: Any) -> None:
    """Add a logger callable taking one string. Remove by identity via pop_sink."""
    _sinks.append(func)


def pop_sink(func: Any) -> None:
    try:
        _sinks.remove(func)
    except ValueError:
        pass


def _emit(level: str, text: str) -> None:
    order = _LEVELS.get(level, 20)
    if order < MIN_LEVEL:
        return
    # flush=True: under launchd, stdout to a regular file is block-buffered
    # (~8 KB), which delayed every post-boot span line — including the
    # watchdog's OUTSTANDING notices, the one print that must land instantly
    # when a span wedges.
    for output in _sinks:
        if output is print:
            print(text, flush=True)
        else:
            output(text)


def _stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _new_ids() -> tuple[str, str]:
    try:
        ctx = otel_trace.NonRecordingSpan(
            otel_trace.SpanContext(
                trace_id=int.from_bytes(os.urandom(16), "big"),
                span_id=int.from_bytes(os.urandom(8), "big"),
                is_remote=False,
            )
        ).get_span_context()
        return f"{ctx.trace_id:032x}", f"{ctx.span_id:016x}"
    except Exception:  # pragma: no cover - otel absent
        return os.urandom(8).hex() * 2, os.urandom(8).hex()


class Span:
    """A printable span: ids + attributes, never recorded/exported."""

    def __init__(self, name: str, **attrs: Any):
        self.name = name
        parent = _current.get()
        if parent:
            self.trace_id = parent.trace_id
        else:
            self.trace_id, _ = _new_ids()
        _, self.span_id = _new_ids()
        self.parent_id = parent.span_id if parent else None
        self.attrs: dict[str, Any] = dict(attrs)
        self.t0 = time.monotonic()
        self.done = False
        self.flagged = False  # watchdog has printed OUTSTANDING for this

    def set(self, **attrs: Any) -> None:
        self.attrs.update({k: v for k, v in attrs.items() if v is not None})

    def _line(self, level: str, prefix: str = "") -> str:
        parts = [f"op={self.name}", f"span={self.span_id}"]
        if self.trace_id:
            parts.append(f"trace={self.trace_id}")
        parts.append(f"parent={self.parent_id or '-'}")
        for key, val in sorted(self.attrs.items()):
            if key.startswith("due_after"):
                continue  # watchdog bookkeeping, not a caller attribute
            parts.append(f"{key}={val}")
        head = f"{_stamp()} level={level}"
        if prefix:
            head += f" {prefix}"
        return head + " " + " ".join(parts)

    def close(self, status: str = "ok", **rest: Any) -> None:
        if self.done:
            return
        self.done = True
        with _activelock:
            _active.pop(id(self), None)
        took = round((time.monotonic() - self.t0) * 1000.0)
        level = "error" if status == "error" else "info"
        self.set(status=status, took_ms=took, **rest)
        _emit(level, self._line(level))


@contextmanager
def span(name: str, **attrs: Any) -> Iterator[Span]:
    """Open a printable span; nested calls automatically parent to it."""
    # Only ids/nesting here matter: attributes get stamped by the caller
    # via span.set(), and close() prints the summary line.
    node = Span(name, **attrs)
    token = _current.set(node)
    with _activelock:
        _active[id(node)] = node
    try:
        yield node
        node.close()
    except Exception as error:
        node.close(status="error", error=repr(error)[:120])
        raise
    finally:
        _current.reset(token)


def debug(op: str, **attrs: Any) -> None:
    """A point observation, emitted only under MEMORY_SPAN_LOG=debug.

    Not a span: no timing and no nesting, just the values that were in play
    at a decision the surrounding spans do not explain on their own. It
    parents to the open span when there is one, so a debug line can be tied
    back to the request it came from.
    """
    if MIN_LEVEL > _LEVELS["debug"]:
        return
    node = _current.get()
    parts = [f"op={op}"]
    if node is not None:
        parts.append(f"span={node.span_id}")
    parts.extend(f"{key}={val}" for key, val in sorted(attrs.items()))
    _emit("debug", f"{_stamp()} level=debug " + " ".join(parts))


def outstanding_report() -> None:
    """Watchdog sweep: print every span that has been open past STUCK_SECS.

    A wedged span closes never, so its only record is here: the notice
    repeats every further STUCK_SECS while the span stays open."""
    now = time.monotonic()
    with _activelock:
        snapshot = list(_active.values())
    for node in snapshot:
        # Float age: the modulo-ish staleness checks compare raw, and sub-second
        # STUCK_SECS values (watchdog tests) stay meaningful.
        age = now - node.t0
        if age < STUCK_SECS:
            continue
        last = node.attrs.get("due_after", STUCK_SECS)
        if now < node.t0 + last:
            continue
        node.flagged = True
        node.attrs["due_after"] = age + STUCK_SECS
        _emit("error", node._line("error", f"OUTSTANDING age_s={age:.1f}"))


def start_watchdog(interval: float = 5.0) -> threading.Thread:
    """Monitor thread that surfaces wedged (never-closing) spans."""

    def loop() -> None:
        while True:
            outstanding_report()
            time.sleep(interval)

    thread = threading.Thread(target=loop, daemon=True, name="span-watchdog")
    thread.start()
    return thread
