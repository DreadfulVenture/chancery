import assert from "node:assert/strict";
import test from "node:test";
import discoveryReminder from "../discovery-reminder.ts";

const reminder = `<system-reminder>
Discovery mode is for brainstorming: explore, analyze, and offer options — the deliverable is understanding, not plans or action. Read-only. Inspect the implementation and relevant history before making assumptions. Only write an explicitly requested Markdown PRD or ADR under docs/prd/ or docs/adr/.
</system-reminder>`;

function userMessage(agent: string) {
  return {
    id: "msg_" + agent,
    type: "user" as const,
    text: "hello",
    time: { created: 0 },
  };
}

function context(agent: string, messages: unknown[] = [userMessage(agent)]) {
  return {
    sessionID: "ses_test",
    messageID: "msg_parent",
    agent,
    model: { modelID: "test", providerID: "test" },
    system: [],
    messages,
    options: {},
    tools: {},
  };
}

test("plugin satisfies the v2 module contract", async () => {
  const hooks = await discoveryReminder.setup();
  assert.equal(hooks["session.context"] instanceof Function, true);
});

test("adds a standalone synthetic reminder for discovery requests", async () => {
  const hooks = await discoveryReminder.setup();
  const ctx = context("discovery");

  await hooks["session.context"]!(ctx as never);

  assert.deepEqual(ctx.messages[1], {
    id: "msg_discovery-discovery-reminder",
    type: "synthetic",
    text: reminder,
    time: { created: 0 },
  });
});

test("does not add the reminder for another agent", async () => {
  const hooks = await discoveryReminder.setup();
  const ctx = context("build");

  await hooks["session.context"]!(ctx as never);

  assert.deepEqual(ctx.messages, [userMessage("build")]);
});

test("does not duplicate the reminder", async () => {
  const hooks = await discoveryReminder.setup();
  const ctx = context("discovery");

  await hooks["session.context"]!(ctx as never);
  await hooks["session.context"]!(ctx as never);

  assert.deepEqual(
    ctx.messages.filter((message) => message.type === "synthetic"),
    [
      {
        id: "msg_discovery-discovery-reminder",
        type: "synthetic",
        text: reminder,
        time: { created: 0 },
      },
    ],
  );
});
