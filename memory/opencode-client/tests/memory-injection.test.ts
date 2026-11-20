import assert from "node:assert/strict";
import test from "node:test";
import { HOME, plugin, withDaemon, SILENT } from "./harness.ts";

test("injects cwd into memory tool calls before execution", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, toolHooks }) => {
      const call = await fire(toolHooks, "execute.before", {
        tool: "memory_memory_remember",
        sessionID: "s1",
        input: { content: "x" },
      });
      assert.equal(call.input.cwd, HOME);
    },
  );
});

test("the deliberate write carries its session as conversation_id", async () => {
  // Provenance binding: the write must link the conversation it happened
  // in, and a model-supplied value is overwritten — the injection is the
  // only source of the session id. The lineage initiator does not ride
  // the arguments at all: it lives on the connection URL the deployment
  // built, and the daemon strips whatever the model puts here (PRD
  // 20261114-lineage-gated-writes).
  await withDaemon(
    () => SILENT,
    async ({ fire, toolHooks, mcp }) => {
      const call = await fire(toolHooks, "execute.before", {
        tool: "memory_memory_remember",
        sessionID: "ses-live",
        input: {
          content: "x",
          conversation_id: "model-forged-id",
          initiator: "agent",
        },
      });
      assert.equal(call.input.conversation_id, "ses-live");
      assert.equal(call.input.initiator, "agent");
      const registered = mcp.memory as { url: string };
      assert.ok(
        registered.url.includes("initiator=human"),
        "the connection declares the initiator",
      );
      // The reads whose provenance pointers the gate redacts carry the
      // session too — the gate decides whether pointers may be shown.
      const recall = await fire(toolHooks, "execute.before", {
        tool: "memory_memory_recall",
        sessionID: "ses-live",
        input: {
          query: "x",
          conversation_id: "model-forged-id",
        },
      });
      assert.equal(recall.input.conversation_id, "ses-live");
    },
  );
});

test("the other lineage-gated writes carry the session link", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, toolHooks }) => {
      for (const tool of [
        "memory_memory_update",
        "memory_memory_forget",
        "memory_rule_codify",
        "memory_rule_feedback",
        "memory_tool_rule_add",
        "memory_tool_rule_remove",
        "memory_persona_codify",
        "memory_knowledge_read",
        "memory_memory_list",
        "memory_memory_find_conversations",
      ]) {
        const call = await fire(toolHooks, "execute.before", {
          tool,
          sessionID: "ses-live",
          input: { conversation_id: "model-forged-id" },
        });
        assert.equal(
          call.input.conversation_id,
          "ses-live",
          `${tool} got the session`,
        );
      }
    },
  );
});

test("injects cwd into recall and codify calls", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, toolHooks }) => {
      for (const tool of ["memory_memory_recall", "memory_rule_codify"]) {
        const call = await fire(toolHooks, "execute.before", {
          tool,
          sessionID: "s1",
          input: {},
        });
        assert.equal(call.input.cwd, HOME, `${tool} got cwd`);
      }
    },
  );
});

test("leaves non-memory tools untouched", async () => {
  await withDaemon(
    () => SILENT,
    async ({ fire, toolHooks }) => {
      const call = await fire(toolHooks, "execute.before", {
        tool: "read",
        sessionID: "s1",
        input: { filePath: "/tmp/opencode/gcloud.md" },
      });
      assert.equal(call.input.cwd, undefined);
      assert.equal(call.input.filePath, "/tmp/opencode/gcloud.md");
    },
  );
});
