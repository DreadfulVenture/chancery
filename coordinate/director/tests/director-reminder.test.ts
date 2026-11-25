import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../director.ts";

// The director package's own delegation reminder, folded inline into the
// entry (director.ts must stay a single self-contained file: the
// mail-watcher package materializes it verbatim and alone, so five watcher
// sources' cross-layout import resolves). The fixture is built from the
// host's session.context event shape — the LLM transcript messages
// ({role, content, id?}, content as an array of parts) the event carries,
// and no messageID, which belongs to the prompt event (review 651, 19042).
// A recorded synthetic sink stays asserted at zero: the splice stores
// nothing through the host. Every assertion in this file runs through the
// entry's setup, so an unwired registration fails the suite instead of
// silently going live-dead.

type ContentPart = { type: string; text?: string };
type TranscriptMessage = {
  id?: string;
  role: string;
  content: Array<ContentPart>;
};
type ContextEvent = {
  sessionID: string;
  agent: string;
  // The host's Model.Ref: {providerID, id, variant?}.
  model: { providerID: string; id: string };
  system: Array<unknown>;
  messages: Array<TranscriptMessage>;
  options: Record<string, unknown>;
  tools: Record<string, unknown>;
};

function userPrompt(text: string): TranscriptMessage {
  return { id: "msg_prompt", role: "user", content: [{ type: "text", text }] };
}

function requestContext(
  agent: string,
  messages: Array<TranscriptMessage> = [userPrompt("hello")],
): ContextEvent {
  return {
    sessionID: "ses-director",
    agent,
    model: { providerID: "test", id: "test" },
    system: [],
    messages,
    options: {},
    tools: {},
  };
}

function fakeContext() {
  const hooks: Array<{
    name: string;
    callback: (input: unknown) => Promise<void> | void;
  }> = [];
  const hookDisposals: string[] = [];
  const synthetics: Array<unknown> = [];
  const fireHook = async (name: string, input: unknown) => {
    for (const hook of hooks) {
      if (hook.name !== name) continue;
      await hook.callback(input);
    }
  };
  const ctx: any = {
    tool: {
      transform: async (
        fn: (editor: { add: (tool: unknown) => void }) => void,
      ) => {
        fn({ add: () => {} });
        return { dispose: async () => {} };
      },
    },
    session: {
      // The host synthetic sink: any call here is a persistence the splice
      // forbids, so the tests assert it stays empty rather than reading it.
      synthetic: async (input: unknown) => {
        synthetics.push(structuredClone(input));
      },
      hook: async (
        name: string,
        callback: (input: unknown) => Promise<void> | void,
      ) => {
        hooks.push({ name, callback });
        return {
          dispose: async () => {
            hookDisposals.push(name);
          },
        };
      },
    },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    },
  };
  return { ctx, hooks, hookDisposals, synthetics, fireHook };
}

// The reminder's text comes from the module through a real splice, not a
// copied constant: the load-bearing phrases are asserted against the
// spliced message's content, so the tests prove what a director session
// receives (review 651, 19046).
async function reminderText(): Promise<string> {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  const ctx = requestContext("director");
  await fixture.fireHook("context", ctx);
  const spliced = ctx.messages[0] as TranscriptMessage;
  const part = (spliced.content as Array<ContentPart>)[0];
  return part.text!;
}

test("registers on the context hook", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  // Two hooks ride the entry: the permission re-assert's prompt hook and
  // the reminder's context hook. Both dispose with teardown.
  assert.equal(fixture.hooks.length, 2);
  assert.deepEqual(
    fixture.hooks.map((hook) => hook.name),
    ["prompt", "context"],
  );
  await cleanup?.();
  assert.deepEqual(fixture.hookDisposals, ["prompt", "context"]);
});

test("splices the reminder before a director request's user prompt", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  const ctx = requestContext("director");
  await fixture.fireHook("context", ctx);

  // The splice lands before the prompt (the host's plan-mode reminder's
  // position), so the prompt stays the turn's last user message.
  assert.equal(ctx.messages.length, 2);
  const spliced = ctx.messages[0] as TranscriptMessage;
  assert.equal(spliced.role, "user");
  // No id: the host's own plan.ts splice sets none and nothing downstream
  // reads ours (review 654, 19073).
  assert.equal(spliced.id, undefined);
  const part = (spliced.content as Array<ContentPart>)[0];
  assert.equal(part.type, "text");
  const text = part.text!;
  assert.match(text, /director_dispatch/);
  assert.match(text, /director_steer/);
  assert.match(text, /coordination bookkeeping/);
  assert.match(text, /standing grant/);
  assert.deepEqual(ctx.messages[1], userPrompt("hello"));
  // The splice stores nothing through the host: no synthetic was sent.
  assert.equal(fixture.synthetics.length, 0);
  await cleanup?.();
});

test("does not splice the reminder for other agents", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  const ctx = requestContext("build");
  await fixture.fireHook("context", ctx);

  assert.deepEqual(ctx.messages, [userPrompt("hello")]);
  assert.equal(fixture.synthetics.length, 0);
  await cleanup?.();
});

test("does not splice the reminder when the agent is unset", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  const ctx = requestContext(undefined as never);
  await fixture.fireHook("context", ctx);

  assert.deepEqual(ctx.messages, [userPrompt("hello")]);
  await cleanup?.();
});

test("does not splice when the exact text is already in the window", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  // A stored copy from the old persisting mechanism rides history as a
  // user-role message whose one text part is the exact reminder text.
  const ctx = requestContext("director", [
    {
      id: "msg_old",
      role: "user",
      content: [{ type: "text", text: await reminderText() }],
    },
    userPrompt("hello"),
  ]);
  await fixture.fireHook("context", ctx);

  assert.deepEqual(ctx.messages, [
    {
      id: "msg_old",
      role: "user",
      content: [{ type: "text", text: await reminderText() }],
    },
    userPrompt("hello"),
  ]);
  assert.equal(fixture.synthetics.length, 0);
  await cleanup?.();
});

test("does not splice behind a tool-result tail", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  const ctx = requestContext("director", [
    userPrompt("hello"),
    {
      id: "msg_tool",
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "call_1",
          name: "read",
          result: { type: "json", value: "ok" },
        },
      ],
    },
  ]);
  await fixture.fireHook("context", ctx);

  assert.equal(ctx.messages.length, 2);
  assert.equal((ctx.messages[1] as TranscriptMessage).role, "tool");
  await cleanup?.();
});

test("does not splice behind an assistant tail", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  const ctx = requestContext("director", [
    userPrompt("hello"),
    {
      id: "msg_asst",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    },
  ]);
  await fixture.fireHook("context", ctx);

  assert.equal(ctx.messages.length, 2);
  assert.equal((ctx.messages[1] as TranscriptMessage).role, "assistant");
  await cleanup?.();
});

test("a splice failure is caught and logged once; the request resolves reminder-less", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  // Hostile window: the splice's own mutation throws. Through the promise
  // adapter a rejected callback fails the request preparation and the
  // director's turn dies, so the catch must resolve it — the deleted
  // persistence-era test's intent, rebuilt for the splice era.
  class HostileMessages extends Array<TranscriptMessage> {
    splice(): never {
      throw new Error("splice refused");
    }
  }
  const ctx = requestContext("director");
  ctx.messages = HostileMessages.from([userPrompt("hello")]) as never;
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  let thrown: unknown;
  try {
    await fixture.fireHook("context", ctx);
  } catch (error) {
    thrown = error;
  } finally {
    console.error = originalError;
  }
  await cleanup?.();

  assert.equal(thrown, undefined);
  assert.equal(fixture.synthetics.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[director\] reminder to ses-director failed/);
  assert.match(logs[0], /splice refused/);
  assert.match(logs[0], /The turn proceeds without it/);
});
