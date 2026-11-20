import assert from "node:assert/strict";
import test from "node:test";
import { plugin, withDaemon, queued, SILENT } from "./harness.ts";

// The plugin as OpenCode 2 loads it: setup() registers hooks against the
// domain objects, and each hook receives one mutable event.

test("the memory server is registered as the plugin loads", async () => {
  await withDaemon(
    () => SILENT,
    async ({ mcp }) => {
      // The daemon stamps writes with the client named in the query string
      // and gates them on the lineage initiator the URL declares, so both
      // are part of the registration rather than decoration.
      assert.equal(mcp.memory.type, "remote");
      assert.match(mcp.memory.url, /\/mcp\?app=opencode&initiator=human$/);
    },
  );
});

test("a prompt is captured and persists no synthetic", async () => {
  // Nothing rides message arrival: capture is the only prompt-time work,
  // and the retired channels (/nudge, /tool-recall) never fire.
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, synthetics, bodies }) => {
      const typed = "this is a long enough test prompt message";
      const admitted = await fire(sessionHooks, "prompt", {
        sessionID: "s-capture",
        messageID: "um-7",
        prompt: { text: typed },
      });

      const user = queued().find((line) => line.role === "user");
      assert.ok(user, "user turn captured");
      assert.equal(user.conversation_id, "s-capture");
      assert.equal(user.text, typed);
      assert.equal(admitted.prompt.text, typed, "the prompt stays untouched");

      assert.equal(synthetics.length, 0);
      // The two fetches a real prompt makes now: session-open, and the
      // compliance turn report (capture rides the queue, not the daemon).
      // The per-message channels are gone from this client entirely.
      assert.deepEqual(
        bodies.map((b) => b.path),
        ["/session-open", "/compliance"],
      );
    },
  );
});

test("a short acknowledgement is captured by nothing", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, synthetics, bodies }) => {
      const event = await fire(sessionHooks, "prompt", {
        sessionID: "s-ack",
        messageID: "msg-1",
        prompt: { text: "ok" },
      });
      assert.equal(event.prompt.text, "ok");
      // Session-open still fetches (it makes no LLM call, so a short
      // opening stays cheap); the compliance turn skips the keystroke,
      // and what a keystroke turn never gets is a capture row or a
      // delivered block.
      assert.deepEqual(
        bodies.map((b) => b.path),
        ["/session-open"],
      );
      assert.equal(synthetics.length, 0);
      assert.equal(
        queued().filter((line) => line.conversation_id === "s-ack").length,
        0,
      );
      assert.equal(synthetics.length, 0);
    },
  );
});

test("the compaction boundary is announced to the summarizing request", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks }) => {
      const event = await fire(sessionHooks, "compaction", {
        sessionID: "s-compact",
        system: [],
      });
      assert.ok(
        event.system.some((part) => part.text?.includes("compaction boundary")),
        "the summarizing request is told to recall",
      );
    },
  );
});

test("an assistant turn is captured when its execution ends", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, emit }) => {
      await fire(sessionHooks, "prompt", {
        sessionID: "s-reply",
        messageID: "msg-1",
        prompt: { text: "this is a long enough test prompt message" },
      });

      // session.text.ended is the replayable boundary for one text block;
      // the turn ends with its execution.
      await emit("session.text.ended", {
        sessionID: "s-reply",
        text: "x".repeat(150),
      });
      await emit("session.execution.succeeded", { sessionID: "s-reply" });

      const reply = queued().find(
        (line) =>
          line.role === "assistant" && line.conversation_id === "s-reply",
      );
      assert.ok(reply, "assistant turn captured");
      assert.equal(reply.text.length, 150);
    },
  );
});

test("a subagent's turns are left to its parent", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, emit, bodies }) => {
      await emit("session.created", {
        sessionID: "s-child",
        parentID: "s-parent",
      });

      const typed = "this is a long enough test prompt message";
      const event = await fire(sessionHooks, "prompt", {
        sessionID: "s-child",
        messageID: "msg-1",
        prompt: { text: typed },
      });
      assert.equal(event.prompt.text, typed);
      // A child captures no turns; the kind:"session" registration line it
      // enqueues is provenance, not turn content (the lifecycle suite
      // asserts its exact shape). The compliance turn leg is the one
      // exception and it is deliberate: a subagent is a session whose
      // pulls are counted, so its active turns are reported too — the
      // ladder observes the session, not the org chart.
      assert.deepEqual(
        bodies.map((b) => ({ path: b.path, body: { ...b.body } })),
        [
          {
            path: "/compliance",
            body: {
              type: "turn",
              app: "opencode",
              conversation_id: "s-child",
            },
          },
        ],
      );
      assert.equal(
        queued().filter(
          (line) =>
            line.conversation_id === "s-child" && line.kind !== "session",
        ).length,
        0,
      );

      const context = await fire(sessionHooks, "context", {
        sessionID: "s-child",
        system: [],
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: [{ type: "text", text: typed }],
          },
        ],
      });
      assert.equal(
        context.messages[0].content.length,
        1,
        "no recalled block for a subagent",
      );
    },
  );
});
