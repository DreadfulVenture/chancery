import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { startServer } from "../src/server.js";
import { baseConfig, makeFakeForgejo, serve } from "./helpers.js";

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

let close: (() => Promise<void>) | undefined;
let intakeClose: (() => Promise<void>) | undefined;
afterEach(async () => {
  if (close) await close();
  if (intakeClose) await intakeClose();
  close = undefined;
  intakeClose = undefined;
});

describe("webhook verification and translation", () => {
  it("rejects missing/invalid signature", async () => {
    const handle = await startServer({ ...baseConfig } as any, {
      forgejo: makeFakeForgejo(),
    });
    close = handle.close;
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/webhooks/forgejo`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gitea-Event": "pull_request",
        },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(401);
  });

  it("translates pull_request review_requested and delivers to intake", async () => {
    const received: any[] = [];
    const intake = await serve(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      received.push({
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(202);
      res.end("accepted");
    });
    intakeClose = intake.close;

    const handle = await startServer(
      { ...baseConfig, intakeUrl: intake.baseUrl } as any,
      { forgejo: makeFakeForgejo() },
    );
    close = handle.close;

    const payload = {
      action: "review_requested",
      number: 42,
      pull_request: { number: 42, title: "Add thing", id: 999 },
      requested_reviewer: { id: 55, login: "bot" },
      repository: { full_name: "org/repo" },
      sender: { login: "example-user" },
    };
    const body = JSON.stringify(payload);
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/webhooks/forgejo`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gitea-Event": "pull_request",
          "X-Gitea-Delivery": "deliv-1",
          "X-Gitea-Signature": sign(baseConfig.webhookSecret, body),
        },
        body,
      },
    );
    expect(res.status).toBe(202);
    expect(received).toHaveLength(1);
    expect(received[0].auth).toBe("Bearer event-token");
    expect(received[0].body).toMatchObject({
      kind: "review_requested",
      eventId: "deliv-1",
      repo: "org/repo",
      pr: 42,
      requesterLogin: "example-user",
      commentId: "55",
    });

    // A re-request of the same PR arrives as its own forge delivery: a
    // second, different event identity, with the same reviewer metadata.
    const reRequestBody = JSON.stringify(payload);
    const reRequest = await fetch(
      `http://127.0.0.1:${handle.port}/webhooks/forgejo`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gitea-Event": "pull_request",
          "X-Gitea-Delivery": "deliv-2",
          "X-Gitea-Signature": sign(baseConfig.webhookSecret, reRequestBody),
        },
        body: reRequestBody,
      },
    );
    expect(reRequest.status).toBe(202);
    expect(received).toHaveLength(2);
    expect(received[1].body).toMatchObject({
      kind: "review_requested",
      eventId: "deliv-2",
      repo: "org/repo",
      pr: 42,
      commentId: "55",
    });
    expect(received[1].body.eventId).not.toBe(received[0].body.eventId);
  });

  it("translates issue_comment reply with in_reply_to and delivers", async () => {
    const received: any[] = [];
    const intake = await serve(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(202);
      res.end("accepted");
    });
    intakeClose = intake.close;

    const handle = await startServer(
      { ...baseConfig, intakeUrl: intake.baseUrl } as any,
      { forgejo: makeFakeForgejo() },
    );
    close = handle.close;

    const payload = {
      action: "created",
      issue: { number: 42, pull_request: { url: "x" } },
      comment: {
        id: 200,
        body: "thanks",
        in_reply_to_id: 100,
        user: { login: "alice" },
      },
      repository: { full_name: "org/repo" },
    };
    const body = JSON.stringify(payload);
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/webhooks/forgejo`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gitea-Event": "issue_comment",
          "X-Gitea-Delivery": "deliv-2",
          "X-Gitea-Signature": sign(baseConfig.webhookSecret, body),
        },
        body,
      },
    );
    expect(res.status).toBe(202);
    expect(received[0]).toMatchObject({
      kind: "reply",
      eventId: "deliv-2",
      repo: "org/repo",
      pr: 42,
      authorLogin: "alice",
      inReplyTo: "100",
      commentId: "200",
      text: "thanks",
    });
  });

  it("ignores a top-level @review mention comment: the summon command is gone", async () => {
    let called = 0;
    const intake = await serve((_req, res) => {
      called += 1;
      res.writeHead(202);
      res.end();
    });
    intakeClose = intake.close;

    const handle = await startServer(
      { ...baseConfig, intakeUrl: intake.baseUrl } as any,
      { forgejo: makeFakeForgejo() },
    );
    close = handle.close;

    // A top-level comment that names the old summon command is ordinary
    // chatter now: delivered to the webhook route (202) but translated to
    // nothing and delivered to no intake.
    const payload = {
      action: "created",
      issue: { number: 47, pull_request: { url: "x" } },
      comment: {
        id: 1754,
        body: "@zenigata @review",
        user: { login: "example-user" },
      },
      repository: { full_name: "org/repo" },
    };
    const body = JSON.stringify(payload);
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/webhooks/forgejo`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gitea-Event": "issue_comment",
          "X-Gitea-Delivery": "deliv-review-1",
          "X-Gitea-Signature": sign(baseConfig.webhookSecret, body),
        },
        body,
      },
    );
    expect(res.status).toBe(202);
    expect(called).toBe(0);
  });

  it("ignores unsupported/unmappable events without inventing kinds", async () => {
    let called = 0;
    const intake = await serve((_req, res) => {
      called += 1;
      res.writeHead(202);
      res.end();
    });
    intakeClose = intake.close;
    const handle = await startServer(
      { ...baseConfig, intakeUrl: intake.baseUrl } as any,
      { forgejo: makeFakeForgejo() },
    );
    close = handle.close;

    // issue_comment without reply target cannot satisfy contract -> ignored
    const payload = {
      action: "created",
      issue: { number: 42, pull_request: { url: "x" } },
      comment: { id: 200, body: "hi", user: { login: "alice" } },
      repository: { full_name: "org/repo" },
    };
    const body = JSON.stringify(payload);
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/webhooks/forgejo`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gitea-Event": "issue_comment",
          "X-Gitea-Signature": sign(baseConfig.webhookSecret, body),
        },
        body,
      },
    );
    expect(res.status).toBe(202);
    expect(called).toBe(0);

    // A mention without the @review command is ordinary chatter -> ignored.
    const chatter = {
      action: "created",
      issue: { number: 42, pull_request: { url: "x" } },
      comment: {
        id: 201,
        body: "@zenigata any thought on the retry gate?",
        user: { login: "alice" },
      },
      repository: { full_name: "org/repo" },
    };
    const chatterBody = JSON.stringify(chatter);
    const chatterRes = await fetch(
      `http://127.0.0.1:${handle.port}/webhooks/forgejo`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gitea-Event": "issue_comment",
          "X-Gitea-Delivery": "deliv-chatter",
          "X-Gitea-Signature": sign(baseConfig.webhookSecret, chatterBody),
        },
        body: chatterBody,
      },
    );
    expect(chatterRes.status).toBe(202);
    expect(called).toBe(0);
  });
});
