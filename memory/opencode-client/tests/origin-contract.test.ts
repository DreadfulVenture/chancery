// The origin contract (PRJ-514, review 589's follow-up): the producers
// export their origin-record composition and this test ties both to the
// consumer across the package boundary. The parentless-program bug this
// closes existed because two sides wrote the record independently and
// only a reviewer's hand-check compared them.
//
// House import style, discovered: the suites import their modules with
// relative paths carrying the explicit .ts extension (director.test.ts
// imports ../director.ts; memory-lifecycle.test.ts imports ./harness.ts)
// — node's type-stripped runner resolves no extensionless relative
// import, so the cross-package paths below carry .ts too. The zenigata
// composition comes from review/zenigata/src/origin.ts and not from
// adapters/opencode.ts itself: that module imports @opencode/client,
// which resolves only inside its own package's node_modules, and the
// composition module deliberately imports nothing.

import assert from "node:assert/strict";
import test from "node:test";
import { withDaemon, queued, SILENT } from "./harness.ts";
import { originRecord as directorOriginRecord } from "../../../coordinate/director/director.ts";
import { originRecord as runtimeOriginRecord } from "../../../review/zenigata/src/origin.ts";

test("the origin contract: both producers' records register as agent-side lineage", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, sessions }) => {
      // The director's record: the creating side is the dispatching
      // session, so the row chains worker -> director session.
      sessions.set("s-worker", {
        metadata: { chancery_origin: directorOriginRecord("ses-director") },
      });
      await fire(sessionHooks, "prompt", {
        sessionID: "s-worker",
        prompt: { text: "the dispatched worker's brief" },
      });
      const directorRow = queued().find(
        (line) =>
          line.kind === "session" && line.conversation_id === "s-worker",
      );
      assert.ok(directorRow, "the director's record parsed and registered");
      assert.equal(directorRow.parent_conversation_id, "ses-director");
      assert.equal(directorRow.initiator, "agent");
      const workerCapture = queued().find(
        (line) => line.role === "user" && line.conversation_id === "s-worker",
      );
      assert.ok(workerCapture, "the worker's capture proceeds");
      assert.equal(workerCapture.initiator, "agent");

      // The runtime's record: the creating side is not itself a session,
      // so parent parses as the parentless-program declaration and the
      // row registers with no parent field, agent initiator.
      sessions.set("s-review", {
        metadata: { chancery_origin: runtimeOriginRecord(null) },
      });
      await fire(sessionHooks, "prompt", {
        sessionID: "s-review",
        prompt: { text: "the bot session's first turn" },
      });
      const runtimeRow = queued().find(
        (line) =>
          line.kind === "session" && line.conversation_id === "s-review",
      );
      assert.ok(runtimeRow, "the runtime's record parsed and registered");
      assert.equal(
        runtimeRow.parent_conversation_id,
        undefined,
        "the parentless-program declaration carries no parent field",
      );
      assert.equal(runtimeRow.initiator, "agent");
      const reviewCapture = queued().find(
        (line) => line.role === "user" && line.conversation_id === "s-review",
      );
      assert.ok(reviewCapture, "the bot session's capture proceeds");
      assert.equal(reviewCapture.initiator, "agent");

      // The negatives stay on the human default: a record with no parent
      // key, and a foreign "agent"-word initiator the vocabulary rejects.
      for (const [id, record] of [
        ["s-no-parent", { initiator: "program" }],
        ["s-foreign", { initiator: "agent", parent: "ses-x" }],
      ] as Array<[string, Record<string, unknown>]>) {
        sessions.set(id, { metadata: { chancery_origin: record } });
        await fire(sessionHooks, "prompt", {
          sessionID: id,
          prompt: { text: `a turn from the half-written ${id}` },
        });
        assert.equal(
          queued().find(
            (line) => line.kind === "session" && line.conversation_id === id,
          ),
          undefined,
          `${record.initiator} with ${record.parent === undefined ? "no parent key" : "a foreign initiator word"} stays undeclared`,
        );
        const capture = queued().find(
          (line) => line.role === "user" && line.conversation_id === id,
        );
        assert.ok(capture, "capture proceeds as before");
        assert.equal(capture.initiator, "human");
      }
    },
  );
});
