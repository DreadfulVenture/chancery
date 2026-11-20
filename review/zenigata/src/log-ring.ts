/**
 * The narration ring (PRJ-461): the bounded in-memory store behind the
 * status page's log tail. One write path, two sinks — every narration
 * message composes its emitted line once (narrationLine in ctx.ts), the
 * console sink writes it to stdout/stderr for the unit's journald to
 * collect, and this ring stores the same line so the human page renders
 * the bot's own voice. The ring is memory only: nothing here touches a
 * file, and the store dies with the process — a restart starts from an
 * empty ring, and the page says so.
 *
 * The ring is the bot's voice only. The reviewer session's turns ride
 * the session driver and never pass through the logger, so nothing is
 * captured here from them; the page reads a retained session's turns
 * live through the driver's transcript read instead, and that read's
 * retention is the sweep's window, untouched.
 */

import { redactSecrets } from "./redact.js";

/** The ring holds at most this many lines; past it, the oldest drop. */
export const LOG_RING_LINE_LIMIT = 500;

/** The ring holds at most this many bytes; past it, the oldest lines drop. */
export const LOG_RING_BYTE_LIMIT = 65_536;

/**
 * The marker an oversized line carries: a single line longer than the
 * byte cap is truncated at capture, so the ring's total can never
 * exceed the cap and no line is silently cut.
 */
export const LOG_RING_TRUNCATION_MARKER =
  "[line truncated at the log ring's byte cap]";

const lineBytes = (line: string): number => Buffer.byteLength(line, "utf8");

/**
 * Cap one line to the byte bound, marker included. Cutting happens on
 * the UTF-8 bytes, so a multi-byte codepoint split at the boundary
 * decodes short — the stored line is then at or under the cap, never
 * over it.
 */
const capLine = (line: string): string => {
  const room = LOG_RING_BYTE_LIMIT - lineBytes(LOG_RING_TRUNCATION_MARKER);
  if (lineBytes(line) <= room) {
    return line;
  }
  const cut = Buffer.from(line, "utf8").subarray(0, room);
  return cut.toString("utf8") + LOG_RING_TRUNCATION_MARKER;
};

export class LogRing {
  private readonly lines: string[] = [];
  private bytes = 0;

  /**
   * Capture one emitted line. Redaction holds at capture: the
   * credentialed-URL machinery runs before storage — the composition
   * sites already redact their errors, so this is the belt under those
   * braces, the ring never carrying what the journal wouldn't. The
   * line is otherwise stored exactly as emitted: no timestamps, no
   * reformatting (journald owns the stamps).
   */
  push(line: string): void {
    const stored = capLine(redactSecrets(line));
    this.lines.push(stored);
    this.bytes += lineBytes(stored);
    while (
      this.lines.length > LOG_RING_LINE_LIMIT ||
      this.bytes > LOG_RING_BYTE_LIMIT
    ) {
      const dropped = this.lines.shift();
      if (dropped === undefined) {
        break;
      }
      this.bytes -= lineBytes(dropped);
    }
  }

  /** The stored lines, oldest first — the log tail the page renders. */
  tail(): string[] {
    return [...this.lines];
  }
}
