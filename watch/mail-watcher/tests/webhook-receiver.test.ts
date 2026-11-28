import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import {
  startHookDiagnosis,
  startWebhookReceiver,
  verifySignature,
} from "../daemon/webhook-receiver.ts";
import type { IngestEntry } from "../webhook-events.ts";

// The webhook receiver (PRJ-542): the signature verification over the
// raw body, the named statuses, the fail-closed secret, and the
// missing-hook self-diagnosis line. Loopback fakes only — nothing here
// dials a forge.

const SECRET = "sekrit-webhook-secret-7e3";

const sign = (body: Buffer, secret = SECRET) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");

const post = (
  port: number,
  body: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/whatever" },
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
    for (const [name, value] of Object.entries(headers)) {
      request.setHeader(name, value);
    }
    request.end(body);
  });

const startReceiver = async (secret = SECRET) => {
  const queued: IngestEntry[] = [];
  const receiver = await startWebhookReceiver({
    port: 0,
    secret,
    ingest: { push: (repo, entry) => queued.push(entry) },
  });
  return { receiver, queued };
};

const deliveryPayload = JSON.stringify({
  action: "submitted",
  repository: { full_name: "acme/widgets" },
  pull_request: { number: 7 },
  review: {
    id: 42,
    state: "APPROVED",
    user: { login: "fresh-reviewer" },
  },
});

test("a correctly signed delivery is answered 200 and queued; the signature rides the raw body bytes", async () => {
  const { receiver, queued } = await startReceiver();
  try {
    // The raw-body case: a multibyte payload whose JSON re-serialization
    // would not match — the HMAC is taken over the exact bytes sent.
    const raw = Buffer.from(
      JSON.stringify({
        action: "submitted",
        repository: { full_name: "acme/widgets" },
        pull_request: { number: 7 },
        review: {
          id: 43,
          state: "COMMENTED",
          user: { login: "réviewer" },
        },
      }),
      "utf8",
    );
    const ok = await post(receiver.port, raw, {
      "x-forgejo-signature": sign(raw),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true, queued: 1 });
    assert.equal(queued.length, 1);
    assert.equal(queued[0].repo, "acme/widgets");

    // The sha256= prefixed form signs the same way.
    const prefixed = await post(receiver.port, raw, {
      "x-forgejo-signature": `sha256=${sign(raw)}`,
    });
    assert.equal(prefixed.status, 200);
    assert.equal(queued.length, 2);
  } finally {
    await receiver.close();
  }
});

test("a wrong, missing, malformed, or unsecreted signature is 403, said so the forge's delivery history shows it", async () => {
  const { receiver, queued } = await startReceiver();
  try {
    const raw = Buffer.from(deliveryPayload, "utf8");
    const wrong = await post(receiver.port, raw, {
      "x-forgejo-signature": sign(Buffer.from("tampered", "utf8")),
    });
    assert.equal(wrong.status, 403);
    assert.match(JSON.parse(wrong.body).error, /does not verify/);

    const missing = await post(receiver.port, raw, {});
    assert.equal(missing.status, 403);
    assert.match(JSON.parse(missing.body).error, /X-Forgejo-Signature/);

    const malformed = await post(receiver.port, raw, {
      "x-forgejo-signature": "not-hex-at-all!",
    });
    assert.equal(malformed.status, 403);

    const short = await post(receiver.port, raw, {
      "x-forgejo-signature": "abcd",
    });
    assert.equal(short.status, 403);
    assert.equal(queued.length, 0, "nothing unverified is queued");
  } finally {
    await receiver.close();
  }

  // Fail closed: a receiver without its secret refuses everything.
  const unsecreted = await startReceiver("");
  try {
    const raw = Buffer.from(deliveryPayload, "utf8");
    const refused = await post(unsecreted.receiver.port, raw, {
      "x-forgejo-signature": sign(raw),
    });
    assert.equal(refused.status, 403);
    assert.match(JSON.parse(refused.body).error, /no secret configured/);
    assert.equal(unsecreted.queued.length, 0);
    assert.equal(verifySignature(raw, sign(raw), ""), false);
  } finally {
    await unsecreted.receiver.close();
  }
});

test("a body that is not a JSON record is 400; a named delivery the watcher does not consume still answers 200", async () => {
  const { receiver, queued } = await startReceiver();
  try {
    const notJson = Buffer.from("hello", "utf8");
    const bad = await post(receiver.port, notJson, {
      "x-forgejo-signature": sign(notJson),
    });
    assert.equal(bad.status, 400);
    assert.match(JSON.parse(bad.body).error, /not JSON/);

    const array = Buffer.from("[1,2]", "utf8");
    const notRecord = await post(receiver.port, array, {
      "x-forgejo-signature": sign(array),
    });
    assert.equal(notRecord.status, 400);
    assert.match(JSON.parse(notRecord.body).error, /not a JSON record/);

    const unknown = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    const unnamed = await post(receiver.port, unknown, {
      "x-forgejo-signature": sign(unknown),
    });
    assert.equal(unnamed.status, 200);
    assert.deepEqual(JSON.parse(unnamed.body), { ok: true, queued: 0 });
    assert.equal(queued.length, 0);

    const get = await new Promise<{ status: number }>((resolve, reject) => {
      const request = http.request(
        { host: "127.0.0.1", port: receiver.port, method: "GET", path: "/" },
        (response) => {
          response.resume();
          response.on("end", () =>
            resolve({ status: response.statusCode ?? 0 }),
          );
        },
      );
      request.on("error", reject);
      request.end();
    });
    assert.equal(get.status, 404);
  } finally {
    await receiver.close();
  }
});

test("the missing-hook self-diagnosis says the watched repo whose hook is missing, and stays silent when the hook names this receiver", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (line: unknown) => errors.push(String(line));
  try {
    const hooksOf = async (owner: string, name: string) => {
      if (name === "missing") return [];
      if (name === "unreachable") throw new Error("GET hooks → HTTP 403");
      return [
        {
          active: true,
          config: {
            url: "https://tunnel.example/watcher/",
            content_type: "json",
          },
        },
      ];
    };
    const diagnosis = startHookDiagnosis({
      watches: () => [
        { source: "forgejo", repo: "acme/missing" },
        { source: "forgejo", repo: "acme/hooked" },
        { source: "forgejo", repo: "acme/unreachable" },
        { source: "slack", repo: "#channel" },
      ],
      hooksOf,
      expectedUrl: () => "https://tunnel.example/watcher",
      debug: () => {},
      firstAfterMs: 1,
      intervalMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    diagnosis.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      errors.length,
      1,
      `one missing hook, one line: ${JSON.stringify(errors)}`,
    );
    assert.match(errors[0], /webhook hook missing on acme\/missing/);
    assert.match(errors[0], /https:\/\/tunnel\.example\/watcher/);
    assert.match(errors[0], /WATCHER_WEBHOOK_SECRET/);
    assert.match(errors[0], /workflow_run/);
    // A second round says it again — the line is the standing diagnosis.
    const second = startHookDiagnosis({
      watches: () => [{ source: "forgejo", repo: "acme/hooked" }],
      hooksOf,
      expectedUrl: () => "https://tunnel.example/watcher",
      debug: () => {},
      firstAfterMs: 1,
      intervalMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    second.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      errors.length,
      1,
      "a repo whose hook names this receiver is never diagnosed missing",
    );
  } finally {
    console.error = originalError;
  }
});
