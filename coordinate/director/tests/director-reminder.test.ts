import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../director.ts";

// The director package's own delegation reminder, folded inline into the
// entry (director.ts must stay a single self-contained file: the
// mail-watcher package materializes it verbatim and alone, so five watcher
// sources' cross-layout import resolves). Fake shaped like the suite's
// fakeContext session domains (director.test.ts): the registration hooks
// with per-name collection and a fire helper, the session get that throws
// on an unknown row (the host's NotFoundError), and the synthetic sink. The
// tool domain is the one the entry's setup touches unguarded and the event
// stream stays empty, so the pump idles quietly. Every assertion in this
// file runs through the entry's setup, so an unwired registration fails the suite
// instead of silently going live-dead.

type SessionRow = { id: string; agent?: string };

function fakeContext() {
  const sessions = new Map<string, SessionRow>();
  const mails: Array<{ sessionID: string; text: string }> = [];
  const hooks: Array<{
    name: string;
    callback: (input: unknown) => Promise<void> | void;
  }> = [];
  const hookDisposals: string[] = [];
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
      get: async ({ sessionID }: { sessionID: string }) => {
        const row = sessions.get(sessionID);
        if (!row) throw new Error("Session.NotFoundError");
        return structuredClone(row);
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
      synthetic: async (input: { sessionID: string; text: string }) => {
        mails.push(structuredClone(input));
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
  return { ctx, sessions, mails, hooks, hookDisposals, fireHook };
}

test("registers on the prompt hook", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  // Two prompt hooks ride the entry: the permission re-assert's and the
  // reminder's. Both dispose with teardown.
  assert.equal(fixture.hooks.length, 2);
  assert.deepEqual(
    fixture.hooks.map((hook) => hook.name),
    ["prompt", "prompt"],
  );
  await cleanup?.();
  assert.deepEqual(fixture.hookDisposals, ["prompt", "prompt"]);
});

test("persists a synthetic reminder for director sessions", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  fixture.sessions.set("ses-director", {
    id: "ses-director",
    agent: "director",
  });
  await fixture.fireHook("prompt", {
    sessionID: "ses-director",
    messageID: "msg-1",
  });

  assert.equal(fixture.mails.length, 1);
  assert.equal(fixture.mails[0].sessionID, "ses-director");
  // The text assertions run on what the synthetic sink captured when the
  // hook fired — the load-bearing phrases — so they prove what a director
  // session receives, not what a constant holds.
  assert.match(fixture.mails[0].text, /director_dispatch/);
  assert.match(fixture.mails[0].text, /director_steer/);
  assert.match(fixture.mails[0].text, /coordination bookkeeping/);
  assert.match(fixture.mails[0].text, /standing grant/);
  await cleanup?.();
});

test("does not persist a reminder for other agents", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  fixture.sessions.set("ses-build", { id: "ses-build", agent: "build" });
  await fixture.fireHook("prompt", {
    sessionID: "ses-build",
    messageID: "msg-2",
  });

  assert.equal(fixture.mails.length, 0);
  await cleanup?.();
});

test("does not persist a reminder when the agent is unset", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  fixture.sessions.set("ses-plain", { id: "ses-plain" });
  await fixture.fireHook("prompt", {
    sessionID: "ses-plain",
    messageID: "msg-3",
  });

  assert.equal(fixture.mails.length, 0);
  await cleanup?.();
});

test("a failed reminder send is caught and logged once; the turn proceeds", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  fixture.sessions.set("ses-director", {
    id: "ses-director",
    agent: "director",
  });
  // The sink failure is the wake path's real mode (the suite's
  // "inbox unavailable" fixture): the hook runs awaited inside the prompt
  // path, so a throw escaping it would take the director's turn down.
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  let thrown: unknown;
  try {
    fixture.ctx.session.synthetic = async () => {
      throw new Error("inbox unavailable");
    };
    await fixture.fireHook("prompt", {
      sessionID: "ses-director",
      messageID: "msg-1",
    });
  } catch (error) {
    thrown = error;
  } finally {
    console.error = originalError;
  }
  await cleanup?.();

  assert.equal(thrown, undefined);
  assert.equal(fixture.mails.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[director\] reminder to ses-director failed/);
  assert.match(logs[0], /inbox unavailable/);
});

test("a prompt for an unknown session persists nothing and throws nothing", async () => {
  const fixture = fakeContext();
  const cleanup = await plugin.setup(fixture.ctx);
  let thrown: unknown;
  try {
    // The fake's get throws the host's NotFoundError for an id the map
    // never held: the designed degrade treats the unreadable row as
    // not-director. Pinned so it holds by design, not by incidence.
    await fixture.fireHook("prompt", {
      sessionID: "ses-unknown",
      messageID: "msg-2",
    });
  } catch (error) {
    thrown = error;
  }
  await cleanup?.();

  assert.equal(thrown, undefined);
  assert.equal(fixture.mails.length, 0);
});
