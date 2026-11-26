import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../daemon/daemon.ts";
import { routeClient, routeConfig } from "../route-client.ts";

// The daemon end to end (PRJ-540): the standalone process against
// loopback fakes only. The three legs:
//
// - a fake forge on 127.0.0.1 serving the /api/v1 reads the watcher
//   makes (the open-PR list, the pull record, its reviews, the commit
//   statuses, the branch list), mutable so the test drives state
//   changes;
// - a fake opencode server serving the session API the daemon's host
//   leg rides — the session list, a session's record, the metadata
//   patch (the stamp write), the synthetic post (the mail), and an SSE
//   /event stream — with every request's headers and body captured;
// - the daemon itself, started through startDaemon with a watcher block
//   in the pre-split options.watcher shape, discovering the host
//   through a service.json in a private XDG_STATE_HOME (the unit's
//   sandbox cannot read the operator's home — but discovery is the
//   fallback leg this test pins, and the auth header proves the
//   password rode it).
//
// The credential assertions are the point: the forge token exists only
// on the daemon→forge leg (the fake forge's authorization headers) and
// appears in no session write, no mail, and no route request; the route
// requests carry no authorization at all.

type Captured = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
};

const TOKEN = "sekrit-forge-token-9f2";
const HOST_PASSWORD = "sekrit-host-password-4c7";

async function waitFor(
  probe: () => boolean | Promise<boolean>,
  limit = 2000,
): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    let held = false;
    try {
      held = await probe();
    } catch {
      held = false;
    }
    if (held) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor: condition never held");
}

// The fake forge: one repo, one pull request (index 7), its reviews,
// and the reads the projection walks. setPull/setReviews drive changes.
async function startForge() {
  const pulls: Record<number, Record<string, unknown>> = {
    7: {
      index: 7,
      title: "watched change",
      state: "open",
      draft: false,
      head: { sha: "sha-7" },
      base: { ref: "main" },
      merged: false,
      merged_at: null,
      closed_at: null,
    },
  };
  let reviews: Array<Record<string, unknown>> = [];
  const calls: Captured[] = [];

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      calls.push({
        method: request.method ?? "",
        path: url.pathname,
        headers: { ...request.headers },
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const route = url.pathname.replace(/^\/api\/v1/, "");
      const answer = (payload: unknown) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.method === "GET" && route === "/repos/acme/widgets/pulls") {
        answer(Object.values(pulls).filter((row) => row.state === "open"));
        return;
      }
      const pr = route.match(/^\/repos\/acme\/widgets\/pulls\/(\d+)$/);
      if (request.method === "GET" && pr) {
        const row = pulls[Number(pr[1])];
        if (!row) {
          response.writeHead(404, { "Content-Type": "application/json" });
          response.end("{}");
          return;
        }
        answer(row);
        return;
      }
      const reviewsOf = route.match(
        /^\/repos\/acme\/widgets\/pulls\/(\d+)\/reviews$/,
      );
      if (request.method === "GET" && reviewsOf) {
        answer(reviews);
        return;
      }
      const statuses = route.match(
        /^\/repos\/acme\/widgets\/commits\/[^/]+\/statuses$/,
      );
      if (request.method === "GET" && statuses) {
        answer([]);
        return;
      }
      if (
        request.method === "GET" &&
        route === "/repos/acme/widgets/branches"
      ) {
        answer([]);
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((done) => server.close(() => done())),
    setPull: (index: number, over: Record<string, unknown>) => {
      pulls[index] = { ...pulls[index], ...over };
    },
    setReviews: (next: Array<Record<string, unknown>>) => {
      reviews = next;
    },
  };
}

// The fake opencode server: the session API the host leg rides, with
// every request captured.
async function startFakeHost() {
  const sessions = new Map<
    string,
    { id: string; metadata: Record<string, unknown> }
  >([
    ["ses_target", { id: "ses_target", metadata: {} }],
    ["ses_reviews", { id: "ses_reviews", metadata: {} }],
  ]);
  const mails: Array<{ sessionID: string; text: string }> = [];
  const calls: Captured[] = [];
  const eventStreams: Array<http.ServerResponse> = [];

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({
        method: request.method ?? "",
        path: url.pathname,
        headers: { ...request.headers },
        body,
      });
      const answer = (payload: unknown) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.method === "GET" && url.pathname === "/api/session") {
        answer({ data: [...sessions.values()], cursor: {} });
        return;
      }
      const synthetic = url.pathname.match(
        /^\/api\/session\/([^/]+)\/synthetic$/,
      );
      if (request.method === "POST" && synthetic) {
        const parsed = JSON.parse(body) as { text?: string };
        mails.push({
          sessionID: decodeURIComponent(synthetic[1]),
          text: parsed.text ?? "",
        });
        answer({ data: { ok: true } });
        return;
      }
      const record = url.pathname.match(/^\/api\/session\/([^/]+)$/);
      if (request.method === "GET" && record) {
        const row = sessions.get(decodeURIComponent(record[1]));
        if (!row) {
          response.writeHead(404, { "Content-Type": "application/json" });
          response.end("{}");
          return;
        }
        answer({ data: structuredClone(row) });
        return;
      }
      if (request.method === "PATCH" && record) {
        const parsed = JSON.parse(body) as {
          metadata?: Record<string, unknown>;
        };
        const row = sessions.get(decodeURIComponent(record[1]));
        if (!row) {
          response.writeHead(404, { "Content-Type": "application/json" });
          response.end("{}");
          return;
        }
        row.metadata = structuredClone(parsed.metadata ?? {});
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/event") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
        });
        response.write('data: {"type":"server.connected","data":{}}\n\n');
        eventStreams.push(response);
        request.on("close", () => {
          const at = eventStreams.indexOf(response);
          if (at >= 0) eventStreams.splice(at, 1);
        });
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    mails,
    close: () =>
      new Promise<void>((done) => {
        for (const stream of eventStreams) stream.end();
        server.close(() => done());
      }),
  };
}

test("the daemon polls the forge, delivers mail through the session API, and keeps every credential off the route", async () => {
  const forge = await startForge();
  const host = await startFakeHost();
  const stateHome = mkdtempSync(join(tmpdir(), "watcher-daemon-"));
  mkdirSync(join(stateHome, "opencode"), { recursive: true });
  writeFileSync(
    join(stateHome, "opencode", "service.json"),
    JSON.stringify({ url: host.url, password: HOST_PASSWORD }),
    { mode: 0o600 },
  );
  const priorStateHome = process.env.XDG_STATE_HOME;
  const priorToken = process.env.FORGEJO_TOKEN;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.FORGEJO_TOKEN = TOKEN;

  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon({
      watcherBlock: {
        forgeUrl: forge.url,
        pollSeconds: 0.02,
        dbPath: join(stateHome, "pr-state.db"),
      },
      port: 0,
    });
    const client = routeClient(
      routeConfig({ options: { watcher: { daemonUrl: daemon.route.url } } }),
    );

    // The discovery leg proved itself: every host request rode the
    // service.json password as Basic auth "opencode".
    await waitFor(() => host.calls.length > 0);
    assert.ok(
      host.calls.every(
        (call) =>
          call.headers.authorization ===
          `Basic ${Buffer.from(`opencode:${HOST_PASSWORD}`).toString("base64")}`,
      ),
      "the daemon's host requests must carry the discovered Basic auth",
    );

    // Register a pr watch through the route, as the tool does.
    const registered = (await client.register(
      { kind: "pr", repo: "acme/widgets", ref: "7" },
      "ses_target",
    )) as { outcome?: string; id?: string };
    assert.equal(registered.outcome, "registered");
    assert.match(registered.id ?? "", /^w-/);

    // The stamp landed on the registering session.
    const stamps = (await client.list("ses_target")) as { rows: unknown[] };
    assert.equal(stamps.rows.length, 1);

    // The open pull request wakes nobody.
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(host.mails.length, 0);

    // The pull request closes merged: one terminal mail, then the
    // watch dissolves itself.
    forge.setPull(7, {
      state: "closed",
      merged: true,
      merged_at: "2026-11-26T10:00:00Z",
      closed_at: "2026-11-26T10:00:00Z",
    });
    await waitFor(() =>
      host.mails.some((mail) => mail.sessionID === "ses_target"),
    );
    const close = host.mails.find((mail) => mail.sessionID === "ses_target")!;
    assert.match(close.text, /merged/);
    assert.match(close.text, /acme\/widgets#7/);
    await waitFor(async () => {
      const after = (await client.list("ses_target")) as { rows: unknown[] };
      return after.rows.length === 0;
    });
    const after = (await client.list("ses_target")) as { rows: unknown[] };
    assert.deepEqual(after.rows, [], "the pr watch dissolves at the close");

    // A pr-reviews watch: the review the PR already carries is the
    // spent backlog — no wake — and a new review wakes once.
    forge.setPull(7, {
      state: "open",
      merged: false,
      merged_at: null,
      closed_at: null,
    });
    forge.setReviews([
      {
        id: 1,
        user: { login: "backlog-reviewer" },
        state: "APPROVED",
        body: "already here",
        submitted_at: "2026-11-26T09:00:00Z",
      },
    ]);
    const reviewWatch = (await client.register(
      { kind: "pr-reviews", repo: "acme/widgets", ref: "7" },
      "ses_reviews",
    )) as { outcome?: string; id?: string };
    assert.equal(reviewWatch.outcome, "registered");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(
      host.mails.filter((mail) => mail.sessionID === "ses_reviews").length,
      0,
      "the backlog review never wakes",
    );
    forge.setReviews([
      {
        id: 1,
        user: { login: "backlog-reviewer" },
        state: "APPROVED",
        body: "already here",
        submitted_at: "2026-11-26T09:00:00Z",
      },
      {
        id: 2,
        user: { login: "fresh-reviewer" },
        state: "COMMENTED",
        body: "new one",
        submitted_at: "2026-11-26T10:05:00Z",
      },
    ]);
    await waitFor(() =>
      host.mails.some((mail) => mail.sessionID === "ses_reviews"),
    );
    const review = host.mails.find((mail) => mail.sessionID === "ses_reviews")!;
    assert.match(review.text, /fresh-reviewer/);
    assert.match(review.text, /COMMENTED/);

    // The review's marker rides the stamp: at-most-once across passes.
    const reviewStamps = (await client.list("ses_reviews")) as {
      rows: Array<{ id: string; delivered: Record<string, boolean> }>;
    };
    assert.equal(reviewStamps.rows.length, 1);
    assert.ok(
      reviewStamps.rows[0].delivered["2"],
      "the delivered marker is on the stamp",
    );

    // forge_state reads the projection behind the route.
    const board = (await client.state("acme/widgets")) as { ok: boolean };
    assert.equal(board.ok, true);

    // The credential flow: the forge token appears only on the
    // daemon→forge leg. No session write, no mail, and no route request
    // ever carries it; the route requests carry no authorization at all.
    for (const call of forge.calls) {
      if (call.path.startsWith("/api/v1/")) {
        assert.equal(call.headers.authorization, `token ${TOKEN}`);
      }
    }
    for (const call of host.calls) {
      assert.ok(
        !call.body.includes(TOKEN),
        "the forge token must never reach the session API",
      );
      assert.ok(!call.headers.authorization?.includes(TOKEN));
    }
    for (const mail of host.mails) {
      assert.ok(
        !mail.text.includes(TOKEN),
        "the forge token must never ride a wake",
      );
    }
    // A register the daemon cannot serve: the error text names the
    // kinds — and never a credential.
    await assert.rejects(
      client.register(
        { kind: "nope", repo: "acme/widgets", ref: "1" },
        "ses_target",
      ),
      /kind must be one of/,
    );
  } finally {
    await daemon?.stop();
    await forge.close();
    await host.close();
    if (priorStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = priorStateHome;
    if (priorToken === undefined) delete process.env.FORGEJO_TOKEN;
    else process.env.FORGEJO_TOKEN = priorToken;
    rmSync(stateHome, { recursive: true, force: true });
  }
});
