import assert from "node:assert/strict";
import test from "node:test";
import { withDaemon, SILENT } from "./harness.ts";

// Tool-moment delivery (PRJ-170): enrolled tool_rules speak at the
// moment a bound tool is used. With holds ON the first execution per
// conversation is REJECTED — the before-hook throws, and the thrown
// message is the daemon's rendered rule text. With holds OFF everything
// is informational, delivered as a synthetic beside the tool's output.

const MOMENT = {
  json: {
    status: "ok",
    held: false,
    error: "",
    deliveries: [
      {
        rule_id: "tr_1",
        tool_id: "tool_1",
        key: ["git", "push"],
        scope: "project",
        project: "memory-store",
        note: "Run make test before pushing.",
        held: false,
        created_at: "2026-11-06T00:00:00Z",
        section: "## Tool rule\n\nA rule bound to this tool.",
      },
    ],
  },
};

const HELD = {
  json: {
    status: "ok",
    held: true,
    error:
      "Held by a stored tool rule (first execution of this tool in this conversation):\n- Run make test before pushing.",
    deliveries: [{ ...MOMENT.json.deliveries[0], held: true }],
  },
};

async function withMoment(reply, run, config = {}) {
  await withDaemon(
    reply,
    async (h) => {
      const before = (input, sessionID = "s-tool") =>
        h.fire(h.toolHooks, "execute.before", {
          tool: "shell",
          sessionID,
          id: "call-1",
          input,
        });
      const after = (input, sessionID = "s-tool") =>
        h
          .fire(h.toolHooks, "execute.after", {
            tool: "shell",
            sessionID,
            id: "call-1",
            status: "completed",
            input,
            result: { content: [{ type: "text", text: "ok" }] },
          })
          .then(() => h.synthetics.at(-1)?.text);
      await run({ ...h, before, after });
    },
    config,
  );
}

test("a held fire rejects the call with the rule as its error text", async () => {
  await withMoment(
    (body, url) => (url === "/tool-moment" ? HELD : SILENT),
    async ({ before }) => {
      await assert.rejects(
        before({ command: "git push" }),
        /Run make test before pushing\./,
        "the thrown message IS the delivery",
      );
    },
  );
});

test("an informational fire lands as a synthetic beside the output", async () => {
  await withMoment(
    (body, url) => (url === "/tool-moment" ? MOMENT : SILENT),
    async ({ before, after }) => {
      await before({ command: "git push" });
      const text = await after({ command: "git push" });
      assert.match(text, /## Tool rule/);
      assert.match(text, /Run make test before pushing\. \(rule tr_1\)/);
      assert.match(
        text,
        /\(project: memory-store\)/,
        "provenance rides the frame",
      );
    },
  );
});

test("an unbound command fetches nothing and delivers nothing", async () => {
  await withMoment(
    (body, url) => {
      if (url !== "/tool-moment") return SILENT;
      assert.equal(body.event.command, "ls -la");
      return { json: { status: "ok", held: false, deliveries: [] } };
    },
    async ({ before, after, bodies }) => {
      await before({ command: "ls -la" });
      const text = await after({ command: "ls -la" });
      assert.equal(text, undefined, "no block when nothing fired");
      assert.equal(bodies.filter((b) => b.path === "/tool-moment").length, 1);
    },
  );
});

test("the moment event is only fetched once per tool call", async () => {
  await withMoment(
    (body, url) => (url === "/tool-moment" ? MOMENT : SILENT),
    async ({ before, after, bodies }) => {
      await before({ command: "git push" });
      await after({ command: "git push" });
      assert.equal(
        bodies.filter((b) => b.path === "/tool-moment").length,
        1,
        "the after-hook reads the pending block, it does not re-fetch",
      );
    },
  );
});

test("tool_rule_add carries the session link and cwd the same way remember does", async () => {
  await withMoment(
    () => SILENT,
    async ({ fire, toolHooks }) => {
      // Both stamps are the plugin's job: the session link overwrites
      // whatever the model supplied, and cwd is what the project
      // resolution trusts — an add without it cannot scope honestly.
      const event = {
        tool: "memory_tool_rule_add",
        sessionID: "s-add",
        id: "call-add",
        input: {
          kind: "command",
          key: "git push",
          note: "n",
          conversation_id: "forged",
        },
      };
      await fire(toolHooks, "execute.before", event);
      assert.equal(
        event.input.conversation_id,
        "s-add",
        "the enrolling session is the rule's provenance",
      );
      assert.equal(
        typeof event.input.cwd,
        "string",
        "cwd is injected for project resolution",
      );
      assert.notEqual(event.input.cwd, "");
    },
  );
});

test("the curation verbs carry cwd (and the session link where they write)", async () => {
  await withMoment(
    () => SILENT,
    async ({ fire, toolHooks }) => {
      // lookup and copy resolve visibility/project from cwd; promote has
      // no cwd (the rule id pins the source) but still gets the session
      // link — it writes the global twin's provenance.
      const lookup = {
        tool: "memory_tool_rule_lookup",
        sessionID: "s-cur",
        id: "call-lookup",
        input: { kind: "command", key: "git push" },
      };
      await fire(toolHooks, "execute.before", lookup);
      assert.equal(typeof lookup.input.cwd, "string", "lookup gets cwd");
      assert.equal(
        lookup.input.conversation_id,
        undefined,
        "lookup is a read; no link",
      );

      const copy = {
        tool: "memory_tool_rule_copy",
        sessionID: "s-cur",
        id: "call-copy",
        input: { rule_id: "tr_1" },
      };
      await fire(toolHooks, "execute.before", copy);
      assert.equal(typeof copy.input.cwd, "string", "copy gets cwd");
      assert.equal(
        copy.input.conversation_id,
        "s-cur",
        "copy's row carries the acting session",
      );

      const promote = {
        tool: "memory_tool_rule_promote",
        sessionID: "s-cur",
        id: "call-promote",
        input: { rule_id: "tr_2" },
      };
      await fire(toolHooks, "execute.before", promote);
      assert.equal(promote.input.cwd, undefined, "promote takes no cwd");
      assert.equal(
        promote.input.conversation_id,
        "s-cur",
        "promote's twin carries the acting session",
      );
    },
  );
});

test("a failed call clears its pending delivery", async () => {
  await withMoment(
    (body, url) => (url === "/tool-moment" ? MOMENT : SILENT),
    async ({ fire, toolHooks, synthetics }) => {
      // The before-hook fetched an informational moment; the call then
      // errored. The after-hook consumes (and drops) the pending block —
      // it must not narrate the next tool's output.
      await fire(toolHooks, "execute.before", {
        tool: "shell",
        sessionID: "s-stale",
        id: "call-a",
        input: { command: "git push" },
      });
      await fire(toolHooks, "execute.after", {
        tool: "shell",
        sessionID: "s-stale",
        id: "call-a",
        status: "error",
        error: { message: "boom" },
        input: { command: "git push" },
      });
      await fire(toolHooks, "execute.after", {
        tool: "shell",
        sessionID: "s-stale",
        id: "call-b",
        status: "completed",
        input: { command: "ls" },
        result: { content: [{ type: "text", text: "ok" }] },
      });
      assert.equal(
        synthetics.filter((s) => s.sessionID === "s-stale").length,
        0,
        "no stale block lands on the next completed call",
      );
    },
  );
});
