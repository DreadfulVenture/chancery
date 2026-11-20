/**
 * Validation of session output into a postable review payload.
 *
 * Three layers:
 *   - extractJsonDetailed: pull the JSON value out of raw model output
 *     (last fenced ```json block if present, else the last balanced
 *     top-level object), carrying the real parse refusal when the pull
 *     fails, and running the local transposition repair (repair.ts)
 *     before any fallback can name "undefined".
 *   - repairTransposedEscapes (repair.ts): the deliberately narrow local
 *     fix for the observed transposed-escape failure mode.
 *   - validateReview: zod shape plus the rules that keep a review
 *     postable: comment anchors inside the diff's new-side hunks, the
 *     Agent-generated Conventional Comments header, and
 *     blocking/verdict consistency.
 */

import { z } from "zod";
import type { InlineComment, Verdict } from "../contracts/forge.js";
import type { DroppedComment, VerdictReconciliation } from "../journal.js";
import { repairTransposedEscapes } from "./repair.js";

export interface DiffFile {
  path: string;
  /** Inclusive new-side line ranges covered by the hunks. */
  ranges: Array<[number, number]>;
  /**
   * The old-side paths the diff names for this file (`--- a/old` and
   * `rename from old`), so a comment written against the rename's old
   * path still resolves onto the new-side file.
   */
  oldPaths: string[];
}

/**
 * Decode a git C-quoted path: `core.quotepath` (the default) wraps paths
 * containing non-ASCII bytes, double quotes, or control characters in
 * double quotes and escapes them (`\303\251` octal bytes, `\"`, `\\`,
 * `\a \b \f \n \r \t \v`). The quoted form never matches the model's
 * unquoted path, so decode it back to the raw bytes' UTF-8 text.
 */
function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) {
    return path;
  }
  const body = path.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(ch.charCodeAt(0) & 0xff);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      // A lone trailing backslash is not a real git quoting shape; keep
      // it as a literal backslash.
      bytes.push(0x5c);
      break;
    }
    if (next >= "0" && next <= "7") {
      // Octal escape: one to three octal digits, one byte each.
      let digits = next;
      i++;
      while (digits.length < 3) {
        const d = body[i + 1];
        if (d === undefined || d < "0" || d > "7") {
          break;
        }
        digits += d;
        i++;
      }
      bytes.push(parseInt(digits, 8) & 0xff);
      continue;
    }
    switch (next) {
      case '"':
        bytes.push(0x22);
        break;
      case "\\":
        bytes.push(0x5c);
        break;
      case "a":
        bytes.push(0x07);
        break;
      case "b":
        bytes.push(0x08);
        break;
      case "f":
        bytes.push(0x0c);
        break;
      case "t":
        bytes.push(0x09);
        break;
      case "n":
        bytes.push(0x0a);
        break;
      case "v":
        bytes.push(0x0b);
        break;
      case "r":
        bytes.push(0x0d);
        break;
      default:
        bytes.push(next.charCodeAt(0) & 0xff);
    }
    i++;
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/**
 * Drop the diff prefixes a model copies into a comment's path.
 */
function stripDiffPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

/**
 * Parse a unified diff into per-file new-side hunk ranges.
 */
export function parseDiffHunks(diff: string): Map<string, DiffFile> {
  const files = new Map<string, DiffFile>();
  let current: DiffFile | undefined;
  /** Old-side paths seen so far in the current file's block. */
  let oldPaths: string[] = [];
  const lines = diff.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      current = undefined;
      oldPaths = [];
      i++;
      continue;
    }
    if (line.startsWith("rename from ")) {
      // A rename's old path, printed without the a/ b/ prefixes; it may
      // be quoted like any path containing non-ASCII bytes.
      const target = line.slice("rename from ".length).trim();
      if (target.startsWith('"')) {
        oldPaths.push(stripDiffPrefix(unquoteGitPath(target)));
      } else if (target !== "" && target !== "/dev/null") {
        oldPaths.push(target);
      }
      i++;
      continue;
    }
    if (line.startsWith("--- ")) {
      let target = line.slice(4).trim();
      if (target === "/dev/null" || target === "") {
        // A purely added file has no old side.
      } else {
        if (target.startsWith('"')) {
          target = unquoteGitPath(target);
        }
        let oldPath = stripDiffPrefix(target);
        if (
          oldPath.startsWith('"') &&
          oldPath.endsWith('"') &&
          oldPath.length >= 2
        ) {
          oldPath = unquoteGitPath(oldPath);
        }
        oldPaths.push(oldPath);
      }
      i++;
      continue;
    }
    if (line.startsWith("+++ ")) {
      let target = line.slice(4).trim();
      if (target === "/dev/null" || target === "") {
        oldPaths = [];
        current = undefined;
      } else {
        if (target.startsWith('"')) {
          target = unquoteGitPath(target);
        }
        let path = stripDiffPrefix(target);
        if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
          path = unquoteGitPath(path);
        }
        // The block's accumulated old-side paths attach to the entry the
        // +++ line creates; git prints no ---/+++ pair for a contentless
        // rename, which therefore gains no entry (a comment on it has no
        // new-side line to anchor on either way).
        current = { path, ranges: [], oldPaths: [...new Set(oldPaths)] };
        oldPaths = [];
        files.set(current.path, current);
      }
      i++;
      continue;
    }
    if (line.startsWith("@@ ")) {
      const header = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (header && current) {
        const newStart = Number(header[3]);
        const newCount = header[4] === undefined ? 1 : Number(header[4]);
        if (newCount > 0) {
          current.ranges.push([newStart, newStart + newCount - 1]);
        }
        // Walk the hunk body off per side rather than sniffing for the
        // next header, since an added line may itself start with "++ ".
        // A context line counts on both sides but appears once, so the
        // body holds oldCount + newCount minus its context lines;
        // counting oldCount + newCount lines flat overran every hunk
        // that carried context and consumed the next hunk's @@ header,
        // losing its ranges (PRJ-428: every second hunk of a multi-hunk
        // diff vanished and valid anchors were refused as outside the
        // changed lines). "\ No newline at end of file" markers sit
        // inside the body but belong to neither count; skip them
        // without consuming the tally.
        const oldCount = header[2] === undefined ? 1 : Number(header[2]);
        let oldRemaining = oldCount;
        let newRemaining = newCount;
        i++;
        while (i < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
          const bodyLine = lines[i];
          if (bodyLine.startsWith("\\")) {
            i++;
            continue;
          }
          if (bodyLine.startsWith("+")) {
            newRemaining--;
          } else if (bodyLine.startsWith("-")) {
            oldRemaining--;
          } else {
            // A context line (leading space; some emitters drop the
            // space on an empty context line) counts on both sides.
            oldRemaining--;
            newRemaining--;
          }
          i++;
        }
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return files;
}

/** The label vocabulary every Conventional Comments check derives from. */
const COMMENT_LABELS =
  "issue|suggestion|question|nitpick|todo|chore|note|thought";

const COMMENT_LABEL = new RegExp(
  `^(${COMMENT_LABELS}) \\((blocking|non-blocking)\\): `,
);

const BLOCKING_LABEL = new RegExp(`^(${COMMENT_LABELS}) \\(blocking\\): `);

const isBlocking = (comment: { body: string }): boolean =>
  BLOCKING_LABEL.test(comment.body.split("\n")[2] ?? "");

const commentSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  body: z.string(),
});

export const reviewDraftSchema = z.object({
  verdict: z.enum(["APPROVE", "REQUEST_CHANGES"]),
  body: z.string().min(1),
  comments: z.array(commentSchema),
});

export type ReviewDraft = z.infer<typeof reviewDraftSchema>;

export interface ValidatedReview {
  verdict: Verdict;
  body: string;
  comments: InlineComment[];
}

export type ValidationResult =
  | { ok: true; value: ValidatedReview }
  | { ok: false; errors: string[] };

/**
 * Which extraction route produced a candidate text: the last fenced
 * ```json block, or the balanced-brace scan over the full reply.
 */
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

/**
 * Pull the JSON value out of raw model output, undefined when the
 * extraction refuses for any reason. The refusing outcomes — and the
 * local repair — live in extractJsonDetailed; callers that name the
 * parse error to the model (the corrective retry paths, PRJ-381) must
 * use it. Kept for the callers that only want a value or nothing.
 */
export function extractJson(text: string): unknown | undefined {
  const result = extractJsonDetailed(text);
  return result.ok ? result.value : undefined;
}

/**
 * Resolve a model-written comment path onto the diff's new-side file map.
 * Order: the exact value (a file may legitimately live under a top-level
 * `a/` or `b/` directory), then the same value without the diff prefix,
 * then the diff's old-side paths, so a rename-shaped path lands on the
 * file it belongs to.
 */
function resolveCommentPath(
  raw: string,
  files: Map<string, DiffFile>,
): string | undefined {
  if (files.has(raw)) {
    return raw;
  }
  const stripped = stripDiffPrefix(raw);
  if (stripped !== raw && files.has(stripped)) {
    return stripped;
  }
  for (const file of files.values()) {
    if (file.oldPaths.includes(stripped)) {
      return file.path;
    }
  }
  return undefined;
}

/**
 * The result of splitting a draft's comments by anchorability: the ones
 * that anchor and the ones that do not. Kept comments are rewritten
 * copies carrying the new-side identity; dropped entries carry the
 * model's written comment untouched, so the record names what the model
 * actually sent.
 */
interface AnchorPartition {
  keep: Array<{ path: string; line: number; body: string }>;
  drops: Array<{
    comment: { path: string; line: number; body: string };
    reason: string;
  }>;
}

/**
 * Split a draft's comments into the ones that anchor onto the diff and
 * the ones that do not. A kept comment is a rewritten copy: its path is
 * the resolution the anchor check ran against (resolveCommentPath's
 * output — the new-side identity the forge positions comments against),
 * so every payload leaving this function posts under the path the check
 * validated. The input comments are never mutated. A dropped entry
 * carries the model's written comment verbatim; its reason names the
 * file the check refused — the resolved path for an anchor outside the
 * changed lines, the model's own path for one that appears nowhere in
 * the diff.
 */
function partitionByAnchor(
  comments: Array<{ path: string; line: number; body: string }>,
  files: Map<string, DiffFile>,
): AnchorPartition {
  const keep: AnchorPartition["keep"] = [];
  const drops: AnchorPartition["drops"] = [];
  for (const comment of comments) {
    const resolved = resolveCommentPath(comment.path, files);
    if (resolved === undefined) {
      drops.push({
        comment,
        reason: `comment path ${comment.path} does not appear in the diff`,
      });
      continue;
    }
    const file = files.get(resolved)!;
    const inside = file.ranges.some(
      ([start, end]) => comment.line >= start && comment.line <= end,
    );
    if (!inside) {
      drops.push({
        comment: { ...comment, path: resolved },
        reason: `comment on ${resolved} line ${comment.line} is outside the diff's changed lines`,
      });
      continue;
    }
    keep.push({ ...comment, path: resolved });
  }
  return { keep, drops };
}

function formatErrors(
  comments: Array<{ path: string; line: number; body: string }>,
): string[] {
  const errors: string[] = [];
  for (const comment of comments) {
    if (!comment.body.startsWith("Agent-generated:\n\n")) {
      errors.push(
        `comment on ${comment.path} line ${comment.line} does not start with "Agent-generated:" followed by a blank line`,
      );
      continue;
    }
    const firstLine = comment.body.split("\n")[2];
    if (!COMMENT_LABEL.test(firstLine)) {
      errors.push(
        `comment on ${comment.path} line ${comment.line} lacks a Conventional Comments label line (issue|suggestion|question|nitpick|todo|chore|note|thought with (blocking|non-blocking)); "praise" is forbidden`,
      );
    }
  }
  return errors;
}

/**
 * The blocker/verdict consistency errors for a comment set under a
 * verdict, written once for both callers (the full validation and the
 * drop rescue): any blocking comment forces REQUEST_CHANGES; none
 * allows APPROVE.
 */
function verdictConsistencyErrors(
  comments: Array<{ body: string }>,
  verdict: Verdict,
): string[] {
  const errors: string[] = [];
  const blocking = comments.some(isBlocking);
  if (blocking && verdict !== "REQUEST_CHANGES") {
    errors.push(
      "verdict is APPROVE but a comment is marked (blocking); the verdict must be REQUEST_CHANGES",
    );
  }
  if (!blocking && verdict === "REQUEST_CHANGES") {
    errors.push(
      "verdict is REQUEST_CHANGES but no comment is marked (blocking); the verdict must be APPROVE",
    );
  }
  return errors;
}

/**
 * One zod-issue formatting for both validation callers, so the rescue's
 * refusals and validateReview's errors are the same strings by
 * construction — the failure message's dedupe never hangs on two
 * hand-rolled formattings drifting apart.
 */
const zodIssues = (error: z.ZodError): string[] =>
  error.issues.map(
    (issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`,
  );

/**
 * Validate a parsed draft against the diff. The blocker/verdict consistency
 * rule: any blocking comment forces REQUEST_CHANGES; none allows APPROVE.
 */
export function validateReview(value: unknown, diff: string): ValidationResult {
  const files = parseDiffHunks(diff);
  const parsed = reviewDraftSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, errors: zodIssues(parsed.error) };
  }
  const draft = parsed.data;
  // One partition serves both halves: the refusals become the errors
  // and the kept, path-rewritten comments become the payload, so a
  // validated draft always carries the identity the check ran against.
  // The format check runs over every comment under that same identity —
  // the resolved path where one resolves, the model's own otherwise —
  // so the rescue's refusal strings and these match verbatim and the
  // failure message's dedupe is real (review 333).
  const { keep, drops } = partitionByAnchor(draft.comments, files);
  const checked = [...keep, ...drops.map((d) => d.comment)];
  const errors = [
    ...drops.map((d) => d.reason),
    ...formatErrors(checked),
    ...verdictConsistencyErrors(draft.comments, draft.verdict),
  ];
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      verdict: draft.verdict,
      body: draft.body,
      comments: keep,
    },
  };
}

export type DropRescue =
  | { ok: true; value: ValidatedReview; drops: DroppedComment[] }
  | {
      ok: false;
      errors: string[];
      /** The drops the rescue evaluated, when it got past the shape check. */
      drops?: DroppedComment[];
      /**
       * The verdict move the drops would have forced, recorded as what
       * almost happened: the rescue refused to apply it.
       */
      verdictReconciled?: VerdictReconciliation;
    };

/**
 * The context stage's drop rescue (PRJ-428): after the corrective retry
 * still failed validation, build the review the draft yields when every
 * comment that cannot anchor drops out of it. The run posts what
 * anchored instead of dying over one comment, and the dropped ones are
 * named for the run's record.
 *
 * The posted verdict is always the draft's own verdict. A drop that
 * would leave it inconsistent (the last blocking comment dropping) is
 * not rescued into a minted APPROVE: the rescue refuses, carries the
 * would-be move for the record, and the run fails through the existing
 * path — the forge never sees a verdict the draft did not issue, and a
 * draft whose every comment drops has no review to post at all.
 *
 * The rescue is anchor-only by construction: it re-checks the reduced
 * draft against every other rule, so a format failure or a verdict
 * inconsistency the drops did not cause still refuses, and the stage
 * fails as it always did. The returned body is the draft's own, written
 * for the full comment set; the post stage reconciles it at the one
 * site that builds a posted body (annotateDroppedComments), so the
 * posted body names the drops through the humanize stage and its
 * fallback alike.
 */
export function dropUnanchorable(value: unknown, diff: string): DropRescue {
  const files = parseDiffHunks(diff);
  const parsed = reviewDraftSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, errors: zodIssues(parsed.error) };
  }
  const draft = parsed.data;
  const { keep, drops } = partitionByAnchor(draft.comments, files);
  const droppedComments: DroppedComment[] = drops.map((d) => ({
    source: "context",
    path: d.comment.path,
    line: d.comment.line,
    reason: d.reason,
    body: d.comment.body,
  }));

  // Every comment dropping means there is no review to post: the run
  // fails through the existing record-then-fail path rather than
  // posting a zero-comment review.
  if (keep.length === 0) {
    return {
      ok: false,
      errors: ["every comment dropped; there is no review left to post"],
      drops: droppedComments,
    };
  }

  const errors = formatErrors(keep);
  // Consistency is checked on the kept set under the draft's own
  // verdict; its errors refuse the rescue either way. When the drops
  // broke a draft that was consistent as issued, the would-be move is
  // named for the record — and refused. The one reachable break: a
  // REQUEST_CHANGES draft whose every blocking comment dropped, so the
  // move is always REQUEST_CHANGES becoming APPROVE.
  const wouldBe = verdictConsistencyErrors(keep, draft.verdict);
  errors.push(...wouldBe);
  let verdictReconciled: VerdictReconciliation | undefined;
  if (
    wouldBe.length > 0 &&
    verdictConsistencyErrors(draft.comments, draft.verdict).length === 0
  ) {
    verdictReconciled = {
      from: "REQUEST_CHANGES",
      to: "APPROVE",
      because: `every blocking comment dropped: ${drops
        .filter((d) => isBlocking(d.comment))
        .map((d) => d.reason)
        .join("; ")}`,
    };
  }
  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      drops: droppedComments,
      verdictReconciled,
    };
  }
  return {
    ok: true,
    value: { verdict: draft.verdict, body: draft.body, comments: keep },
    drops: droppedComments,
  };
}
