/**
 * The narration ring (PRJ-461): capture, the line and byte bounds,
 * redaction at capture, and the narrating logger's one-write-path
 * fan-out. Memory only — nothing here touches a file; the logging
 * surface's own tests pin that from the state dir's side.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NARRATION_PREFIX,
  consoleLogger,
  narratingLogger,
} from "../src/ctx.js";
import {
  LogRing,
  LOG_RING_BYTE_LIMIT,
  LOG_RING_LINE_LIMIT,
  LOG_RING_TRUNCATION_MARKER,
} from "../src/log-ring.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const lineBytes = (line: string): number => Buffer.byteLength(line, "utf8");

const tailBytes = (lines: string[]): number =>
  lines.reduce((sum, line) => sum + lineBytes(line), 0);

describe("the narration ring", () => {
  it("stores the lines pushed into it, oldest first, and hands out a copy", () => {
    const ring = new LogRing();
    expect(ring.tail()).toEqual([]);
    ring.push("zenigata: first");
    ring.push("zenigata: second");
    expect(ring.tail()).toEqual(["zenigata: first", "zenigata: second"]);

    // The tail is a copy: a caller mutating it cannot corrupt the store.
    ring.tail().push("tampered");
    expect(ring.tail()).toHaveLength(2);
  });

  it("caps the stored lines by count, dropping the oldest", () => {
    const ring = new LogRing();
    const pushed = LOG_RING_LINE_LIMIT + 50;
    for (let n = 1; n <= pushed; n++) {
      ring.push(`zenigata: line ${n}`);
    }
    const tail = ring.tail();
    expect(tail).toHaveLength(LOG_RING_LINE_LIMIT);
    expect(tail[0]).toBe("zenigata: line 51");
    expect(tail[tail.length - 1]).toBe(`zenigata: line ${pushed}`);
  });

  it("caps the stored lines by bytes, dropping the oldest whole lines", () => {
    const ring = new LogRing();
    const line = `zenigata: ${"x".repeat(4000)}`;
    for (let n = 1; n <= 100; n++) {
      ring.push(`${line} ${n}`);
    }
    const tail = ring.tail();
    expect(tail.length).toBeGreaterThan(0);
    expect(tailBytes(tail)).toBeLessThanOrEqual(LOG_RING_BYTE_LIMIT);
    // Whole lines only: no stored line is a fragment of another.
    for (const stored of tail) {
      expect(stored.startsWith(line)).toBe(true);
    }
    // The newest line survived the drops.
    expect(tail[tail.length - 1].endsWith("100")).toBe(true);
  });

  it("truncates a single line longer than the byte cap, marker and all", () => {
    const ring = new LogRing();
    ring.push(`zenigata: ${"y".repeat(100_000)}`);
    const tail = ring.tail();
    expect(tail).toHaveLength(1);
    expect(tailBytes(tail)).toBeLessThanOrEqual(LOG_RING_BYTE_LIMIT);
    expect(tail[0]?.endsWith(LOG_RING_TRUNCATION_MARKER)).toBe(true);
    // The store stays within its bound from here on: the truncated line
    // is the whole store, and more lines drop it out the old end.
    ring.push("zenigata: after the giant line");
    expect(tailBytes(ring.tail())).toBeLessThanOrEqual(LOG_RING_BYTE_LIMIT);
    expect(ring.tail()[ring.tail().length - 1]).toBe(
      "zenigata: after the giant line",
    );
  });

  it("caps a line whose cut lands mid-codepoint at the boundary, under the byte cap", () => {
    const ring = new LogRing();
    // room = LIMIT - marker; the one-byte spacer shifts the three-byte
    // codepoints so the cut lands inside one. The unfixed cap paid the
    // dangle back as a 3-byte replacement character: the stored line
    // exceeded its own cap, and the eviction loop dropped it — the
    // store died empty.
    const room = LOG_RING_BYTE_LIMIT - lineBytes(LOG_RING_TRUNCATION_MARKER);
    ring.push(`x${"日".repeat(Math.ceil((room - 1) / 3))}`);
    const tail = ring.tail();
    expect(tail).toHaveLength(1);
    expect(lineBytes(tail[0] as string)).toBeLessThanOrEqual(
      LOG_RING_BYTE_LIMIT,
    );
    // The boundary trim dropped the partial codepoint: no replacement
    // character rode the cut.
    expect(tail[0]).not.toContain("\uFFFD");
    expect(tail[0]?.endsWith(LOG_RING_TRUNCATION_MARKER)).toBe(true);
  });

  it("redacts a credentialed URL at capture, before storage", () => {
    const ring = new LogRing();
    ring.push(
      "zenigata: clone https://user:hunter2-clone@forge.invalid/x failed",
    );
    ring.push("zenigata: fetch http://forge.invalid/x?token=shh-query died");
    const joined = ring.tail().join("\n");
    expect(joined).toContain("https://forge.invalid/x failed");
    expect(joined).toContain("http://forge.invalid/x?token=[redacted] died");
    expect(joined).not.toContain("hunter2-clone");
    expect(joined).not.toContain("shh-query");
  });
});

describe("the narrating logger", () => {
  it("one write path, two sinks: the ring stores the exact line the console sink emits", () => {
    const ring = new LogRing();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = narratingLogger(ring, consoleLogger);
    logger.info("intake listening on port 8471");
    logger.error("review failed for acme/widget#1");

    expect(ring.tail()).toEqual([
      `${NARRATION_PREFIX}intake listening on port 8471`,
      `${NARRATION_PREFIX}review failed for acme/widget#1`,
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      `${NARRATION_PREFIX}intake listening on port 8471`,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      `${NARRATION_PREFIX}review failed for acme/widget#1`,
    );
  });

  it("captures once per emission, before the sink writes its own copy", () => {
    const ring = new LogRing();
    const sinkCalls: string[] = [];
    const logger = narratingLogger(ring, {
      info: (message) => sinkCalls.push(message),
      error: (message) => sinkCalls.push(message),
    });
    logger.info("a line for both sinks");
    // The injected sink composes its own rendering from the raw
    // message; the ring stores the canonical emitted line.
    expect(sinkCalls).toEqual(["a line for both sinks"]);
    expect(ring.tail()).toEqual(["zenigata: a line for both sinks"]);
  });
});
