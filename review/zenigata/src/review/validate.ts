/**
 * Extraction of the JSON value out of raw model output: the last fenced
 * \`\`\`json block if present, else the last balanced top-level object,
 * carrying the real parse refusal when the pull fails, and running the
 * local transposition repair (repair.ts) before any fallback can name
 * "undefined". The reply loop's corrective retry consumes the refusal.
 */

import { repairTransposedEscapes } from "./repair.js";

export type ExtractRoute = "fenced" | "brace-scan";

/** A successful extract: the parsed value and how it was recovered. */
export type ExtractSuccess = {
  ok: true;
  value: unknown;
  route: ExtractRoute;
  repaired: boolean;
};

/** A parse refusal: the real JSON.parse message and the candidate's route. */
export type ExtractParseRefusal = {
  ok: false;
  kind: "parse-error";
  route: ExtractRoute;
  /** JSON.parse's own refusal for the reply's text. */
  error: string;
  /** True when a local transposition repair pass was applied and the candidate still refused. */
  repaired: boolean;
};

/**
 * One extract outcome. A parse refusal is carried, never swallowed: the
 * JSON.parse message and the route that produced the candidate text ride
 * along, so the corrective retry names the real break instead of the zod
 * "expected object, received undefined" ghost. A reply with no JSON span
 * at all is its own outcome (PRJ-381).
 */
export type ExtractResult =
  | ExtractSuccess
  | ExtractParseRefusal
  | { ok: false; kind: "no-json" };

export type ExtractFailure = Exclude<ExtractResult, ExtractSuccess>;

/**
 * The compact parse-refusal text the journal's failed-attempt entries
 * carry: the raw JSON.parse message, or the fixed no-JSON marker.
 */
export function parseRefusalMessage(failure: ExtractFailure): string {
  return failure.kind === "no-json"
    ? "no JSON found in the reply"
    : failure.error;
}

/**
 * The validation bullet a parse refusal contributes to a corrective
 * retry prompt: which route produced the candidate, what JSON.parse
 * actually said, and whether the local repair already failed.
 */
export function parseRefusalLine(failure: ExtractFailure): string {
  if (failure.kind === "no-json") {
    return "no JSON found in the reply: no fenced ```json block and no JSON object in the text";
  }
  const source =
    failure.route === "fenced"
      ? "the fenced ```json block"
      : "the balanced-brace scan";
  const repairNote = failure.repaired
    ? "; a local repair pass for the observed backslash transposition did not recover it"
    : "";
  return `the reply is not valid JSON (captured from ${source}): ${failure.error}${repairNote}`;
}

/** The rejected output's head a corrective retry prompt carries. */
export const REPLY_HEAD_LIMIT = 200;
const REPLY_HEAD_TRUNCATION_MARKER = "\n[head truncated]";

/** The first bytes of a rejected output, cut at the retry-prompt cap. */
export function outputHead(text: string): string {
  if (text.length <= REPLY_HEAD_LIMIT) {
    return text;
  }
  return text.slice(0, REPLY_HEAD_LIMIT) + REPLY_HEAD_TRUNCATION_MARKER;
}

/**
 * The last balanced top-level span in the text (strings and escapes
 * respected): the brace-scan half of the extract step.
 */
function lastBalancedSpan(text: string): string | undefined {
  let depth = 0;
  let start = -1;
  let lastSpan: string | undefined;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        lastSpan = text.slice(start, i + 1);
        start = -1;
      }
      if (depth < 0) {
        depth = 0;
      }
    }
  }
  return lastSpan;
}

function parseCandidate(
  candidate: string,
  route: ExtractRoute,
): ExtractSuccess | ExtractParseRefusal {
  try {
    const value = JSON.parse(candidate);
    return { ok: true, value, route, repaired: false };
  } catch (error) {
    return {
      ok: false,
      kind: "parse-error",
      route,
      error: error instanceof Error ? error.message : String(error),
      repaired: false,
    };
  }
}

/**
 * Extract the JSON value from a raw model reply, in the order the
 * fallback routes run: parse → on refusal, a local transposition repair,
 * re-parse. The routes follow the reply's own shapes: the last fenced
 * ```json block wins when present, else the last balanced top-level
 * object (strings and escapes respected).
 *
 * The repair is deliberately narrow (repair.ts): it fixes the one
 * transposition the review pipeline's own model output has been observed
 * to emit. It runs before any model retry, so a repairable reply ends
 * the stage with no model traffic, and a refusal keeps the real
 * JSON.parse error for the corrective retry. When the brace scan finds
 * no balanced span at all, the same repair runs over the full reply
 * first and the scan repeats: the transposition deranges the scan's
 * string state exactly as it breaks the parse, so "no JSON found" can
 * only be declared after the reply had a fair look.
 */
export function extractJsonDetailed(text: string): ExtractResult {
  // Route 1: the last fenced ```json block.
  const fenced = /```json\s*\n([\s\S]*?)```/g;
  let lastFenced: string | undefined;
  for (let m = fenced.exec(text); m !== null; m = fenced.exec(text)) {
    lastFenced = m[1];
  }
  let fencedRefusal: ExtractResult | undefined;
  if (lastFenced !== undefined) {
    const attempt = parseCandidate(lastFenced, "fenced");
    if (attempt.ok) {
      return attempt;
    }
    // A code fence inside a JSON string value truncates the fenced
    // match, so the captured slice can fail to parse even when the
    // model's full reply is valid; fall through to the balanced-brace
    // scan, which still sees the whole object in the surrounding text.
    // The refusal is kept in case the scan cannot produce a candidate
    // either: a fenced candidate that refused to parse is still the
    // reply's parse outcome, not "no JSON found".
    fencedRefusal = attempt;
  }

  // Route 2: the balanced-brace scan.
  const span = lastBalancedSpan(text);
  if (span !== undefined) {
    const attempt = parseCandidate(span, "brace-scan");
    if (attempt.ok) {
      return attempt;
    }
    const repaired = repairTransposedEscapes(span);
    if (repaired.changed) {
      const retry = parseCandidate(repaired.text, "brace-scan");
      if (retry.ok) {
        return { ...retry, repaired: true };
      }
    }
    return { ...attempt, repaired: repaired.changed };
  }

  // No span at all: the scan's string state is deranged by the same
  // transposition that breaks the parse, so repair the full reply and
  // scan once more before any retry can be composed.
  const rescued = repairTransposedEscapes(text);
  if (rescued.changed) {
    const span = lastBalancedSpan(rescued.text);
    if (span !== undefined) {
      const attempt = parseCandidate(span, "brace-scan");
      if (attempt.ok) {
        return { ...attempt, repaired: true };
      }
      // The repaired scan yields a candidate that refuses: a second
      // repair pass is idempotent over repaired text, so report the
      // refusal.
      return { ...attempt, repaired: true };
    }
  }
  return fencedRefusal ?? { ok: false, kind: "no-json" };
}
