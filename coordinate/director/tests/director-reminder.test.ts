import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../director.ts";

// The director package's own delegation reminder, folded inline into the
// entry (director.ts must stay a single self-contained file: the
// mail-watcher package materializes it verbatim and alone, so five watcher
// sources' cross-layout import resolves).
//
// The fixtures mirror the host shapes the mechanism rides, at v2.3.0 —
// the deployed serve's version (verified live; nixpkgs-unstable carries
// the same 2.3.0):
//
// - The reconcile fixture is the host's session.context event shape — the
//   LLM transcript messages ({role, content, id?}, content as an array of
//   parts) the event carries, and no messageID, which belongs to the
//   prompt event (review 651, 19042).
// - The persistence fixtures are the two event types the trigger
//   subscribes to, session.created and session.agent.selected (the host
//   schema's shapes at v2.3.0: created carries an optional agent,
//   selected carries agent and previous), and the synthetic sink
//   records every persist with its resume flag — the resume:false flag
//   is what keeps a stored reminder from waking the session, so every
//   persistence assertion reads it.
// - The fake event surface hands each subscription its own channel and
//   delivers pushed events to every open one, like the host delivers
//   every event to every subscriber; the requested types filter is
//   recorded, so the suite pins the trigger's subscription.
//
// Every assertion in this file runs through the entry's setup, so an
// unwired registration fails the suite instead of silently going
// live-dead.

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
type SyntheticCall = {
  sessionID: string;
  text: string;
  resume?: boolean;
};
type HostEvent = { id?: string; type: string; data?: any };

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

// A stored copy of a reminder rides history as a user-role message whose
// one text part is the reminder text — the shape the old persisting
// mechanism left in stored history, and the shape a persisted synthetic
// takes in every window after this mechanism's own persistence.
function storedReminder(text: string): TranscriptMessage {
  return {
    id: "msg_stored",
    role: "user",
    content: [{ type: "text", text }],
  };
}

function fakeContext() {
  const hooks: Array<{
    name: string;
    callback: (input: unknown) => Promise<void> | void;
  }> = [];
  const hookDisposals: string[] = [];
  const synthetics: SyntheticCall[] = [];
  // The event surface: one channel per subscription, every pushed event
  // delivered to every open channel, the requested types filter recorded.
  const channels: Array<{
    queue: HostEvent[];
    types?: string[];
    wake: () => void;
  }> = [];
  const subscriptions: Array<{ types?: string[] }> = [];
  const pushEvent = (event: HostEvent) => {
    for (const channel of channels) {
      if (channel.types && !channel.types.includes(event.type)) continue;
      channel.queue.push(event);
      channel.wake();
    }
  };
  const fireHook = async (name: string, input: unknown) => {
    for (const hook of hooks) {
      if (hook.name !== name) continue;
      await hook.callback(input);
    }
  };
  // Lets the trigger's async loop drain a pushed event: two macrotask
  // boundaries cover push → wake → yield → await sink → record.
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
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
      // The host synthetic sink: the persistence legs' only write surface.
      // Every record carries what was persisted, resume flag included.
      synthetic: async (input: SyntheticCall) => {
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
      subscribe: (input?: { signal?: AbortSignal; types?: string[] }) => {
        subscriptions.push({ types: input?.types });
        const channel = {
          queue: [] as HostEvent[],
          types: input?.types,
          wake: () => {},
        };
        channels.push(channel);
        const abort = () => {
          channel.wake();
        };
        input?.signal?.addEventListener("abort", abort, { once: true });
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                while (channel.queue.length === 0) {
                  await new Promise<void>((resolve) => {
                    channel.wake = resolve;
                  });
                  if (input?.signal?.aborted) {
                    return { done: true as const, value: undefined };
                  }
                }
                return { done: false as const, value: channel.queue.shift()! };
              },
            };
          },
        };
      },
    },
  };
  return {
    ctx,
    hooks,
    hookDisposals,
    synthetics,
    fireHook,
    pushEvent,
    subscriptions,
    settle,
  };
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

async function leaveText(): Promise<string> {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  // The leave line is produced on the stale reconcile: the window carries
  // the reminder, the agent is no longer the director.
  const reminder = await reminderText();
  const ctx = requestContext("build", [
    storedReminder(reminder),
    userPrompt("hello"),
  ]);
  await fixture.fireHook("context", ctx);
  const spliced = ctx.messages[1] as TranscriptMessage;
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

test("the persistence trigger subscribes types-filtered, like plan.ts's subscription", async () => {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  // One subscription for the reminder leg (the pump's own subscription is
  // unfiltered and rides the same fake): the two types plan.ts's
  // persistence trigger subscribes to.
  assert.deepEqual(
    fixture.subscriptions.filter((s) => s.types !== undefined),
    [{ types: ["session.created", "session.agent.selected"] }],
  );
});

test("splices the reminder before a director request's user prompt and persists it", async () => {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  const ctx = requestContext("director");
  await fixture.fireHook("context", ctx);

  // The splice lands before the prompt (the host's plan-mode reminder's
  // position), so the prompt stays the turn's last user message.
  assert.equal(ctx.messages.length, 2);
  const spliced = ctx.messages[0] as TranscriptMessage;
  assert.equal(spliced.role, "user");
  // No id: the host's own splice sets none and nothing downstream reads
  // ours (review 654, 19073).
  assert.equal(spliced.id, undefined);
  const part = (spliced.content as Array<ContentPart>)[0];
  assert.equal(part.type, "text");
  const text = part.text!;
  assert.match(text, /director_dispatch/);
  assert.match(text, /director_steer/);
  assert.match(text, /coordination bookkeeping/);
  assert.match(text, /standing grant/);
  assert.deepEqual(ctx.messages[1], userPrompt("hello"));
  // What was spliced is persisted, resume:false — the transcript carries
  // it into the next window without waking the session.
  assert.deepEqual(fixture.synthetics, [
    { sessionID: "ses-director", text, resume: false },
  ]);
});

test("appends the reminder after a non-user tail, the plan position rule", async () => {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  // A continuation step after tool results ends in a tool-role tail; the
  // plan-mode reminder's position rule appends there rather than
  // skipping, so the reminder rides every director assembly.
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

  assert.equal(ctx.messages.length, 3);
  const appended = ctx.messages[2] as TranscriptMessage;
  assert.equal(appended.role, "user");
  assert.equal((appended.content[0] as ContentPart).text, await reminderText());
  assert.equal(fixture.synthetics.length, 1);
  assert.equal(fixture.synthetics[0].resume, false);
});

test("does not splice the reminder for other agents", async () => {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  const ctx = requestContext("build");
  await fixture.fireHook("context", ctx);

  assert.deepEqual(ctx.messages, [userPrompt("hello")]);
  assert.equal(fixture.synthetics.length, 0);
});

test("does not splice the reminder when the agent is unset", async () => {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  const ctx = requestContext(undefined as never);
  await fixture.fireHook("context", ctx);

  assert.deepEqual(ctx.messages, [userPrompt("hello")]);
  assert.equal(fixture.synthetics.length, 0);
});

test("does not splice or persist when a stored copy already rides the window", async () => {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  // A stored copy rides history as a user-role message whose one text
  // part is the exact reminder text — the persist-era copies included,
  // with no special-casing: the exact-text scan of the window is the
  // whole dedupe, as plan.ts's lastReminder is.
  const ctx = requestContext("director", [
    storedReminder(await reminderText()),
    userPrompt("hello"),
  ]);
  await fixture.fireHook("context", ctx);

  assert.deepEqual(ctx.messages, [
    storedReminder(await reminderText()),
    userPrompt("hello"),
  ]);
  assert.equal(fixture.synthetics.length, 0);
});

test("splices the leave line when the agent moved off the director and the window holds the reminder", async () => {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  const reminder = await reminderText();
  const ctx = requestContext("build", [
    storedReminder(reminder),
    userPrompt("hello"),
  ]);
  await fixture.fireHook("context", ctx);

  // The leave line lands in the reminder's position, before the prompt.
  assert.equal(ctx.messages.length, 3);
  const spliced = ctx.messages[1] as TranscriptMessage;
  assert.equal(spliced.role, "user");
  const text = (spliced.content[0] as ContentPart).text!;
  assert.match(text, /no longer the director lane/);
  assert.match(text, /no longer applies/);
  // And it is persisted the same way, so the stale window's successor is
  // covered too.
  assert.deepEqual(fixture.synthetics, [
    { sessionID: "ses-director", text, resume: false },
  ]);
});

test("splices the enter reminder again when the window's newest reminder is the leave line", async () => {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  // The agent moved away and back: the leave line rides the window, so
  // the enter reminder is missing again.
  const ctx = requestContext("director", [
    storedReminder(await leaveText()),
    userPrompt("hello"),
  ]);
  await fixture.fireHook("context", ctx);

  assert.equal(ctx.messages.length, 3);
  const spliced = ctx.messages[1] as TranscriptMessage;
  assert.equal((spliced.content[0] as ContentPart).text, await reminderText());
  assert.equal(fixture.synthetics.length, 1);
});

test("a reconcile failure is caught and logged once; the request resolves reminder-less", async () => {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  // Hostile window: the splice's own mutation throws. Through the promise
  // adapter a rejected callback fails the request preparation and the
  // director's turn dies, so the catch must resolve it.
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

  assert.equal(thrown, undefined);
  assert.equal(fixture.synthetics.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[director\] reminder to ses-director failed/);
  assert.match(logs[0], /splice refused/);
  assert.match(logs[0], /The turn proceeds without it/);
});

test("a failed persistence store is caught; the reconciled window keeps its spliced copy", async () => {
  const fixture = fakeContext();
  // The host's synthetic store refuses.
  fixture.ctx.session.synthetic = async () => {
    throw new Error("store refused");
  };
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  let thrown: unknown;
  try {
    await plugin.setup(fixture.ctx);
    const ctx = requestContext("director");
    await fixture.fireHook("context", ctx);
  } catch (error) {
    thrown = error;
  } finally {
    console.error = originalError;
  }

  // The splice landed before the failure: the window carries the
  // reminder, the failure is named once, and nothing rejects.
  assert.equal(thrown, undefined);
  assert.equal(fixture.hooks.length, 2);
  assert.equal(fixture.synthetics.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /reminder persistence for ses-director failed/);
  assert.match(logs[0], /store refused/);
  assert.match(logs[0], /This window keeps the spliced copy/);
});

test("the persistence trigger stores the enter reminder on a director session.created", async () => {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  fixture.pushEvent({
    type: "session.created",
    data: { sessionID: "ses-new", agent: "director" },
  });
  await fixture.settle();

  assert.deepEqual(fixture.synthetics, [
    { sessionID: "ses-new", text: await reminderText(), resume: false },
  ]);
});

test("the persistence trigger ignores sessions not created as the director", async () => {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  // A worker's created event carries no agent at all; a plain session
  // carries another agent's. Neither stores anything.
  fixture.pushEvent({
    type: "session.created",
    data: { sessionID: "ses-worker", title: "slice work" },
  });
  fixture.pushEvent({
    type: "session.created",
    data: { sessionID: "ses-build", agent: "build" },
  });
  await fixture.settle();

  assert.equal(fixture.synthetics.length, 0);
});

test("the persistence trigger stores the enter reminder on a switch onto the director", async () => {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  fixture.pushEvent({
    type: "session.agent.selected",
    data: { sessionID: "ses-switch", agent: "director", previous: "build" },
  });
  await fixture.settle();

  assert.deepEqual(fixture.synthetics, [
    { sessionID: "ses-switch", text: await reminderText(), resume: false },
  ]);
});

test("the persistence trigger stores the leave line on a switch off the director", async () => {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  fixture.pushEvent({
    type: "session.agent.selected",
    data: { sessionID: "ses-switch", agent: "build", previous: "director" },
  });
  await fixture.settle();

  assert.deepEqual(fixture.synthetics, [
    { sessionID: "ses-switch", text: await leaveText(), resume: false },
  ]);
});

test("the persistence trigger ignores a same-agent selected event", async () => {
  const fixture = fakeContext();
  await plugin.setup(fixture.ctx);
  fixture.pushEvent({
    type: "session.agent.selected",
    data: { sessionID: "ses-switch", agent: "director", previous: "director" },
  });
  await fixture.settle();

  assert.equal(fixture.synthetics.length, 0);
});

test("a failed persistence store does not end the persistence stream", async () => {
  const fixture = fakeContext();
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    // One session's store refuses; the next event's store must still run.
    let refused = true;
    fixture.ctx.session.synthetic = async (input: SyntheticCall) => {
      if (refused) {
        refused = false;
        throw new Error("store refused");
      }
      fixture.synthetics.push(structuredClone(input));
    };
    await plugin.setup(fixture.ctx);
    fixture.pushEvent({
      type: "session.created",
      data: { sessionID: "ses-first", agent: "director" },
    });
    await fixture.settle();
    fixture.pushEvent({
      type: "session.created",
      data: { sessionID: "ses-second", agent: "director" },
    });
    await fixture.settle();
  } finally {
    console.error = originalError;
  }

  assert.equal(fixture.synthetics.length, 1);
  assert.equal(fixture.synthetics[0].sessionID, "ses-second");
  assert.equal(fixture.synthetics[0].resume, false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /reminder persistence for ses-first failed/);
  assert.match(logs[0], /store refused/);
});

test("the reminder legs degrade without the event surface; the reconcile stands alone", async () => {
  const fixture = fakeContext();
  delete fixture.ctx.event;
  const cleanup = await plugin.setup(fixture.ctx);
  const ctx = requestContext("director");
  await fixture.fireHook("context", ctx);

  // The load does not fail, the reconcile still registers and splices.
  assert.equal(fixture.hooks.length, 2);
  assert.equal(ctx.messages.length, 2);
  assert.equal(fixture.synthetics.length, 1);
  assert.equal(fixture.synthetics[0].resume, false);
  await cleanup?.();
});
