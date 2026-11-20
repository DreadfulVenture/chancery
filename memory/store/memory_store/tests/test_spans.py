"""Span-context logging: nesting, attributes, idempotence, watchdog.

A recorder sink captures printed lines instead of stdout, per the
spans-in-logs contract: ids nest, attrs land on the close line, and a
never-closing span surfaces only through OUTSTANDING notices.
"""

from __future__ import annotations

import re
import time
import unittest

import sandbox  # noqa: E402,F401 -- scratch-root guard, precedes the module constants below
from memory_store import spans


class RecordingSink:
    def __init__(self):
        self.lines: list[str] = []
        spans.sink(self.append)
        self.levels = spans.MIN_LEVEL
        spans.MIN_LEVEL = 0

    def append(self, text):
        self.lines.append(text)

    def ops(self, name):
        return [line for line in self.lines if name in line]

    def close(self):
        spans.pop_sink(self.append)
        spans.MIN_LEVEL = self.levels


class SpanPrintTests(unittest.TestCase):
    def setUp(self):
        self.sink = RecordingSink()
        self.addCleanup(self.sink.close)

    def test_close_line_carries_ids_and_attrs(self):
        with spans.span("memory.embed", origin="upsert-capture", texts=3) as node:
            node.set(cache_hits=1, chunks=1)
        self.assertEqual(len(self.sink.ops("memory.embed")), 1)
        line = self.sink.ops("memory.embed")[0]
        self.assertIn("origin=upsert-capture", line)
        self.assertIn("texts=3", line)
        self.assertIn("cache_hits=1", line)
        self.assertRegex(line, r"span=[0-9a-f]{16}")
        self.assertRegex(line, r"trace=[0-9a-f]{32}")
        self.assertIn("status=ok", line)
        self.assertRegex(line, r"took_ms=\d+")

    def test_nesting_parents_and_shares_trace(self):
        with spans.span("outer"):
            with spans.span("memory.embed", origin="debounce"):
                pass
        parent_line = [line for line in self.sink.ops("outer")][0]
        inner_line = [line for line in self.sink.ops("memory.embed")][0]

        outer_span = re.search(r"span=([0-9a-f]{16})", parent_line).group(1)
        outer_trace = re.search(r"trace=([0-9a-f]{32})", parent_line).group(1)
        self.assertIn(f"parent={outer_span}", inner_line)
        self.assertIn(f"trace={outer_trace}", inner_line)
        self.assertIn("origin=debounce", inner_line)

    def test_error_status_on_close(self):
        with self.assertRaises(RuntimeError):
            with spans.span("memory.embed", origin="x"):
                raise RuntimeError("onnx wedged")
        line = self.sink.ops("memory.embed")[0]
        self.assertIn("status=error", line)
        self.assertIn("onnx wedged", line)


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.sink = RecordingSink()
        self.addCleanup(self.sink.close)
        self.restore = spans.STUCK_SECS
        spans.STUCK_SECS = 0.05
        self.addCleanup(setattr, spans, "STUCK_SECS", self.restore)

    def test_outstanding_appears_and_age_grows(self):
        # A span abandoned open (the wedge shape): no close line ever, the
        # watchdog keeps flagging with growing age.
        node = spans.Span("memory.embed", origin="upsert-capture", texts=1)
        spans._active[id(node)] = node
        spans.outstanding_report()
        self.assertEqual(self.sink.ops("OUTSTANDING"), [])
        time.sleep(0.07)
        spans.outstanding_report()
        self.assertEqual(len(self.sink.ops("OUTSTANDING")), 1)
        age_first = float(self.sink.ops("OUTSTANDING")[0].split("age_s=")[1].split(" ")[0])
        time.sleep(0.1)
        spans.outstanding_report()
        outstanding = self.sink.ops("OUTSTANDING")
        self.assertEqual(len(outstanding), 2)
        age_second = float(outstanding[1].split("age_s=")[1].split(" ")[0])
        self.assertGreater(age_second, age_first)
        spans._active.pop(id(node))


if __name__ == "__main__":
    unittest.main()
