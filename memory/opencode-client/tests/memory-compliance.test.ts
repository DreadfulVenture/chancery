import assert from "node:assert/strict";
import test from "node:test";
import { plugin, SILENT, withDaemon } from "./harness.ts";

// The compliance ladder (PRD-179) at the plugin boundary: the plugin only
// reports — a turn leg per active prompt and a pull leg per reading verb —
// and whatever reminder comes back is the only delivery this surface makes.

const SILENT_COMPLIANCE = {
  json: { status: "ok", reminder: "", section: "" },
};

const routes =
  (compliance, open = SILENT) =>
  (body, url) => {
    if (url === "/compliance") return compliance(body);
    return open;
  };

const prompt = (text: string) => ({
  hook_event: "prompt",
  sessionID: "s1",
  prompt: { text },
});

test("a real prompt reports a content-free turn; a throwaway reports nothing", async () => {
  await withDaemon(
    routes(() => SILENT_COMPLIANCE),
    async ({ fire, sessionHooks, synthetics, bodies }) => {
      await fire(sessionHooks, "prompt", prompt("fix the flaky kb test"));
      const turn = bodies.find((b) => b.path === "/compliance");
      assert.ok(turn, "the active prompt reported the turn");
      assert.equal(turn.body.type, "turn");
      assert.equal(turn.body.app, "opencode");
      assert.equal(turn.body.conversation_id, "s1");
      assert.equal(
        turn.body.prompt,
        undefined,
        "the turn report counts, it does not carry what was said",
      );
      assert.equal(synthetics.length, 0, "the common answer is silence");
      await fire(sessionHooks, "prompt", prompt("ok"));
      assert.equal(
        bodies.filter((b) => b.path === "/compliance").length,
        1,
        "throwaway prompts are not active turns",
      );
    },
  );
});

test("a fired tier rides a synthetic system-reminder", async () => {
  const fired = {
    json: {
      status: "ok",
      active_turns: 6,
      level: 1,
      reminder:
        "Memory note, level 1 of 3: this session has run 6 active turns …",
      section:
        "## Memory nudge\n\nMemory note, level 1 of 3: this session has run 6 active turns …",
    },
  };
  await withDaemon(
    routes(() => fired),
    async ({ fire, sessionHooks, bodies, synthetics }) => {
      await fire(sessionHooks, "prompt", prompt("fix the flaky kb test"));
      const block = synthetics.find((s) => s.text.includes("## Memory nudge"));
      assert.ok(block, "the reminder reached the session");
      assert.match(block.text, /^\n\n<system-reminder>/);
      // The turn leg is the prompt's second fetch — after session-open,
      // beside it, not instead of it.
      assert.deepEqual(
        bodies.map((b) => b.path),
        ["/session-open", "/compliance"],
      );
    },
  );
});

test("a refused compliance turn backs off instead of taxing every prompt", async () => {
  await withDaemon(
    routes(() => ({ status: 500, json: {} })),
    async ({ fire, sessionHooks, bodies }) => {
      await fire(sessionHooks, "prompt", prompt("first real prompt"));
      await fire(sessionHooks, "prompt", prompt("second real prompt"));
      assert.equal(
        bodies.filter((b) => b.path === "/compliance").length,
        1,
        "the backoff absorbed the next prompt",
      );
    },
  );
});

test("an executing reading verb reports the pull; nothing else does", async () => {
  await withDaemon(
    routes(() => SILENT_COMPLIANCE),
    async ({ fire, toolHooks, bodies }) => {
      await fire(toolHooks, "execute.before", {
        sessionID: "s1",
        id: "c1",
        tool: "memory_memory_recall",
        input: { query: "drain" },
      });
      const pull = bodies.find(
        (b) => b.path === "/compliance" && b.body.type === "pull",
      );
      assert.ok(pull, "the reading verb reported the pull");
      assert.equal(pull.body.tool, "memory_memory_recall");
      assert.equal(pull.body.conversation_id, "s1");
      assert.equal(pull.body.app, "opencode");
      // A shell command and a write tool are not pulls: no report.
      await fire(toolHooks, "execute.before", {
        sessionID: "s1",
        id: "c2",
        tool: "shell",
        input: { command: "git status" },
      });
      await fire(toolHooks, "execute.before", {
        sessionID: "s1",
        id: "c3",
        tool: "memory_memory_remember",
        input: { content: "x" },
      });
      assert.equal(
        bodies.filter((b) => b.path === "/compliance" && b.body.type === "pull")
          .length,
        1,
        "only reading verbs count as pulls",
      );
    },
  );
});
