import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHost, hostContext } from "../daemon/host-client.ts";

// The host leg's two legs, against loopback fakes only:
//
// - the env discovery (zenigata review 700, comment 19378): the
//   deployment's WATCHER_OPENCODE_URL / WATCHER_OPENCODE_PASSWORD win
//   over the host's registration file, each half independently (the
//   url from the environment with the password still from the file,
//   and the password from the environment winning over the file's),
//   and the file alone carries both when the environment is silent;
//   nothing set anywhere is a named refusal, and a non-http url is
//   named too.
// - the event stream's reconnect (zenigata review 700, comment 19377):
//   a host restart closes the SSE body mid-run, and the subscription
//   must survive it — the generator reconnects after a backoff and
//   events resume, instead of the generator returning and the kernel's
//   for-await exiting silently. The test kills the server mid-run,
//   brings a new one up on the same port, and pins events flowing on
//   both sides of the outage; the abort signal ends the subscription.

const STATE = {
  priorUrl: undefined as string | undefined,
  priorPassword: undefined as string | undefined,
};

const setEnv = (url?: string, password?: string) => {
  if (url === undefined) delete process.env.WATCHER_OPENCODE_URL;
  else process.env.WATCHER_OPENCODE_URL = url;
  if (password === undefined) delete process.env.WATCHER_OPENCODE_PASSWORD;
  else process.env.WATCHER_OPENCODE_PASSWORD = password;
};

test("resolveHost reads the daemon's environment first, the registration file second, and refuses named when neither answers", async () => {
  const stateHome = mkdtempSync(join(tmpdir(), "watcher-host-"));
  mkdirSync(join(stateHome, "opencode"), { recursive: true });
  const file = join(stateHome, "opencode", "service.json");
  const priorStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  STATE.priorUrl = process.env.WATCHER_OPENCODE_URL;
  STATE.priorPassword = process.env.WATCHER_OPENCODE_PASSWORD;
  try {
    // Nothing anywhere: named, and the names teach both knobs.
    setEnv(undefined, undefined);
    let resolved = resolveHost();
    assert.equal(resolved.ok, false);
    if (!resolved.ok) {
      assert.match(resolved.reason, /WATCHER_OPENCODE_URL/);
      assert.match(resolved.reason, /service\.json/);
    }

    // The file alone carries both: discovery finds them.
    writeFileSync(
      file,
      JSON.stringify({
        url: "http://127.0.0.1:7001",
        password: "file-password",
      }),
      { mode: 0o600 },
    );
    resolved = resolveHost();
    assert.deepEqual(resolved, {
      ok: true,
      url: "http://127.0.0.1:7001",
      password: "file-password",
    });

    // The environment's url wins and detaches from the file entirely
    // (the oc-wake rule): the password comes from the environment too,
    // or not at all.
    setEnv("http://127.0.0.1:7002/", undefined);
    resolved = resolveHost();
    assert.deepEqual(resolved, { ok: true, url: "http://127.0.0.1:7002" });

    // The environment's password wins over the file's.
    setEnv("http://127.0.0.1:7002", "env-password");
    resolved = resolveHost();
    assert.deepEqual(resolved, {
      ok: true,
      url: "http://127.0.0.1:7002",
      password: "env-password",
    });

    // A non-http url is named, not guessed at.
    setEnv("ftp://nope", undefined);
    resolved = resolveHost();
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.match(resolved.reason, /must be http/);

    // A file that is not JSON is named with its path.
    setEnv(undefined, undefined);
    writeFileSync(file, "not json", { mode: 0o600 });
    resolved = resolveHost();
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.match(resolved.reason, /not JSON/);
  } finally {
    setEnv(STATE.priorUrl, STATE.priorPassword);
    if (priorStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = priorStateHome;
  }
});

// The fake SSE server: fixed port (the outage test rebinds it), one
// event written on connect, then held open. close() tears down the
// active connections too — a real restart destroys them, and a graceful
// close that leaves the SSE connection open would hang the reader the
// reconnect exists to heal.
function startSseServer(port: number, event: { type: string; id: string }) {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/event") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      response.write(
        `data: ${JSON.stringify({ type: event.type, data: { id: event.id } })}\n\n`,
      );
      return;
    }
    response.writeHead(404);
    response.end("{}");
  });
  return new Promise<{ server: http.Server; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(port, "127.0.0.1", () =>
        resolve({
          server,
          close: () =>
            new Promise<void>((done) => {
              server.closeAllConnections();
              server.close(() => done());
            }),
        }),
      );
    },
  );
}

const freePort = async (): Promise<number> => {
  const holder = http.createServer(() => {});
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const port = (holder.address() as { port: number }).port;
  await new Promise<void>((done) => holder.close(() => done()));
  return port;
};

test("the event stream survives a host restart: it reconnects and events resume", async () => {
  const port = await freePort();
  const first = await startSseServer(port, {
    type: "session.created",
    id: "before-outage",
  });

  const resolved = resolveHost({
    url: `http://127.0.0.1:${port}`,
    password: "pw",
  });
  assert.ok(resolved.ok);
  const host = hostContext(resolved as never, {
    reconnectBaseMs: 10,
    reconnectMaxMs: 50,
  });

  const controller = new AbortController();
  const events: Array<{ type: string; data?: { id?: string } }> = [];
  const subscription = (async () => {
    for await (const event of host.event.subscribe({
      signal: controller.signal,
    })) {
      events.push(event as { type: string; data?: { id?: string } });
    }
  })();

  const waitFor = async (probe: () => boolean, limit = 2000) => {
    for (let i = 0; i < limit; i += 1) {
      if (probe()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("waitFor: condition never held");
  };
  await waitFor(() =>
    events.some((event) => event.data?.id === "before-outage"),
  );

  // The host restart: the stream dies mid-run. The subscription keeps
  // trying; nothing thrown, nothing ends.
  await first.close();

  // The new server binds the same port: events resume across the gap.
  const second = await startSseServer(port, {
    type: "session.created",
    id: "after-outage",
  });
  await waitFor(
    () => events.some((event) => event.data?.id === "after-outage"),
    4000,
  );

  // The abort signal is the only way out: the subscription ends
  // promptly, even mid-backoff.
  controller.abort();
  await subscription;
  await second.close();
});
