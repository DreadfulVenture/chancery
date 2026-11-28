/**
 * The session log's formatter (PRJ-568): the composed transcript text
 * rendered as structured turns. The suite pins the line grammar against
 * the shapes the server's composer writes, the diff/code/styling
 * groups, and the presentation-only rule — every line the server
 * composed appears in the render, in order, only dressed.
 */

import { describe, expect, it } from "vitest";
import { render } from "lit";
import { formattedLog } from "../src/client/transcript-format.js";
import type { TemplateResult } from "lit";
import type { TranscriptView } from "../src/run-data.js";

const mount = (template: TemplateResult | unknown): HTMLElement => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(template as TemplateResult, container);
  return container;
};

const found = (text: string, truncated = false): TranscriptView => ({
  state: "found",
  text,
  truncated,
});

/**
 * The fixture joins turns the composer's way (review 20049): one
 * string per turn, joined with a blank line, the way
 * composeTranscriptView writes the text (`keptNewestFirst.join("\n\n")`
 * in zenigata's transcript.ts). A turn's own blank lines stay inside
 * its string; the cut marker rides glued to the text it cut (review
 * 20048), the way capTurnText appends it.
 */
const TURNS = [
  "[21:37:36] user: review this diff\n\na second paragraph after the blank line",
  "[21:37:40] reviewer: on it\n    const pinned = true;",
  [
    "[21:38:00] tool shell — completed",
    "    input: git diff main",
    "    output: diff --git a/f b/f",
    "index abc123..def456 100644",
    "--- a/f",
    "+++ b/f",
    "@@ -1,2 +1,3 @@",
    "- removed line",
    "+ added line",
    "    error: boom",
  ].join("\n"),
  "[21:39:00] reviewer: the review continues past here and the composer cut the text mid-sente[turn truncated at the page's transcript cap]",
];

const TRANSCRIPT = TURNS.join("\n\n");

describe("the transcript formatter", () => {
  it("the gone, unreadable, and empty states render nothing", () => {
    expect(mount(formattedLog({ state: "swept" })).children).toHaveLength(0);
    expect(mount(formattedLog({ state: "unavailable" })).children).toHaveLength(
      0,
    );
    expect(
      mount(formattedLog({ state: "found", text: "", truncated: false }))
        .children,
    ).toHaveLength(0);
  });

  it("a found view renders one scrollable log box of turns", () => {
    const container = mount(formattedLog(found(TRANSCRIPT)));
    const box = container.querySelector(".transcript-body");
    expect(box).toBeTruthy();
    expect(box?.querySelectorAll(".log-turn")).toHaveLength(4);
  });

  it("a turn's header carries the stamp and the role word", () => {
    const container = mount(formattedLog(found("[10:00:02] reviewer: on it")));
    const head = container.querySelector(".log-turn-head")!;
    expect(head.querySelector(".log-stamp")?.textContent).toBe("[10:00:02]");
    expect(head.querySelector(".log-role")?.textContent).toBe("reviewer");
    expect(container.querySelector(".log-prose")?.textContent).toBe("on it");
  });

  it("an unstamped turn renders bare, and stray leading lines open a plain block", () => {
    const container = mount(formattedLog(found("user: hello\nworld")));
    expect(container.querySelector(".log-stamp")).toBeNull();
    expect(container.querySelector(".log-role")?.textContent).toBe("user");
    expect(container.querySelector(".log-prose")?.textContent).toContain(
      "world",
    );
    const stray = mount(formattedLog(found("no header at all\nsecond line")));
    expect(stray.querySelector(".log-role")?.textContent).toBe("log");
    expect(stray.querySelectorAll(".log-prose")).toHaveLength(1);
  });

  it("a tool turn's header names the tool with its status chip, and its sections carry labels", () => {
    const container = mount(formattedLog(found(TRANSCRIPT)));
    const tool = container.querySelectorAll(".log-turn")[2]!;
    expect(tool.querySelector(".log-tool-name")?.textContent).toBe("shell");
    expect(tool.querySelector(".chip")?.textContent).toBe("completed");
    const labels = [...tool.querySelectorAll(".log-section-label")].map(
      (label) => label.textContent,
    );
    expect(labels).toEqual(["input", "output", "error"]);
    expect(tool.querySelector(".log-section-body")?.textContent).toContain(
      "git diff main",
    );
  });

  it("the status chip's tone follows the status word, and a live state carries no tone class", () => {
    const container = mount(formattedLog(found(TRANSCRIPT)));
    const tool = container.querySelectorAll(".log-turn")[2]!;
    expect(tool.querySelector(".chip")?.className).toContain("ok");
    const failed = mount(formattedLog(found("[21:00:00] tool edit — error")));
    expect(failed.querySelector(".chip")?.className).toContain("bad");
    // The live states are the base chip's own gray: no `mute` class
    // that matches no style rule (review 20050).
    const running = mount(
      formattedLog(found("[21:00:00] tool shell — running")),
    );
    expect(running.querySelector(".chip")?.className).toBe("chip");
  });

  it("diff lines render in a monospace block with add, del, and metadata tones", () => {
    const container = mount(formattedLog(found(TRANSCRIPT)));
    const tool = container.querySelectorAll(".log-turn")[2]!;
    const diff = tool.querySelector("pre.log-code.diff")!;
    expect(diff.querySelectorAll(".add")).toHaveLength(1);
    expect(diff.querySelectorAll(".del")).toHaveLength(1);
    const tones = [...diff.querySelectorAll("span")].map(
      (span) => span.className,
    );
    expect(tones).toEqual([
      "meta",
      "meta",
      "meta",
      "meta",
      "meta",
      "del",
      "add",
    ]);
  });

  it("diff lines come back as separate lines, not one wrapped paragraph (review 20046)", () => {
    const container = mount(formattedLog(found(TRANSCRIPT)));
    const tool = container.querySelectorAll(".log-turn")[2]!;
    const diff = tool.querySelector("pre.log-code.diff")!;
    // Boundary whitespace around the map's child part belongs to the
    // template's reflow; the proof is the lines between the spans.
    const lines = (diff.textContent ?? "").split("\n").filter(Boolean);
    expect(lines).toEqual([
      "diff --git a/f b/f",
      "index abc123..def456 100644",
      "--- a/f",
      "+++ b/f",
      "@@ -1,2 +1,3 @@",
      "- removed line",
      "+ added line",
    ]);
  });

  it("diff detection is scoped: a message body's bullets and +1 lines stay prose (review 20047)", () => {
    const container = mount(
      formattedLog(
        found(
          "[10:00:00] reviewer: notes\n- a markdown bullet\n+1 to that\n- another bullet",
        ),
      ),
    );
    expect(container.querySelector("pre.log-code.diff")).toBeNull();
    const prose = container.querySelector(".log-prose")?.textContent ?? "";
    expect(prose).toContain("- a markdown bullet");
    expect(prose).toContain("+1 to that");
    expect(prose).toContain("- another bullet");
  });

  it("a real diff opens with metadata and the signed lines join it; prose after closes it", () => {
    const container = mount(
      formattedLog(
        found(
          "[10:00:00] tool git — completed\n    output: diff --git a/f b/f\n@@ -1 +1 @@\n-ok\n+new\nplain text after the diff",
        ),
      ),
    );
    const section = container.querySelector(".log-section-body")!;
    const diff = section.querySelector("pre.log-code.diff")!;
    expect(diff.querySelectorAll(".del")).toHaveLength(1);
    expect(diff.querySelectorAll(".add")).toHaveLength(1);
    // The prose line after the diff renders as prose, outside the pre.
    expect(section.querySelector(".log-prose")?.textContent).toBe(
      "plain text after the diff",
    );
  });

  it("the glued cut marker splits off the text and renders as the styled label (review 20048)", () => {
    const container = mount(formattedLog(found(TRANSCRIPT)));
    const marker = container.querySelector(".log-marker");
    expect(marker?.textContent).toBe(
      "[turn truncated at the page's transcript cap]",
    );
    // The cut text keeps its own group, without the marker appended.
    const prose = [...container.querySelectorAll(".log-prose")]
      .map((block) => block.textContent)
      .join("\n");
    expect(prose).toContain("cut the text mid-sente");
    expect(prose).not.toContain("mid-sente[turn truncated");
  });

  it("indented lines in a message's body render as a code block", () => {
    const container = mount(formattedLog(found(TRANSCRIPT)));
    const reviewer = container.querySelectorAll(".log-turn")[1]!;
    expect(reviewer.querySelector("pre.log-code:not(.diff)")?.textContent).toBe(
      "    const pinned = true;",
    );
  });

  it("a rule-of-three line renders as its own styled rule", () => {
    const container = mount(formattedLog(found("before\n---\nafter", false)));
    const rule = container.querySelector(".log-rule");
    expect(rule?.textContent).toBe("---");
    expect(container.querySelector(".log-prose")?.textContent).toContain(
      "before",
    );
  });

  it("the composer's truncation marker renders as a marker line", () => {
    const container = mount(formattedLog(found(TRANSCRIPT)));
    expect(container.querySelector(".log-marker")?.textContent).toBe(
      "[turn truncated at the page's transcript cap]",
    );
  });

  it("presentation only: the composed transcript's content appears in order", () => {
    const container = mount(formattedLog(found(TRANSCRIPT)));
    const rendered = container.textContent ?? "";
    let cursor = 0;
    const expectInOrder = (piece: string): void => {
      const at = rendered.indexOf(piece, cursor);
      expect(at, `not found in order: ${piece}`).toBeGreaterThanOrEqual(0);
      cursor = at + piece.length;
    };
    // The dressing restructures the header lines (stamp, role, tool
    // name, status chip each become their own element) and labels the
    // tool sections; every body and section line stays verbatim.
    const pieces = [
      "[21:37:36]",
      "user",
      "review this diff",
      "a second paragraph after the blank line",
      "[21:37:40]",
      "reviewer",
      "on it",
      "    const pinned = true;",
      "[21:38:00]",
      "shell",
      "completed",
      "input",
      "git diff main",
      "output",
      "diff --git a/f b/f",
      "index abc123..def456 100644",
      "--- a/f",
      "+++ b/f",
      "@@ -1,2 +1,3 @@",
      "- removed line",
      "+ added line",
      "error",
      "boom",
      "[21:39:00]",
      "reviewer",
      "the review continues past here and the composer cut the text mid-sente",
      "[turn truncated at the page's transcript cap]",
    ];
    for (const piece of pieces) {
      expectInOrder(piece);
    }
  });

  it("the composer's blank turn separator does not fold into the previous turn (review 20049)", () => {
    const container = mount(formattedLog(found(TRANSCRIPT)));
    // Four turns, one per composer turn string — the blank lines
    // between them are separators, not trailing prose.
    expect(container.querySelectorAll(".log-turn")).toHaveLength(4);
    // The user turn's own blank line stays content: one prose block
    // carrying both paragraphs.
    const user = container.querySelectorAll(".log-turn")[0]!;
    const prose = user.querySelectorAll(".log-prose");
    expect(prose).toHaveLength(1);
    expect(prose[0]?.textContent).toBe(
      "review this diff\n\na second paragraph after the blank line",
    );
    // No turn's body ends on the separator's blank line.
    const reviewer = container.querySelectorAll(".log-turn")[1]!;
    expect(reviewer.querySelector(".log-prose")?.textContent).toBe("on it");
  });
});
