import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../daemon/daemon.ts";
import { routeClient, routeConfig } from "../route-client.ts";

// The webhook receiver end to end (PRJ-542): the daemon against loopback
// fakes only — a fake forge, a fake opencode server, and the real
// daemon started with a watcher block. A signed delivery arrives on the
// receiver, the ingest wakes the pass, the forge source drains the
// queue ahead of its reads, and the mail lands; replays absorb, a
// rerun's fresh dedupe id wakes again, and an unsecreted receiver
// refuses everything with the named 403.

const SECRET = "sekrit-webhook-secret-e2e";
const TOKEN = "sekrit-forge-token-e2e";
const HOST_PASSWORD = "sekrit-host-password-e2e";

async function waitFor(
  probe: () => boolean | Promise<boolean>,
  limit = 4000,
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sign = (body: Buffer, secret = SECRET) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");

const deliver = (
  port: number,
  body: string,
  secret = SECRET,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const raw = Buffer.from(body, "utf8");
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/hook",
        headers: {
          "Content-Type": "application/json",
          "X-Forgejo-Signature": sign(raw, secret),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(raw);
  });

// The fake forge: one repo, one open pull request (index 7, head
// sha-7), one Actions run (999), and the hooks list the diagnosis
// reads. setReviews and setRun drive state changes.
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
  let runs: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const route = url.pathname.replace(/^\/api\/v1/, "");
      const answer = (payload: unknown) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.method === "GET" && route === "/repos/acme/widgets/pulls") {
        answer(Object.values(pulls).filter((row) => row.state === "open"));
        return;
      }
      if (request.method === "GET" && route === "/repos/acme/widgets/pulls/7") {
        answer(pulls[7]);
        return;
      }
      if (
        request.method === "GET" &&
        route === "/repos/acme/widgets/pulls/7/reviews"
      ) {
        answer(reviews);
        return;
      }
      if (
        request.method === "GET" &&
        route === "/repos/acme/widgets/commits/sha-7/statuses"
      ) {
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
      if (
        request.method === "GET" &&
        route === "/repos/acme/widgets/actions/runs" &&
        url.searchParams.get("head_sha") === "sha-7"
      ) {
        answer(runs);
        return;
      }
      if (
        request.method === "GET" &&
        route === "/repos/acme/widgets/actions/runs/999"
      ) {
        answer(runs[0] ?? {});
        return;
      }
      if (request.method === "GET" && route === "/repos/acme/widgets/hooks") {
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
    close: () => new Promise<void>((done) => server.close(() => done())),
    setReviews: (next: Array<Record<string, unknown>>) => {
      reviews = next;
    },
    setRuns: (next: Array<Record<string, unknown>>) => {
      runs = next;
    },
  };
}

// The fake opencode server: the session API the host leg rides, with
// every mail captured.
async function startFakeHost() {
  const sessions = new Map<
    string,
    { id: string; metadata: Record<string, unknown> }
  >([
    ["ses_target", { id: "ses_target", metadata: {} }],
    ["ses_reviews", { id: "ses_reviews", metadata: {} }],
  ]);
  const mails: Array<{ sessionID: string; text: string }> = [];
  const eventStreams: Array<http.ServerResponse> = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
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
        if (row) row.metadata = structuredClone(parsed.metadata ?? {});
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
    mails,
    close: () =>
      new Promise<void>((done) => {
        for (const stream of eventStreams) stream.end();
        server.close(() => done());
      }),
  };
}

test("a signed delivery wakes the pass and delivers once; a replay absorbs; a rerun wakes again; an unsecreted receiver refuses", async () => {
  const forge = await startForge();
  const host = await startFakeHost();
  const stateHome = mkdtempSync(join(tmpdir(), "watcher-webhook-"));
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

  // The REST surfaces run empty while the watches register: a review
  // and a run that arrive after register are the deliveries' news, and
  // the baseline spends an empty backlog.
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let unsecreted: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    daemon = await startDaemon({
      watcherBlock: {
        forgeUrl: forge.url,
        pollSeconds: 0.02,
        dbPath: join(stateHome, "pr-state.db"),
      },
      port: 0,
      webhookPort: 0,
      webhookSecret: SECRET,
    });
    const client = routeClient(
      routeConfig({ options: { watcher: { daemonUrl: daemon.route.url } } }),
    );

    const reviewWatch = (await client.register(
      { kind: "pr-reviews", repo: "acme/widgets", ref: "7" },
      "ses_reviews",
    )) as { outcome?: string };
    assert.equal(reviewWatch.outcome, "registered");
    const runWatch = (await client.register(
      { kind: "run", repo: "acme/widgets", ref: "999" },
      "ses_target",
    )) as { outcome?: string };
    assert.equal(runWatch.outcome, "registered");
    await sleep(80);
    assert.equal(host.mails.length, 0, "nothing wakes before a delivery");

    // A signed review delivery: the receiver answers 200, the ingest
    // wakes the pass, and the review's mail lands — no timer wait. The
    // forge's REST pages still run empty; the delivery is the news.
    const reviewDelivery = JSON.stringify({
      action: "submitted",
      repository: { full_name: "acme/widgets" },
      pull_request: { number: 7 },
      review: {
        id: 2,
        state: "COMMENTED",
        user: { login: "fresh-reviewer" },
      },
    });
    const answered = await deliver(daemon.receiver.port, reviewDelivery);
    assert.equal(answered.status, 200);
    await waitFor(() =>
      host.mails.some(
        (mail) =>
          mail.sessionID === "ses_reviews" &&
          mail.text.includes("fresh-reviewer"),
      ),
    );
    assert.equal(
      host.mails.filter((mail) => mail.sessionID === "ses_reviews").length,
      1,
      "one review, one wake",
    );

    // The run family: a run delivery wakes the run watch the same way.
    const runDelivery = (updated: string) =>
      JSON.stringify({
        action: "completed",
        repository: { full_name: "acme/widgets" },
        workflow_run: {
          id: 999,
          status: "failure",
          updated_at: updated,
          head_sha: "sha-7",
        },
      });
    await deliver(daemon.receiver.port, runDelivery("2026-11-26T10:00:00Z"));
    await waitFor(() =>
      host.mails.some(
        (mail) =>
          mail.sessionID === "ses_target" && mail.text.includes("failure"),
      ),
    );

    // The forge's REST pages now carry the same news: the polling
    // backstop absorbs what the receiver's path already delivered — the
    // review by its dedupe id, the run by the id's prefix — and mails
    // nothing a second time.
    forge.setReviews([
      { id: 2, user: { login: "fresh-reviewer" }, state: "COMMENTED" },
    ]);
    forge.setRuns([{ id: 999, status: "failure", head_sha: "sha-7" }]);
    await sleep(200);
    assert.equal(
      host.mails.filter((mail) => mail.sessionID === "ses_reviews").length,
      1,
      "the REST page never repeats the delivered review",
    );
    assert.equal(
      host.mails.filter((mail) => mail.sessionID === "ses_target").length,
      1,
      "the REST row never repeats the delivered run",
    );

    // The replay: the same delivery, absorbed by its dedupe id.
    await deliver(daemon.receiver.port, reviewDelivery);
    await deliver(daemon.receiver.port, runDelivery("2026-11-26T10:00:00Z"));
    await sleep(120);
    assert.equal(
      host.mails.filter((mail) => mail.sessionID === "ses_reviews").length,
      1,
      "the replayed delivery never wakes twice",
    );
    assert.equal(
      host.mails.filter((mail) => mail.sessionID === "ses_target").length,
      1,
      "the run delivery's replay is absorbed",
    );

    // The rerun — the same run id, a fresh updated_at — wakes again.
    await deliver(daemon.receiver.port, runDelivery("2026-11-26T10:05:00Z"));
    await waitFor(
      () =>
        host.mails.filter((mail) => mail.sessionID === "ses_target").length ===
        2,
    );
    // The dedupe markers ride the stamps.
    const stamps = (await client.list("ses_reviews")) as {
      rows: Array<{ delivered: Record<string, boolean> }>;
    };
    assert.ok(
      stamps.rows[0]?.delivered["pr-review:acme/widgets:7:2"],
      "the delivered marker is the content-derived dedupe id",
    );
    const runStamps = (await client.list("ses_target")) as {
      rows: Array<{ delivered: Record<string, boolean> }>;
    };
    assert.ok(
      runStamps.rows[0]?.delivered[
        "run:acme/widgets:999:completed:2026-11-26T10:00:00Z"
      ],
      "the first verdict's marker is on the stamp",
    );
    assert.ok(
      runStamps.rows[0]?.delivered[
        "run:acme/widgets:999:completed:2026-11-26T10:05:00Z"
      ],
      "the rerun's fresh dedupe id wakes and marks",
    );

    // The receiver's named refusals, end to end.
    const unsigned = await new Promise<{ status: number }>(
      (resolve, reject) => {
        const request = http.request(
          {
            host: "127.0.0.1",
            port: daemon.receiver.port,
            method: "POST",
            path: "/hook",
          },
          (response) => {
            response.resume();
            response.on("end", () =>
              resolve({ status: response.statusCode ?? 0 }),
            );
          },
        );
        request.on("error", reject);
        request.end(reviewDelivery);
      },
    );
    assert.equal(unsigned.status, 403, "a missing signature is refused");

    const forged = await deliver(
      daemon.receiver.port,
      reviewDelivery,
      "wrong-secret",
    );
    assert.equal(forged.status, 403, "a wrong signature is refused");

    // Fail closed: a daemon started without its secret refuses
    // everything, correctly signed or not.
    unsecreted = await startDaemon({
      watcherBlock: {
        forgeUrl: forge.url,
        pollSeconds: 0.02,
        dbPath: join(stateHome, "pr-state-other.db"),
      },
      port: 0,
      webhookPort: 0,
      webhookSecret: "",
    });
    const refused = await deliver(unsecreted.receiver.port, reviewDelivery);
    assert.equal(refused.status, 403);
    assert.match(JSON.parse(refused.body).error, /no secret configured/);
    assert.equal(host.mails.length, 3, "no mail came from a refused delivery");
  } finally {
    await daemon?.stop();
    await unsecreted?.stop();
    await forge.close();
    await host.close();
    if (priorStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = priorStateHome;
    if (priorToken === undefined) delete process.env.FORGEJO_TOKEN;
    else process.env.FORGEJO_TOKEN = priorToken;
    rmSync(stateHome, { recursive: true, force: true });
  }
});
