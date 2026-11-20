import assert from "node:assert/strict";
import test from "node:test";
import { withDaemon, queued, SILENT } from "./harness.ts";

test("lifecycle: handlers survive compaction and deleted cleanup", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, emit }) => {
      await fire(sessionHooks, "prompt", {
        sessionID: "s1",
        messageID: "m1",
        prompt: { text: "this is a long enough test prompt message" },
      });

      const user = queued().find((line) => line.role === "user");
      assert.ok(user, "user turn captured to queue");
      assert.equal(user.conversation_id, "s1");

      // Regression: the compaction boundary used to throw (injectedContents).
      await assert.doesNotReject(() =>
        emit("session.compacted", { sessionID: "s1" }),
      );
      await assert.doesNotReject(() =>
        emit("session.deleted", { sessionID: "s1" }),
      );
    },
  );
});

test("lifecycle: a prompt after the boundary is captured as before", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, emit }) => {
      await fire(sessionHooks, "prompt", {
        sessionID: "s3",
        messageID: "m3",
        prompt: { text: "the turn before the boundary" },
      });
      await emit("session.compacted", { sessionID: "s3" });
      await fire(sessionHooks, "prompt", {
        sessionID: "s3",
        messageID: "m4",
        prompt: { text: "the turn after the boundary" },
      });

      const turns = queued()
        .filter((line) => line.conversation_id === "s3")
        .map((line) => line.text);
      assert.deepEqual(turns, [
        "the turn before the boundary",
        "the turn after the boundary",
      ]);
    },
  );
});

test("lifecycle: the compaction marker rides the queue", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks }) => {
      await fire(sessionHooks, "compaction", { sessionID: "s2", system: [] });

      const compaction = queued().find((line) => line.kind === "compaction");
      assert.ok(compaction, "compaction marker enqueued");
      assert.equal(compaction.conversation_id, "s2");
    },
  );
});

test("lifecycle: a child session registers with its parent link", async () => {
  await withDaemon(
    () => SILENT,
    async ({ emit }) => {
      await emit("session.created", {
        sessionID: "child9",
        parentID: "top1",
      });

      const registration = queued().find((line) => line.kind === "session");
      assert.ok(registration, "child registration enqueued");
      assert.equal(registration.conversation_id, "child9");
      assert.equal(registration.parent_conversation_id, "top1");
    },
  );
});

test("lifecycle: a top-level session registers nothing", async () => {
  await withDaemon(
    () => SILENT,
    async ({ emit }) => {
      await emit("session.created", { sessionID: "toponly", parentID: null });

      const registration = queued().find((line) => line.kind === "session");
      assert.equal(
        registration,
        undefined,
        "a main session learns nothing the drain cannot learn from its first turn",
      );
    },
  );
});
