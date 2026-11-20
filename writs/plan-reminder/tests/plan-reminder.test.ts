import assert from "node:assert/strict";
import test from "node:test";
import planReminder from "../plan-reminder.ts";

// The plugin registers through ctx.session.hook — the test asserts the
// registration call itself, so a regression back to an unwired registration
// path (the dotted hook-map shape) fails here instead of silently going
// live-dead.

function fakeCtx(agent: string | undefined) {
  const registrations: Record<
    string,
    (event: unknown) => Promise<void> | void
  > = {};
  const sessionGets: Array<{ sessionID: string }> = [];
  const synthetics: Array<{ sessionID: string; text: string }> = [];
  const ctx = {
    session: {
      hook: async (
        name: string,
        cb: (event: unknown) => Promise<void> | void,
      ) => {
        registrations[name] = cb;
      },
      get: async (input: { sessionID: string }) => {
        sessionGets.push(input);
        return { agent };
      },
      synthetic: async (input: { sessionID: string; text: string }) => {
        synthetics.push(input);
      },
    },
  };
  return { ctx, registrations, sessionGets, synthetics };
}

test("registers on the prompt hook", async () => {
  const { ctx, registrations } = fakeCtx("plan");
  await planReminder.setup(ctx as never);
  assert.equal(typeof registrations.prompt, "function");
});

test("persists a synthetic reminder for plan sessions", async () => {
  const { ctx, registrations, sessionGets, synthetics } = fakeCtx("plan");
  await planReminder.setup(ctx as never);
  await registrations.prompt({ sessionID: "ses_test", prompt: { text: "hi" } });

  assert.deepEqual(sessionGets, [{ sessionID: "ses_test" }]);
  assert.equal(synthetics.length, 1);
  assert.equal(synthetics[0].sessionID, "ses_test");
  assert.match(synthetics[0].text, /Plan mode is ACTIVE/);
  assert.match(synthetics[0].text, /\.opencode\/plan\//);
});

test("does not persist a reminder for other agents", async () => {
  const { ctx, registrations, synthetics } = fakeCtx("build");
  await planReminder.setup(ctx as never);
  await registrations.prompt({ sessionID: "ses_test", prompt: { text: "hi" } });

  assert.equal(synthetics.length, 0);
});

test("does not persist a reminder when the agent is unset", async () => {
  const { ctx, registrations, synthetics } = fakeCtx(undefined);
  await planReminder.setup(ctx as never);
  await registrations.prompt({ sessionID: "ses_test", prompt: { text: "hi" } });

  assert.equal(synthetics.length, 0);
});
