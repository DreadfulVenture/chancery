/**
 * Local repair of the review pipeline's own observed JSON failure mode —
 * and nothing else. This is deliberately narrow, not a general JSON
 * doctor: it exists because PRJ-381's run (2026-11-17) lost a completed
 * blind pass twice to one transposition the review model emitted at
 * phrase closes inside a JSON string, and the corrective retry could not
 * name the break, so the model re-emitted the same broken escapes and
 * the run died. The repair fixes the reply
 * already in hand so the stage can end without model traffic; a reply it
 * cannot fix goes back to the model with the real parse error.
 *
 * Valid JSON writes a quoted phrase closing after a comma as `,\"`:
 * comma, backslash, quote. The two observed transpositions instead were:
 *
 *   backslash, comma, quote             — the backslash sits before the
 *     (3 bytes)                           comma and the quote is bare;
 *                                         fixed by moving the backslash
 *                                         onto the quote
 *   backslash, comma, backslash, quote  — a spurious escaped comma next
 *     (4 bytes)                           to a correct escaped quote;
 *                                         fixed by deleting the spurious
 *                                         pre-comma backslash
 *
 * Strict limits, from the investigation:
 *   - A bare-comma repair (deleting `\,` outright) does NOT recover: it
 *     leaves the phrase-closing quote bare, which terminates the string,
 *     and the parse still fails. Bare characters are never substituted.
 *   - No general escape normalization: only these two forms are
 *     rewritten, only at an escape position inside a string, so the
 *     valid backslash-backslash-comma-quote construct (a literal
 *     backslash before a comma, then an escaped quote) is never touched:
 *     the walk consumes the escaped backslash and never sees the comma
 *     as an escape target.
 *   - Any accepted repair must survive JSON.parse afterward: corrupting
 *     that construct to backslash-comma still refuses to parse, so a
 *     wrong match can never turn an unparseable reply into a postable
 *     payload.
 */

export interface TransposedEscapeRepair {
  /** The repaired text (a fresh string; never the input itself). */
  text: string;
  /** True when at least one occurrence was rewritten. */
  changed: boolean;
}

/**
 * Rewrite the two observed transposed-escape forms into the valid
 * comma-escaped-quote shape. Matches are found by walking the text the
 * way a JSON lexer does (string state, escape state), so a match can only
 * fire at a genuine escape position inside a string — precisely where a
 * backslash before a comma is a JSON parse refusal.
 */
export function repairTransposedEscapes(reply: string): TransposedEscapeRepair {
  let out = "";
  let changed = false;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < reply.length; i++) {
    const ch = reply[i];
    if (!inString) {
      if (ch === '"') {
        inString = true;
      }
      out += ch;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      // Inside a string, a backslash directly before a comma is not a
      // legal escape; the two forms to fix both start here.
      const after = reply[i + 1];
      const atComma = reply[i + 2];
      if (after === "," && atComma === '"') {
        // Three bytes: the escaped comma takes the quote with it.
        out += ',\\"';
        i += 2;
        changed = true;
        continue;
      }
      if (after === "," && atComma === "\\" && reply[i + 3] === '"') {
        // Four bytes: the spurious pre-comma backslash is deleted.
        out += ',\\"';
        i += 3;
        changed = true;
        continue;
      }
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
    }
    out += ch;
  }
  return { text: out, changed };
}
