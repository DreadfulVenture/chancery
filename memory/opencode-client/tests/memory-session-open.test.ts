import assert from "node:assert/strict";
import test from "node:test";
import { HOME, plugin, queued, withDaemon, SILENT } from "./harness.ts";

const { formatSessionOpen } = plugin;

// The daemon reply for a repo with a standing doc. Fixtures stand in for
// the served text; what is asserted here is the passing through of it and
// the framing around it.
const OPEN = {
  json: {
    status: "ok",
    project: "memory-store",
    doc: "The store writes deliberate rows through one gate.",
    doc_created_at: "2026-11-05T00:00:00Z",
    inputs_count: 3,
    topk: [
      {
        id: "m1",
        content: "the fold cursor is composite",
        timestamp: "2026-11-05T01:00:00Z",
        veracity: "stated",
        author_type: "human",
        score: 0.9,
      },
    ],
  },
};

// SILENT answers any leftover route; the session-open call is judged by
// path.
const both = (open) => (body, url) => (url === "/session-open" ? open : SILENT);

// The dispatch stamp the director module writes at create time (PRJ-343): the
// worker's session record names its coordinator under the shared namespace.
const WORKER_ROW = {
  metadata: {
    chancery: { coordinatedBy: "ses-coordinator", slice: "a slice" },
  },
};

test("a director-dispatched worker's block coalesces into the waking prompt", async () => {
  await withDaemon(
    both(OPEN),
    async ({ fire, sessionHooks, synthetics, bodies, sessions }) => {
      sessions.set("s-worker", WORKER_ROW);
      const brief = "prj-3xx slice: land the brief on the first turn";
      const turn = () =>
        fire(sessionHooks, "prompt", {
          sessionID: "s-worker",
          prompt: { text: brief },
        });
      const event = await turn();
      // The promoted inbox item is built from this mutable hook payload:
      // the brief leads and the block rides the same item, so the worker's
      // first turn runs them together — nothing competes at the boundary.
      assert.equal(
        synthetics.length,
        0,
        "no item entered the inbox beside the brief",
      );
      assert.match(
        event.prompt.text,
        /^prj-3xx slice: land the brief on the first turn/,
        "the brief still leads the waking prompt",
      );
      assert.match(event.prompt.text, /Project knowledge:/);
      assert.match(event.prompt.text, /The store writes deliberate rows/);
      // The fetch saw the brief alone, once; then the compliance leg (the
      // same two round trips a first interactive prompt makes).
      assert.deepEqual(
        bodies.map((b) => b.path),
        ["/session-open", "/compliance"],
      );
      assert.equal(bodies[0].body.prompt, brief);
      await turn();
      assert.equal(
        bodies.filter((b) => b.path === "/session-open").length,
        1,
        "a coalesced block settles its session like a synthetic one",
      );
      // Capture keeps the coordinator's words: the block is context the
      // plugin delivered, not the turn's own prompt.
      assert.deepEqual(
        queued().map((row) => row.text),
        [brief, brief],
      );
    },
  );
});

test("an interactive session keeps the synthetic route and its text untouched", async () => {
  await withDaemon(
    both(OPEN),
    async ({ fire, sessionHooks, synthetics, sessions }) => {
      // A real host row with no dispatch stamp: the human's own session.
      sessions.set("s-human", { metadata: {} });
      const event = await fire(sessionHooks, "prompt", {
        sessionID: "s-human",
        prompt: { text: "fix the flaky kb test" },
      });
      assert.ok(
        synthetics.some((s) => s.text.includes("Project knowledge:")),
        "the block rides the synthetic, exactly as shipped before PRJ-344",
      );
      assert.equal(
        event.prompt.text,
        "fix the flaky kb test",
        "an interactive session's prompt is never rewritten",
      );
    },
  );
});

test("a failed session lookup keeps today's synthetic route", async () => {
  await withDaemon(both(OPEN), async ({ fire, sessionHooks, synthetics }) => {
    // No session row seeded: the host read fails, this prompt takes
    // today's route, and the lookup is paid again on the next one
    // instead of the failure hardening into an answer.
    const event = await fire(sessionHooks, "prompt", {
      sessionID: "s-unreach",
      prompt: { text: "fix the flaky kb test" },
    });
    assert.ok(
      synthetics.some((s) => s.text.includes("Project knowledge:")),
      "the block rode the synthetic while the stamp was unreadable",
    );
    assert.equal(event.prompt.text, "fix the flaky kb test");
  });
});

test("the first prompt injects the session-start block", async () => {
  await withDaemon(
    both(OPEN),
    async ({ fire, sessionHooks, synthetics, bodies }) => {
      const turn = () =>
        fire(sessionHooks, "prompt", {
          sessionID: "s1",
          prompt: { text: "fix the flaky kb test" },
        });
      await turn();
      const at = synthetics.findIndex((s) =>
        s.text.includes("Project knowledge:"),
      );
      assert.ok(at >= 0, "the block rode a synthetic");
      const block = synthetics[at].text;
      assert.match(
        block,
        /composed 2026-11-05T00:00:00Z, folded from 3 recorded row/,
      );
      assert.match(
        block,
        /The store writes deliberate rows through one gate\./,
      );
      assert.match(block, /Facts matching this request:/);
      assert.match(
        block,
        /- m1 \[2026-11-05T01:00:00Z\] \(stated, human\) the fold cursor is composite/,
        "each fact carries its row id so the correction protocol is actionable",
      );
      assert.match(block, /Judge relevance and ignore what does not apply/);
      assert.match(block, /memory_remember/);
      assert.match(block, /knowledge_read/);
      // The fetches a first prompt makes: session-open, then the
      // compliance turn report (PRD-179) — the reminder would be the only
      // thing the turn leg delivers.
      assert.deepEqual(
        bodies.map((b) => b.path),
        ["/session-open", "/compliance"],
      );
      // The fetch carried the opening request and the project root.
      const open = bodies[0];
      assert.equal(open.body.prompt, "fix the flaky kb test");
      assert.equal(open.body.cwd, HOME);
      // One fetch per session: the second prompt asks the daemon nothing.
      await turn();
      assert.equal(
        bodies.filter((b) => b.path === "/session-open").length,
        1,
        "settled sessions do not re-fetch",
      );
    },
  );
});

test("a repo without a KB settles the session in silence", async () => {
  await withDaemon(
    both({ json: { status: "ok", doc: null } }),
    async ({ fire, sessionHooks, synthetics, bodies }) => {
      const turn = () =>
        fire(sessionHooks, "prompt", {
          sessionID: "s1",
          prompt: { text: "fix the flaky kb test" },
        });
      await turn();
      await turn();
      assert.equal(synthetics.length, 0, "nothing injected");
      assert.equal(
        bodies.filter((b) => b.path === "/session-open").length,
        1,
        "the honest no is final for the session",
      );
    },
  );
});

test("a child session never asks for the block", async () => {
  await withDaemon(both(OPEN), async ({ fire, sessionHooks, emit, bodies }) => {
    await emit("session.created", {
      sessionID: "s-child",
      parentID: "s-parent",
    });
    await fire(sessionHooks, "prompt", {
      sessionID: "s-child",
      prompt: { text: "subagent work on a repo with a KB" },
    });
    assert.equal(bodies.filter((b) => b.path === "/session-open").length, 0);
  });
});

test("a refused fetch retries on the next prompt", async () => {
  let calls = 0;
  await withDaemon(
    (body, url) => {
      if (url !== "/session-open") return SILENT;
      calls += 1;
      return calls === 1 ? { status: 503, json: { status: "busy" } } : OPEN;
    },
    async ({ fire, sessionHooks, synthetics }) => {
      const turn = () =>
        fire(sessionHooks, "prompt", {
          sessionID: "s1",
          prompt: { text: "fix the flaky kb test" },
        });
      await turn();
      assert.equal(synthetics.length, 0, "the 503 delivered nothing");
      await turn();
      assert.ok(
        synthetics.some((s) => s.text.includes("Project knowledge:")),
        "the retry on prompt two landed the block",
      );
    },
    { session_open_backoff_ms: "0" },
  );
});

test("a failed fetch retries too", async () => {
  let calls = 0;
  await withDaemon(
    (body, url) => {
      if (url !== "/session-open") return SILENT;
      calls += 1;
      return calls === 1 ? { crash: true } : OPEN;
    },
    async ({ fire, sessionHooks, synthetics }) => {
      await fire(sessionHooks, "prompt", {
        sessionID: "s1",
        prompt: { text: "fix the flaky kb test" },
      });
      await fire(sessionHooks, "prompt", {
        sessionID: "s1",
        prompt: { text: "fix the flaky kb test" },
      });
      assert.ok(
        synthetics.some((s) => s.text.includes("Project knowledge:")),
        "the daemon blip did not cost the session its block",
      );
    },
    { session_open_backoff_ms: "0" },
  );
});

test("slash commands as first prompt do not settle the session", async () => {
  await withDaemon(
    both(OPEN),
    async ({ fire, sessionHooks, synthetics, bodies }) => {
      await fire(sessionHooks, "prompt", {
        sessionID: "s1",
        prompt: { text: "/compact the session" },
      });
      assert.equal(
        bodies.filter((b) => b.path === "/session-open").length,
        0,
        "mechanical commands are not an opening request",
      );
      await fire(sessionHooks, "prompt", {
        sessionID: "s1",
        prompt: { text: "now the real opening request" },
      });
      assert.ok(synthetics.some((s) => s.text.includes("Project knowledge:")));
    },
  );
});

test("the block is short a request with no matching facts", async () => {
  const rendered = formatSessionOpen({
    project: "example",
    doc: "The deploy gate is on.",
    doc_created_at: "2026-11-05T00:00:00Z",
    inputs_count: 2,
    topk: [],
  });
  assert.doesNotMatch(rendered, /Facts matching this request/);
  assert.match(rendered, /The deploy gate is on\./);
});

test("facts elide at the shared budget", () => {
  const long = "y".repeat(3000);
  const rendered = formatSessionOpen({
    project: "example",
    doc: "doc",
    doc_created_at: "2026-11-05T00:00:00Z",
    inputs_count: 1,
    topk: [
      {
        id: "m1",
        content: long,
        timestamp: "2026-11-05T01:00:00Z",
        veracity: "stated",
        author_type: "human",
        score: 1,
      },
    ],
  });
  assert.match(
    rendered,
    /…\[truncated\]…/,
    "head+tail elision, same as every surface",
  );
  assert.match(
    rendered,
    / \[truncated\]\n/,
    "the frame marks the truncation, like frameMemories",
  );
  assert.ok(rendered.length < 3000, "the elided fact is bounded");
});

test("overlapping prompts fetch the block once", async () => {
  await withDaemon(
    both(OPEN),
    async ({ fire, sessionHooks, synthetics, bodies }) => {
      // Both hook invocations start before either settles: the first
      // fetch is still in flight when the second prompt arrives.
      const first = fire(sessionHooks, "prompt", {
        sessionID: "s-race",
        prompt: { text: "fix the flaky kb test" },
      });
      const second = fire(sessionHooks, "prompt", {
        sessionID: "s-race",
        prompt: { text: "and also look at the cursor" },
      });
      await Promise.all([first, second]);
      assert.equal(
        bodies.filter((b) => b.path === "/session-open").length,
        1,
        "the in-flight guard closes the double-injection window",
      );
      assert.equal(
        synthetics.filter((s) => s.text.includes("Project knowledge:")).length,
        1,
      );
    },
  );
});

test("a failed fetch backs off before it retries", async () => {
  let calls = 0;
  await withDaemon(
    (body, url) => {
      if (url !== "/session-open") return SILENT;
      calls += 1;
      return calls === 1 ? { crash: true } : OPEN;
    },
    async ({ fire, sessionHooks, synthetics, bodies }) => {
      const turn = () =>
        fire(sessionHooks, "prompt", {
          sessionID: "s-backoff-open",
          prompt: { text: "fix the flaky kb test" },
        });
      await turn();
      await turn();
      assert.equal(
        bodies.filter((b) => b.path === "/session-open").length,
        1,
        "the backoff window suppresses the immediate retry",
      );
      assert.equal(synthetics.length, 0);
    },
    { session_open_backoff_ms: "60000" },
  );
});
