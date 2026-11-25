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
    async ({ emit, fire, sessionHooks, sessions }) => {
      await emit("session.created", {
        sessionID: "child9",
        parentID: "top1",
      });

      const registration = queued().find((line) => line.kind === "session");
      assert.ok(registration, "child registration enqueued");
      assert.equal(registration.conversation_id, "child9");
      assert.equal(registration.parent_conversation_id, "top1");

      // The host's parentID path is the parented carve-out (ADR
      // 20261124-session-origin-signal): even an origin record riding
      // the child's inherited metadata bag adds no second line, and a
      // child captures no turns — the parentID event already settled it.
      sessions.set("child9", {
        metadata: {
          chancery_origin: { initiator: "program", parent: "top1" },
        },
      });
      await fire(sessionHooks, "prompt", {
        sessionID: "child9",
        prompt: { text: "a subagent's own turn, which its parent reported" },
      });
      assert.equal(
        queued().filter(
          (line) =>
            line.conversation_id === "child9" && line.kind === "session",
        ).length,
        1,
        "the host parent link is the carve-out; the record adds nothing",
      );
      assert.equal(
        queued().filter(
          (line) => line.conversation_id === "child9" && line.role === "user",
        ).length,
        0,
        "a child captures no turns",
      );
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

// The origin declaration's lineage registration (PRJ-513): a
// programmatic spawn reads its declared record from the session metadata
// and registers the parent link itself, on the first prompt and ahead
// of its first capture row. The dispatch stamps the declaration beside
// the coordinator stamp, so the test rows carry both — the way the real
// create call writes them.

const dispatched = (director: string) => ({
  metadata: {
    chancery: { coordinatedBy: director },
    chancery_origin: { initiator: "program", parent: director },
  },
});

test("dispatch lineage: the worker registers its parent before its first capture", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, sessions }) => {
      sessions.set("s-worker", dispatched("ses-director"));
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
        "no declaration, no registration line",
      );
      const capture = queued().find((line) => line.role === "user");
      assert.ok(capture, "capture proceeds as before");
      assert.equal(capture.initiator, "human");
    },
  );
});

test("dispatch lineage: a record naming its own session as parent registers nothing", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, sessions }) => {
      sessions.set("s-self", dispatched("s-self"));
      await fire(sessionHooks, "prompt", {
        sessionID: "s-self",
        prompt: { text: "a malformed record names itself as parent" },
      });
      assert.equal(
        queued().find((line) => line.kind === "session"),
        undefined,
        "a self-declared session carries no parent link to register",
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
      sessions.set("s-unreadable", dispatched("ses-director"));
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
      sessions.set("s-reborn", dispatched("ses-director"));
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
      sessions.set("s-shared", dispatched("ses-director"));
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

// The remaining resolution shapes (ADR 20261124-session-origin-signal):
// declaration → programmatic whatever tool wrote the record; an
// unparsable record reads as undeclared; the coordinator stamp alone
// keeps the coalescing key and registers nothing.

test("origin lineage: a declaration from any tool registers, no coordinator stamp needed", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, sessions }) => {
      // Another tool's runtime spawn: the origin record alone — no
      // coordinator stamp, which stays the director module's mail key.
      sessions.set("s-tool", {
        metadata: {
          chancery_origin: { initiator: "program", parent: "ses-runtime" },
        },
      });
      const turn = () =>
        fire(sessionHooks, "prompt", {
          sessionID: "s-tool",
          prompt: { text: "the runtime session's own first turn" },
        });
      await turn();

      const rows = queued();
      const registration = rows.find((line) => line.kind === "session");
      assert.ok(registration, "the declared session registered its lineage");
      assert.equal(registration.conversation_id, "s-tool");
      assert.equal(registration.parent_conversation_id, "ses-runtime");
      assert.equal(registration.initiator, "agent");
      assert.equal(rows[0].kind, "session", "registration precedes capture");
      assert.equal(rows[1].role, "user");
      assert.equal(
        rows[1].initiator,
        "agent",
        "the declared session's prose is agent voice",
      );

      // One-time: later prompts capture, never re-register.
      await turn();
      assert.equal(
        queued().filter((line) => line.kind === "session").length,
        1,
        "the registration is a one-time line per session",
      );
    },
  );
});

test("origin lineage: a foreign stamp or an unparsable record stays undeclared", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, sessions }) => {
      // A stamp under another key never reads as a declaration, and a
      // record using a vocabulary the declaration does not carry (the
      // opencode `agent` word) or missing its parent does not parse —
      // absence is the human default.
      sessions.set("s-foreign", {
        metadata: {
          bot_origin: { initiator: "program", parent: "ses-tool" },
          chancery_origin: { initiator: "agent" },
        },
      });
      await fire(sessionHooks, "prompt", {
        sessionID: "s-foreign",
        prompt: { text: "a turn whose metadata never declared an origin" },
      });
      assert.equal(
        queued().find((line) => line.kind === "session"),
        undefined,
        "an unparsable record cannot invent a parent link",
      );
      const capture = queued().find((line) => line.role === "user");
      assert.ok(capture, "capture proceeds as before");
      assert.equal(capture.initiator, "human");
    },
  );
});

test("origin lineage: the coordinator stamp alone keeps the coalescing key and registers nothing", async () => {
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
    async ({ fire, sessionHooks, sessions, synthetics }) => {
      // A worker dispatched by a director predating the declaration: the
      // coordinator stamp alone. The wake ordering still coalesces its
      // block (the key is unchanged), and without a declaration the
      // session stays on the human default.
      sessions.set("s-legacy", {
        metadata: { chancery: { coordinatedBy: "ses-director" } },
      });
      const event = await fire(sessionHooks, "prompt", {
        sessionID: "s-legacy",
        prompt: { text: "the legacy worker's brief" },
      });
      assert.match(
        event.prompt.text,
        /Project knowledge:/,
        "the coordinator stamp still drives the coalescing route",
      );
      assert.equal(
        synthetics.length,
        0,
        "the coordinator-stamped session coalesced, it did not inject",
      );
      assert.equal(
        queued().find((line) => line.kind === "session"),
        undefined,
        "without a declaration there is no lineage to register",
      );
      const capture = queued().find((line) => line.role === "user");
      assert.ok(capture, "capture proceeds as before");
      assert.equal(capture.initiator, "human");
    },
  );
});

test("origin lineage: the record's parent trims like the driven pointer, and a blank parent is absent", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, sessionHooks, sessions }) => {
      // A padded-but-real parent registers with the trimmed id — the
      // same trust step the driven path applies to its external
      // pointer: trim, then accept only what is usable.
      sessions.set("s-padded", {
        metadata: {
          chancery_origin: { initiator: "program", parent: "  ses-outer  " },
        },
      });
      await fire(sessionHooks, "prompt", {
        sessionID: "s-padded",
        prompt: { text: "the padded declaration's first turn" },
      });
      const padded = queued().find((line) => line.kind === "session");
      assert.ok(padded, "the padded record registered its lineage");
      assert.equal(padded.conversation_id, "s-padded");
      assert.equal(padded.parent_conversation_id, "ses-outer");
      const paddedCapture = queued().find(
        (line) => line.role === "user" && line.conversation_id === "s-padded",
      );
      assert.ok(paddedCapture, "the declared capture proceeds");
      assert.equal(paddedCapture.initiator, "agent");

      // A whitespace parent names no session: blank after the trim is
      // absent, exactly like a half-written record — nothing registers
      // and the capture keeps the human default (review 580, count
      // 18519).
      sessions.set("s-blank", {
        metadata: {
          chancery_origin: { initiator: "program", parent: "   " },
        },
      });
      await fire(sessionHooks, "prompt", {
        sessionID: "s-blank",
        prompt: { text: "a turn whose parent never names a session" },
      });
      assert.equal(
        queued().find(
          (line) =>
            line.kind === "session" && line.conversation_id === "s-blank",
        ),
        undefined,
        "a blank parent cannot invent a parent link",
      );
      const blankCapture = queued().find(
        (line) => line.role === "user" && line.conversation_id === "s-blank",
      );
      assert.ok(blankCapture, "capture proceeds as before");
      assert.equal(blankCapture.initiator, "human");
    },
  );
});
