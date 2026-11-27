/**
 * The transcript views: the session driver's turns rendered into the
 * capped, redacted text the page's session-log and failed-run rows show,
 * plus the page row assembly that reads them live (or from the failed
 * rows' frozen-session cache).
 *
 * Rendering rules: every text piece routes through redactSecrets before
 * its cap — a cap cut through a credential before its "@" would strand
 * the fragment with nothing for the redaction patterns to match — and
 * the caps bound each piece before the view cap's turn math runs.
 */

import { capUtf8 } from "./utf8-cap.js";
import { redactSecrets } from "./redact.js";
import { withTimeout } from "./with-timeout.js";
import { isSessionAlreadyGone } from "./sweep.js";
import type { SessionDriver, SessionTurn } from "./contracts/session.js";
import type {
  RunDraftsView,
  SessionLiveView,
  SessionStartView,
  TranscriptView,
} from "./page.js";

/**
 * How long one transcript read may wait for the session driver: a page
 * render must not hang on a runtime that never answers. Bounded like
 * the adapter probe above. The bound cancels the read rather than
 * abandoning it: the controller's abort rides the driver's own signal
 * (the contract's opts.signal), so a hung runtime's in-flight request
 * stops at the bound.
 */
const TRANSCRIPT_READ_TIMEOUT_MS = 2000;

/** The transcript view's byte cap, composed at read time. */
export const TRANSCRIPT_VIEW_CAP = 65_536;
export const TRANSCRIPT_TURN_MARKER =
  "[turn truncated at the page's transcript cap]";

/**
 * The tool block's own sub-caps (PRJ-538): one huge tool input or output
 * must not consume the view's whole byte budget, or the composer would
 * drop every older turn behind it. The caps bound each piece before the
 * view cap's turn math runs.
 */
export const TOOL_INPUT_CAP = 512;
export const TOOL_OUTPUT_CAP = 2048;
export const TOOL_ERROR_CAP = 1024;
const TOOL_PIECE_MARKER = "[cut at the page's cap]";

/** The glance line's byte cap: the live row's newest-activity summary. */
export const SESSION_LOG_GLANCE_CAP = 200;

/**
 * The stamp one rendered line starts with, the record's created moment
 * in the server's local time — a turn-by-turn log reads as one when its
 * lines carry when. An unstamped turn (the double's at 0, or a record
 * whose stamp did not parse) renders bare.
 */
const stampPrefix = (at: number): string => {
  if (!Number.isFinite(at) || at <= 0) {
    return "";
  }
  const stamp = new Date(at);
  if (Number.isNaN(stamp.getTime())) {
    return "";
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `[${pad(stamp.getHours())}:${pad(stamp.getMinutes())}:${pad(stamp.getSeconds())}] `;
};

/**
 * One piece's bounded text: redacted FIRST, then capped — the same
 * credentialed-URL rule the turn text follows. A cap cut through a
 * credential before its "@" would strand the fragment with nothing for
 * the redaction patterns to match.
 */
const capPiece = (text: string, cap: number): string => {
  const room = cap - Buffer.byteLength(TOOL_PIECE_MARKER, "utf8");
  if (Buffer.byteLength(text, "utf8") <= room) {
    return text;
  }
  return capUtf8(text, room) + TOOL_PIECE_MARKER;
};

/**
 * One turn's rendered block. Prompts and replies render as their
 * existing prefixed lines, stamps ahead; a tool call renders as a small
 * block — the status line, the input summary, and the output head or
 * error — and a subagent report renders like a reply under its own
 * prefix. Every text piece routes through redactSecrets before its cap,
 * and the prefix budget rides the cap's math.
 */
const transcriptTurnText = (turn: SessionTurn): string => {
  const stamp = stampPrefix(turn.at);
  if (turn.role === "tool") {
    const lines = [`${stamp}tool ${turn.name} — ${turn.status}`];
    if (turn.input !== "") {
      lines.push(
        `    input: ${capPiece(redactSecrets(turn.input), TOOL_INPUT_CAP)}`,
      );
    }
    if (turn.output !== "") {
      lines.push(
        `    output: ${capPiece(redactSecrets(turn.output), TOOL_OUTPUT_CAP)}`,
      );
    }
    if (turn.error !== undefined && turn.error !== "") {
      lines.push(
        `    error: ${capPiece(redactSecrets(turn.error), TOOL_ERROR_CAP)}`,
      );
    }
    return lines.join("\n");
  }
  const prefix =
    turn.role === "user"
      ? "user: "
      : turn.role === "report"
        ? "report: "
        : "reviewer: ";
  return `${stamp}${prefix}${capTurnText(redactSecrets(turn.text), `${stamp}${prefix}`)}`;
};

const capTurnText = (text: string, prefix: string): string => {
  const room =
    TRANSCRIPT_VIEW_CAP -
    Buffer.byteLength(TRANSCRIPT_TURN_MARKER, "utf8") -
    Buffer.byteLength(prefix, "utf8");
  if (Buffer.byteLength(text, "utf8") <= room) {
    return text;
  }
  // The cut walks back to a codepoint boundary (capUtf8): a dangle the
  // decoder paid back as a replacement character would inflate the
  // rendered line past the view cap, and an over-cap line drops whole
  // in the composer below — the newest turn would vanish from the view
  // because it was merely huge.
  return capUtf8(text, room) + TRANSCRIPT_TURN_MARKER;
};

/**
 * Compose the found state: the turns rendered oldest first, the total
 * held under the byte cap by dropping the oldest whole turns (a
 * diagnosis reads the run's last turns first), each turn bounded by its
 * own cap pieces so even a diff-sized prompt or a huge tool output
 * fits. The truncated flag says whole turns were cut at the old end,
 * and `latest` carries the newest turn's first rendered line — the live
 * row's glance, capped to its own budget. Exported for the tests — the
 * cap's boundary math is pinned at unit grain.
 */
export const composeTranscriptView = (turns: SessionTurn[]): TranscriptView => {
  const rendered = turns.map(transcriptTurnText);
  const keptNewestFirst: string[] = [];
  let bytes = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const line = rendered[i] as string;
    const lineBytes =
      Buffer.byteLength(line, "utf8") + (keptNewestFirst.length === 0 ? 0 : 2);
    if (bytes + lineBytes > TRANSCRIPT_VIEW_CAP) {
      break;
    }
    keptNewestFirst.push(line);
    bytes += lineBytes;
  }
  keptNewestFirst.reverse();
  const newest = keptNewestFirst.at(-1);
  const latest =
    newest === undefined
      ? undefined
      : capUtf8(newest.split("\n")[0] ?? "", SESSION_LOG_GLANCE_CAP);
  return {
    state: "found",
    text: keptNewestFirst.join("\n\n"),
    truncated: keptNewestFirst.length < rendered.length,
    latest,
  };
};

/**
 * One run's transcript view, read live through the session driver: the
 * session's turns while it stands; the gone note when the driver
 * answers that the session is not found — a swept session, the
 * retention sweep being the usual hand, though the note does not
 * attribute it (a 404 from a proxy or a stopped runtime reads the
 * same); the unavailable note when the read failed for any other
 * reason. Verified against the pinned client (2.2.5): message.list
 * declares 404 among its statuses and throws the service's tagged
 * SessionNotFoundError for it, so a disposed session's read fails —
 * it never answers an empty turn list.
 */
export const readTranscriptView = async (
  sessionId: string,
  sessions: SessionDriver,
): Promise<TranscriptView> => {
  let turns: SessionTurn[];
  // The bound cancels, not abandons: the abort rides the driver's own
  // signal, so a hung runtime's in-flight request stops with the bound.
  const abort = new AbortController();
  try {
    turns = await withTimeout(
      sessions.transcript(sessionId, { signal: abort.signal }),
      TRANSCRIPT_READ_TIMEOUT_MS,
      () => abort.abort(),
    );
  } catch (error) {
    return isSessionAlreadyGone(error)
      ? { state: "swept" }
      : { state: "unavailable" };
  }
  return composeTranscriptView(turns);
};

/**
 * The composed transcript views, cached per session. A failed run's
 * session is frozen between settle and sweep — its turns cannot change —
 * so composing the view again on every page view re-issues a live
 * driver read per failed row in the window for a text that cannot
 * change. Each entry keys on the session id and holds the view beside
 * the row outcome it was read under, so a settlement that flips the
 * projection row under the same session id (the retry policy's one
 * re-run re-sets the row it re-ran) re-reads instead of serving a stale
 * view. Two invalidations keep it honest: the sweeper drops the entry
 * when its pass reports the session gone — the one moment the composed
 * text can change, the view flipping to swept — and each render prunes
 * entries whose session no row in the window carries anymore. Only the
 * settled answers cache (found, swept): an unavailable read is a
 * transient fact and stays uncached, so the next view retries it the
 * way the uncached page always did. The reads still run in parallel,
 * each bounded, and every row renders exactly as before — all of it is
 * page-only render data, /status's pinned shape gains nothing.
 */
interface TranscriptCacheEntry {
  outcome: string;
  view: TranscriptView;
}

export type { TranscriptCacheEntry };

export const pageRunRows = async (
  rows: RunDraftsView[],
  sessions: SessionDriver,
  cache: Map<string, TranscriptCacheEntry>,
): Promise<RunDraftsView[]> => {
  const rendered = await Promise.all(
    rows.map(async (row) => {
      if (row.failure === undefined || row.sessionId === undefined) {
        return row;
      }
      const cached = cache.get(row.sessionId);
      if (cached !== undefined && cached.outcome === row.outcome) {
        return { ...row, transcript: cached.view };
      }
      const view = await readTranscriptView(row.sessionId, sessions);
      if (view.state !== "unavailable") {
        cache.set(row.sessionId, { outcome: row.outcome, view });
      }
      return { ...row, transcript: view };
    }),
  );
  // The runs window bounds the cache: an entry whose session no row in
  // this render carries has left the window and drops here.
  const windowSessions = new Set(
    rows.flatMap((row) => (row.sessionId === undefined ? [] : [row.sessionId])),
  );
  for (const sessionId of cache.keys()) {
    if (!windowSessions.has(sessionId)) {
      cache.delete(sessionId);
    }
  }
  return rendered;
};

/**
 * The live rows' session log views, read through the session driver at
 * each render (PRJ-538). A running review's log changes between
 * renders, so nothing here is cached — the failed rows' cache below
 * exists precisely because their sessions are frozen, and a live row is
 * the opposite. Each read is bounded by the same read-timeout as the
 * failed rows' reads and runs in parallel with them; a row whose run
 * has not created its session yet (parked, or still in the git stage)
 * passes through unchanged.
 */
export const pageLiveRows = async (
  rows: SessionStartView[],
  sessions: SessionDriver,
): Promise<SessionLiveView[]> =>
  Promise.all(
    rows.map(async (row) => {
      if (row.sessionId === undefined) {
        return row;
      }
      return { ...row, log: await readTranscriptView(row.sessionId, sessions) };
    }),
  );
