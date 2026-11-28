/**
 * The session log's formatter (PRJ-568): the composed transcript text
 * rendered as structured turns — timestamp and name as the heading,
 * input/output/error as labeled sections, and diff or code lines in
 * monospace with their own styling.
 *
 * The composed text is the truth; this is presentation only. The parser
 * is line-shaped rather than turn-perfect: the composer renders a turn
 * as a header line followed by free lines and separates turns with one
 * blank line, so a line the grammar does not recognize continues
 * whatever block is open, a blank ahead of a header ends the turn, and
 * a stray line before any header opens a plain block of its own. Every
 * line the server composed appears here, in order, only dressed.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { TranscriptView } from "../run-data.js";
import type { Renderable } from "./format.js";

/**
 * The composer's own truncation marker (zenigata's transcript cap): a
 * line that labels the cut instead of reading as prose.
 */
const TURN_MARKER = "[turn truncated at the page's transcript cap]";

/** A tool turn's labeled pieces: `    input: …`, with free continuation lines. */
type SectionLabel = "input" | "output" | "error";

interface ToolSection {
  label: SectionLabel;
  lines: string[];
}

/** One parsed turn: a header plus its free lines. */
interface Turn {
  /** The `[hh:mm:ss]` stamp, empty on a turn the composer rendered unstamped. */
  stamp: string;
  /** The role word as the composer wrote it: user, reviewer, report, or tool. */
  role: string;
  /** A tool turn's name and status word; absent on a message turn. */
  name?: string;
  status?: string;
  /** A tool turn's labeled sections, in composed order. */
  sections: ToolSection[];
  /** A message turn's body lines after the header. */
  body: string[];
}

// The line grammar. The stamp is optional: a turn whose record carries no
// created moment renders bare, and the composer cuts nothing else away.

const TOOL_HEAD = /^(?:\[(\d{2}:\d{2}:\d{2})\] )?tool (.+) — (.+)$/;
const MESSAGE_HEAD =
  /^(?:\[(\d{2}:\d{2}:\d{2})\] )?(user|report|reviewer): ?(.*)$/;
const SECTION_HEAD = /^ +(input|output|error): ?(.*)$/;

const parseTurns = (text: string): Turn[] => {
  const turns: Turn[] = [];
  const lines = text.split("\n");
  /** A line a turn header opens: the composer's turn separator ends at one. */
  const isTurnHead = (line: string | undefined): boolean =>
    line !== undefined && (TOOL_HEAD.test(line) || MESSAGE_HEAD.test(line));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    // The composer separates turns with one blank line; a blank directly
    // ahead of a turn header is that separator, not the previous turn's
    // trailing prose (review 20049). Blank lines inside a turn's own
    // text stay content.
    if (line === "" && isTurnHead(lines[i + 1])) {
      continue;
    }
    const tool = TOOL_HEAD.exec(line);
    if (tool !== null) {
      turns.push({
        stamp: tool[1] === undefined ? "" : `[${tool[1]}]`,
        role: "tool",
        name: tool[2],
        status: tool[3],
        sections: [],
        body: [],
      });
      continue;
    }
    const message = MESSAGE_HEAD.exec(line);
    if (message !== null) {
      turns.push({
        stamp: message[1] === undefined ? "" : `[${message[1]}]`,
        role: message[2],
        sections: [],
        body: message[3] === "" ? [] : [message[3]],
      });
      continue;
    }
    const turn = turns.at(-1);
    if (turn === undefined) {
      // Lines before any header: the log's own leading block.
      turns.push({ stamp: "", role: "log", sections: [], body: [line] });
      continue;
    }
    const section = SECTION_HEAD.exec(line);
    if (section !== null && turn.role === "tool") {
      turn.sections.push({
        label: section[1] as SectionLabel,
        lines: section[2] === "" ? [] : [section[2]],
      });
      continue;
    }
    const open = turn.sections.at(-1);
    if (open !== undefined && turn.body.length === 0) {
      open.lines.push(line);
    } else {
      turn.body.push(line);
    }
  }
  return turns;
};

// ---------------------------------------------------------------------------
// Message body groups
// ---------------------------------------------------------------------------

/** Diff metadata: the line names the compared files or the hunk. */
const DIFF_META = /^(?:diff --git |index [0-9a-f]+\.\.|@@ |--- .|\+\+\+ .)/;
/** A hunk content line's sign. `---`/`+++` already matched as metadata. */
const DIFF_SIGN = /^([+-])/;
/** A rule-of-three separator line (the composer's `---` and its kin). */
const SEPARATOR = /^[-=_*]{3,}$/;

type BodyGroup =
  | { kind: "prose"; lines: string[] }
  | { kind: "code"; lines: string[] }
  | { kind: "diff"; lines: string[] }
  | { kind: "rule"; line: string }
  | { kind: "marker"; line: string };

/**
 * The body's groups. Diff detection is scoped (review 20047): a
 * metadata line — `diff --git`, `index`, `@@`, a `--- a/…` or
 * `+++ b/…` file header — opens or continues a diff group, and a
 * signed line joins only a diff group already open. A message body's
 * markdown bullets and `+1` lines never open one, so they stay prose;
 * the first non-diff line after a diff closes it.
 */
const groupBody = (lines: string[]): BodyGroup[] => {
  const groups: BodyGroup[] = [];
  const classify = (part: string): void => {
    if (SEPARATOR.test(part)) {
      groups.push({ kind: "rule", line: part });
      return;
    }
    const open = groups.at(-1);
    const inDiff = open?.kind === "diff";
    if (DIFF_META.test(part) || (inDiff && DIFF_SIGN.test(part))) {
      if (!inDiff) {
        groups.push({ kind: "diff", lines: [] });
      }
      (groups.at(-1) as { lines: string[] }).lines.push(part);
      return;
    }
    const kind = /^ {4}\S/.test(part) ? "code" : "prose";
    if (open === undefined || open.kind !== kind) {
      groups.push({ kind, lines: [] });
    }
    (groups.at(-1) as { lines: string[] }).lines.push(part);
  };
  for (const raw of lines) {
    // The composer glues the cut marker to the truncated text's last
    // line; split it off so the styled label stands alone (review
    // 20048) and the cut text itself keeps its own group.
    if (raw.endsWith(TURN_MARKER)) {
      const cut = raw.slice(0, raw.length - TURN_MARKER.length);
      if (cut !== "") {
        classify(cut);
      }
      groups.push({ kind: "marker", line: TURN_MARKER });
      continue;
    }
    classify(raw);
  }
  return groups;
};

/** One diff line's tone, from its own text. */
const diffTone = (line: string): "add" | "del" | "meta" => {
  if (DIFF_META.test(line)) {
    return "meta";
  }
  if (DIFF_SIGN.test(line)) {
    return line.startsWith("+") ? "add" : "del";
  }
  return "meta";
};

const renderBodyGroup = (group: BodyGroup): TemplateResult => {
  if (group.kind === "rule") {
    return html`<div class="log-rule">${group.line}</div>`;
  }
  if (group.kind === "marker") {
    return html`<div class="log-marker">${group.line}</div>`;
  }
  if (group.kind === "diff") {
    // Each line carries its own newline in the expression's value: a
    // span whose text ends the line. Template whitespace cannot be
    // relied on here — prettier reflows it — and without the newline
    // the pre renders one wrapped paragraph (review 20046).
    const lines = group.lines.map(
      (line) => html`<span class="${diffTone(line)}">${line + "\n"}</span>`,
    );
    return html`<pre class="log-code diff">${lines}</pre>`;
  }
  if (group.kind === "code") {
    return html`<pre class="log-code">${group.lines.join("\n")}</pre>`;
  }
  return html`<div class="log-prose">${group.lines.join("\n")}</div>`;
};
// ---------------------------------------------------------------------------
// Turn rendering
// ---------------------------------------------------------------------------

/**
 * The status chip's tone: green done, red failed, and the live states
 * carry no tone — the base chip's own gray is the meaning. There is no
 * `mute` class to hunt for (review 20050).
 */
const statusTone = (status: string): "" | "ok" | "bad" =>
  status === "completed" ? "ok" : status === "error" ? "bad" : "";

const renderTurn = (turn: Turn): TemplateResult => {
  const tone = statusTone(turn.status ?? "error");
  return html`<div class="log-turn">
    <div class="log-turn-head">
      ${turn.stamp === ""
        ? nothing
        : html`<span class="log-stamp">${turn.stamp}</span>`}
      ${turn.role === "tool"
        ? html`<span class="log-tool">
            <span class="log-tool-name">${turn.name}</span>
            <span class=${tone === "" ? "chip" : `chip ${tone}`}
              >${turn.status}</span
            >
          </span>`
        : html`<span class="log-role role-${turn.role}">${turn.role}</span>`}
    </div>
    ${turn.sections.map(
      (section) =>
        html`<div class="log-section">
          <div class="log-section-label">${section.label}</div>
          ${section.lines.length === 0
            ? nothing
            : html`<div class="log-section-body">
                ${groupBody(section.lines).map(renderBodyGroup)}
              </div>`}
        </div>`,
    )}
    ${turn.body.length === 0
      ? nothing
      : html`<div class="log-turn-body">
          ${groupBody(turn.body).map(renderBodyGroup)}
        </div>`}
  </div>`;
};

/**
 * The found transcript's formatted body: one scrollable, resizable box
 * holding the structured turns. `.transcript-body` is the pin and
 * refresh logic's scroll point, the box the old bare pre played.
 */
export const formattedLog = (view: TranscriptView): Renderable =>
  view.state !== "found" || view.text === ""
    ? nothing
    : html`<div class="transcript-body">
        ${parseTurns(view.text).map(renderTurn)}
      </div>`;
