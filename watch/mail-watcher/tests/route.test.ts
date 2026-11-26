import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { startRoute } from "../daemon/route.ts";
import { routeClient, routeConfig } from "../route-client.ts";

// The route and its client (PRJ-540): the registration surface the
// session-side tools proxy to, over the credential-free local route.
// The route server here is wired to stubs standing in for the kernel
// and the projection; the client is the plugin's own. Together they
// pin the split's transport contract: the outcomes cross as the kernel
// answered them, the errors cross as the kernel's own error text, and
// no credential rides any request in either direction — the proxy has
// none to send, and these calls are every request the client makes.

type Recorded = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
};

test("the route answers register/forget/list/state as the kernel and projection answer", async () => {
  const registerCalls: Array<{ req: unknown; caller: string }> = [];
  const forgetCalls: Array<{ id: string; caller: string }> = [];
  const stampsReads: string[] = [];
  const stateReads: Array<string | null> = [];
  const route = await startRoute({
    port: 0,
    register: async (req, caller) => {
      registerCalls.push({ req, caller });
      if (req.kind === "boom")
        throw new Error("watcher_register: kind must be one of run, pr");
      if (req.kind === "claimed") {
        return { outcome: "claimed", id: "w-claimed", claimedBy: "ses-owner" };
      }
      if (req.kind === "existing") return { outcome: "existing", id: "w-own" };
      return {
        outcome: "registered",
        id: "w-fresh",
        kind: String(req.kind),
        repo: String(req.repo),
        ref: String(req.ref),
      };
    },
    forget: async (id, caller) => {
      forgetCalls.push({ id, caller });
      if (id === "w-foreign")
        throw new Error(
          `watcher_forget: watch ${id} is claimed by ses-owner; only its owner can forget it`,
        );
    },
    stampsOf: async (sessionID) => {
      stampsReads.push(sessionID);
      if (sessionID === "ses-none") return null;
      return [
        {
          id: "w-1",
          session: sessionID,
          kind: "pr",
          repo: "acme/widgets",
          ref: "7",
          note: "hold the lane",
          delivered: { "ev-1": true, "ev-2": true },
        },
      ];
    },
    stateOf: async (repo) => {
      stateReads.push(repo);
      if (repo === "broken/repo") {
        return {
          unavailable:
            "the pr-state projection is unavailable: the file is gone",
        };
      }
      return { repos: repo ? [{ repo }] : [{ repo: "acme/widgets" }] };
    },
  });

  const captured: Recorded[] = [];
  route.server.on("request", (request, response) => {
    // The capture's chunks are consumed by the route's own body read;
    // only method, path, and headers are recorded here. A request body
    // the client sends is asserted separately below, from the client's
    // side, because the stream does not replay.
    captured.push({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: { ...request.headers },
      body: "",
    });
  });

  const client = routeClient(
    routeConfig({ options: { watcher: { daemonUrl: route.url } } }),
  );

  // Register: the three outcomes cross unchanged.
  const registered = await client.register(
    { kind: "pr", repo: "acme/widgets", ref: "7" },
    "ses-caller",
  );
  assert.deepEqual(registered, {
    outcome: "registered",
    id: "w-fresh",
    kind: "pr",
    repo: "acme/widgets",
    ref: "7",
  });
  assert.equal(registerCalls.length, 1);
  assert.equal(registerCalls[0].caller, "ses-caller");
  const claimed = await client.register({ kind: "claimed" }, "ses-caller");
  assert.deepEqual(claimed, {
    outcome: "claimed",
    id: "w-claimed",
    claimedBy: "ses-owner",
  });
  const existing = await client.register({ kind: "existing" }, "ses-caller");
  assert.deepEqual(existing, { outcome: "existing", id: "w-own" });

  // A kernel error crosses as the kernel's own text.
  await assert.rejects(
    client.register({ kind: "boom" }, "ses-caller"),
    /watcher_register: kind must be one of run, pr/,
  );

  // Forget: the answer and the owner check's error text.
  assert.deepEqual(await client.forget("w-1", "ses-caller"), {
    ok: true,
    id: "w-1",
  });
  assert.deepEqual(forgetCalls, [{ id: "w-1", caller: "ses-caller" }]);
  await assert.rejects(
    client.forget("w-foreign", "ses-other"),
    /only its owner can forget it/,
  );

  // List: the raw rows cross; the client's session id is the query.
  const listed = await client.list("ses-1");
  assert.equal(listed.ok, true);
  assert.equal((listed.rows as unknown[]).length, 1);
  assert.deepEqual(stampsReads, ["ses-1"]);
  const listedEmpty = await client.list("ses-none");
  assert.deepEqual(listedEmpty.rows, []);

  // State: the board answer and the unavailable marker cross.
  const board = await client.state("acme/widgets");
  assert.deepEqual(board, {
    ok: true,
    repo: "acme/widgets",
    repos: [{ repo: "acme/widgets" }],
  });
  assert.deepEqual(stateReads, ["acme/widgets"]);
  const broken = await client.state("broken/repo");
  assert.deepEqual(broken, {
    ok: false,
    error: "the pr-state projection is unavailable: the file is gone",
  });

  // Every request carried no credential-shaped header: no
  // authorization, no token, no cookie — the proxy has none to send.
  for (const call of captured) {
    assert.equal(
      call.headers.authorization,
      undefined,
      JSON.stringify(call.headers),
    );
    assert.equal(call.headers["x-forgejo-token"], undefined);
    assert.equal(call.headers.cookie, undefined);
  }

  await route.close();
});

test("the route refuses a request without a session id, an unknown route, and a non-JSON body", async () => {
  const route = await startRoute({
    port: 0,
    register: async () => {
      throw new Error("register must not be reached");
    },
    forget: async () => {},
    stampsOf: async () => [],
    stateOf: async () => ({}),
  });
  const post = async (path: string, body: string) => {
    const response = await fetch(`${route.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return { status: response.status, json: await response.json() };
  };
  const noSession = await post("/register", JSON.stringify({ kind: "pr" }));
  assert.equal(noSession.status, 400);
  assert.match(noSession.json.error, /no session id/);
  const badBody = await post("/register", "{not json");
  assert.equal(badBody.status, 400);
  assert.match(badBody.json.error, /not JSON/);
  const missing = await fetch(`${route.url}/nope`);
  assert.equal(missing.status, 404);
  const noSessionQuery = await fetch(`${route.url}/list`);
  assert.equal(noSessionQuery.status, 400);
  await route.close();
});

test("the route binds loopback only", async () => {
  const route = await startRoute({
    port: 0,
    register: async () => ({}) as never,
    forget: async () => {},
    stampsOf: async () => [],
    stateOf: async () => ({}),
  });
  try {
    assert.match(route.url, /^http:\/\/127\.0\.0\.1:/);
  } finally {
    await route.close();
  }
});

test("the route client's failure arms are named: unreachable, timeout, non-JSON, and a recordless answer", async () => {
  // A closed port: the arm the down-daemon case rides. The port is one
  // the test held and released, so the refusal is a real one, not a
  // lucky guess.
  const holder = http.createServer(() => {});
  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const port = (holder.address() as { port: number }).port;
  await new Promise<void>((done) => holder.close(() => done()));
  const closed = routeClient(
    routeConfig({
      options: { watcher: { daemonUrl: `http://127.0.0.1:${port}` } },
    }),
  );
  await assert.rejects(
    closed.register({ kind: "pr", repo: "acme/widgets", ref: "1" }, "ses-1"),
    /is the watcher-daemon service running\?/,
  );
  await assert.rejects(
    closed.list("ses-1"),
    /unreachable at http:\/\/127\.0\.0\.1:/,
  );

  // A server that holds the connection and never answers: the timeout
  // arm, on a short budget so the test stays fast.
  const hanging = http.createServer(() => {
    // The handler answers nothing: the request hangs until the client's
    // timeout fires.
  });
  await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
  const hangingPort = (hanging.address() as { port: number }).port;
  try {
    const patient = routeClient(
      routeConfig({
        options: { watcher: { daemonUrl: `http://127.0.0.1:${hangingPort}` } },
        timeoutMs: 150,
      }),
    );
    await assert.rejects(patient.list("ses-1"), /did not answer in time/);
  } finally {
    hanging.closeAllConnections();
    await new Promise<void>((done) => hanging.close(() => done()));
  }

  // A server that answers 200 with a non-JSON body.
  const textOnly = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("not json at all");
  });
  await new Promise<void>((resolve) =>
    textOnly.listen(0, "127.0.0.1", resolve),
  );
  const textPort = (textOnly.address() as { port: number }).port;
  try {
    const reader = routeClient(
      routeConfig({
        options: { watcher: { daemonUrl: `http://127.0.0.1:${textPort}` } },
      }),
    );
    await assert.rejects(reader.list("ses-1"), /answered a non-JSON body/);
  } finally {
    await new Promise<void>((done) => textOnly.close(() => done()));
  }

  // A server that answers 200 with a non-record body (a JSON array): the
  // recordless arm.
  const arrayOnly = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify([1, 2, 3]));
  });
  await new Promise<void>((resolve) =>
    arrayOnly.listen(0, "127.0.0.1", resolve),
  );
  const arrayPort = (arrayOnly.address() as { port: number }).port;
  try {
    const reader = routeClient(
      routeConfig({
        options: { watcher: { daemonUrl: `http://127.0.0.1:${arrayPort}` } },
      }),
    );
    await assert.rejects(reader.list("ses-1"), /answered without a record/);
  } finally {
    await new Promise<void>((done) => arrayOnly.close(() => done()));
  }
});
