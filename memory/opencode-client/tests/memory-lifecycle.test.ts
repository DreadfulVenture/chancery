import assert from "node:assert/strict";
import test from "node:test";
import { withDaemon, queued, SILENT } from "./harness.ts";

test("lifecycle: handlers survive compaction and deleted cleanup", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, emit, sessions }) => {
      sessions.set("s1", { metadata: {} });
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
    async ({ fire, sessionHooks, emit, sessions }) => {
      sessions.set("s3", { metadata: {} });
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

// The dispatch stamp's lineage registration (PRJ-510): a director-
// dispatched worker reads its coordinator from the session stamp and
// registers the parent link itself, on the first prompt and ahead of
// its first capture row.

const stamped = (coordinator: string) => ({
  metadata: { chancery: { coordinatedBy: coordinator } },
});

test("dispatch lineage: the worker registers its parent before its first capture", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, sessions }) => {
      sessions.set("s-worker", stamped("ses-director"));
      const turn = (text: string) =>
        fire(sessionHooks, "prompt", {
          sessionID: "s-worker",
          prompt: { text },
        });
      await turn("land the slice: read the drain, cite the code");

      const rows = queued();
      const registration = rows.find((line) => line.kind === "session");
      assert.ok(registration, "the worker registered its lineage");
      assert.equal(registration.conversation_id, "s-worker");
      assert.equal(registration.parent_conversation_id, "ses-director");
      assert.equal(registration.initiator, "agent");
      assert.equal(registration.app, "opencode");
      // The order the queue carries: registration first, capture second
      // — the drain registers a session from the first payload that
      // names it, so a capture row landing first would create the row
      // with the deployment's default initiator.
      assert.equal(rows[0].kind, "session");
      assert.equal(rows[1].role, "user");
      assert.equal(rows[1].initiator, "agent");

      // One-time: later prompts capture, never re-register.
      await turn("and the second turn of the same worker");
      assert.equal(
        queued().filter((line) => line.kind === "session").length,
        1,
        "the registration is a one-time line per session",
      );
    },
  );
});

test("dispatch lineage: an unstamped session captures with the default initiator", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, sessions }) => {
      // A real host row with no stamp: the human's own session.
      sessions.set("s-human", { metadata: {} });
      await fire(sessionHooks, "prompt", {
        sessionID: "s-human",
        prompt: { text: "fix the flaky kb test" },
      });
      assert.equal(
        queued().find((line) => line.kind === "session"),
        undefined,
        "no stamp, no registration line",
      );
      const capture = queued().find((line) => line.role === "user");
      assert.ok(capture, "capture proceeds as before");
      assert.equal(capture.initiator, "human");
    },
  );
});

test("dispatch lineage: a stamp naming its own session registers nothing", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, sessions }) => {
      sessions.set("s-self", stamped("s-self"));
      await fire(sessionHooks, "prompt", {
        sessionID: "s-self",
        prompt: { text: "a malformed stamp names itself" },
      });
      assert.equal(
        queued().find((line) => line.kind === "session"),
        undefined,
        "a self-stamped session carries no parent link to register",
      );
      const capture = queued().find((line) => line.role === "user");
      assert.ok(capture, "capture proceeds as before");
      assert.equal(capture.initiator, "human");
    },
  );
});

test("dispatch lineage: a failed stamp read neither marks nor captures, and retries", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, emit, sessions, sessionGetLog }) => {
      // No row seeded: the host read fails.
      const turn = () =>
        fire(sessionHooks, "prompt", {
          sessionID: "s-unreadable",
          prompt: { text: "the first turn of a worker nobody could read" },
        });
      await turn();
      assert.equal(
        queued().length,
        0,
        "nothing marked and nothing captured while the stamp was unreadable",
      );
      // The row lands before the second prompt; the read now succeeds.
      sessions.set("s-unreadable", stamped("ses-director"));
      await turn();
      const rows = queued();
      assert.equal(
        rows.filter((line) => line.kind === "session").length,
        1,
        "the retried lookup registers exactly once",
      );
      assert.equal(
        rows[0].kind,
        "session",
        "ordering correct once it succeeds",
      );
      assert.equal(rows[1].role, "user");
      // One read per prompt while unresolved, then the shared cache.
      assert.deepEqual(sessionGetLog, ["s-unreadable", "s-unreadable"]);
      await turn();
      assert.equal(
        queued().filter((line) => line.kind === "session").length,
        1,
        "no duplicate registration on the settled session",
      );
      assert.equal(sessionGetLog.length, 2, "the cache carried the rest");
    },
  );
});

test("dispatch lineage: deleting the session clears the stamp cache", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, emit, sessions, sessionGetLog }) => {
      sessions.set("s-reborn", stamped("ses-director"));
      await fire(sessionHooks, "prompt", {
        sessionID: "s-reborn",
        prompt: { text: "the first turn before deletion" },
      });
      await emit("session.deleted", { sessionID: "s-reborn" });
      await fire(sessionHooks, "prompt", {
        sessionID: "s-reborn",
        prompt: { text: "the re-prompt after deletion" },
      });
      // The re-prompt paid the live read again and linked again: a
      // deleted session's row may be gone from the store, so its
      // re-prompt re-registers rather than trusting the old line.
      assert.deepEqual(sessionGetLog, ["s-reborn", "s-reborn"]);
      const registrations = queued().filter((line) => line.kind === "session");
      assert.equal(registrations.length, 2);
      assert.equal(registrations[1].parent_conversation_id, "ses-director");
    },
  );
});

test("dispatch lineage: the stamp lookup is shared with the coalescing read", async () => {
  const OPEN = {
    json: {
      status: "ok",
      project: "memory-store",
      doc: "The store writes deliberate rows through one gate.",
      doc_created_at: "2026-11-05T00:00:00Z",
      inputs_count: 1,
      topk: [],
    },
  };
  await withDaemon(
    (body, url) => (url === "/session-open" ? OPEN : SILENT),
    async ({ fire, sessionHooks, sessions, sessionGetLog, synthetics }) => {
      sessions.set("s-shared", stamped("ses-director"));
      const turn = () =>
        fire(sessionHooks, "prompt", {
          sessionID: "s-shared",
          prompt: { text: "the brief whose block rides the waking prompt" },
        });
      const event = await turn();
      // The boolean answered from the same lookup the registration paid:
      // the block coalesced into the waking prompt (a stamped session's
      // route), and the cache carried the second prompt for free.
      assert.match(event.prompt.text, /Project knowledge:/);
      assert.equal(
        synthetics.length,
        0,
        "the stamped session coalesced, it did not inject",
      );
      await turn();
      assert.deepEqual(sessionGetLog, ["s-shared"]);
    },
  );
});
