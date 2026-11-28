// The webhook receiver (PRJ-542): the daemon's second HTTP server, and
// a different trust domain from the loopback route beside it. The route
// serves the host's own processes; the receiver serves an external
// forge's deliveries, and everything it accepts rides the signature
// first. The two servers share the daemon process and nothing else —
// no dependency of this module reaches the route's handlers, and the
// route's callers can never reach this surface by accident. The HTTP
// surface is a hono app served through the node adapter (the house
// shape for product servers): routing and the refusal surfaces on the
// framework, the verification and the ingest on this module.
//
// The discipline, on the forge's delivery history the way linear-sync's
// own receiver shaped it:
//
// - Every delivery is verified before it is read: HMAC-SHA256 over the
//   raw body bytes, the digest compared constant-time against
//   X-Forgejo-Signature (an optional `sha256=` prefix tolerated). A
//   missing, malformed, or wrong signature is 403; a body that does not
//   parse to a JSON record is 400; a receiver fault is 500 — named
//   statuses, so the forge's delivery history shows the failure and
//   not a blind retry loop.
// - The secret is fail closed: a receiver with no secret configured
//   (WATCHER_WEBHOOK_SECRET absent or empty in the daemon's
//   environment — the secrets file's job, never the rendered settings)
//   refuses every delivery with 403 rather than serving an unverified
//   one. The forge keeps seeing the named failure.
// - A verified delivery is answered 200 quickly: the body normalizes to
//   zero or one ingest entry, the push wakes the pass loop, and the
//   response goes out — the pass's reads and mails never wait inside
//   the request.
//
// The bind is a module option defaulting to loopback (the adopter-first
// shape: zero infra change, polling stays the backstop for a forge that
// cannot reach the host). Making the receiver reachable — an LAN
// allow-list, a tunnel front — is the deployment's choice, and the hook
// registration it calls for is a hand step either way: the deployment
// registers one hook per watched repo (url + secret + the v17 events)
// and the daemon self-diagnoses a watched repo whose hook is missing
// (startHookDiagnosis below).

import crypto from "node:crypto";
import type { Server } from "node:http";
import { createAdaptorServer, type HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { isRecord, type Debug } from "../kernel.ts";
import {
  normalizeForgejoDelivery,
  type IngestEntry,
  type IngestQueue,
} from "../webhook-events.ts";

export type { IngestEntry };

// The delivery body's cap: a forge record the receiver refuses before
// reading is a failed delivery in the history, not a memory event.
const BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * The signature check: HMAC-SHA256 over the raw body, compared
 * constant-time. An empty secret fails closed — the caller has already
 * answered 403 on that path, and the check refuses again rather than
 * trusting a header alone.
 */
export const verifySignature = (
  raw: Buffer,
  header: string | undefined,
  secret: string,
): boolean => {
  if (!secret) return false;
  if (!header) return false;
  const provided = header
    .trim()
    .replace(/^sha256=/i, "")
    .toLowerCase();
  if (!/^[0-9a-f]+$/.test(provided)) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest();
  const given = Buffer.from(provided, "hex");
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
};

type App = Hono<{ Bindings: HttpBindings }>;

export type ReceiverServer = {
  url: string;
  port: number;
  close: () => Promise<void>;
};

// The receiver's HTTP surface: a hono app whose one route is the
// delivery POST — any path, since the deployment's hook url names the
// path its reachability choice produces. The routing is the framework's;
// what the class owns is the assembly: the named refusal surfaces (the
// empty secret's 403, the unverified signature's 403, the unreadable
// body's 400, the 404 and 500), the listen and close lifecycle, and the
// handle the daemon's log names.
export class WebhookReceiver {
  private readonly app: App = new Hono();
  private bound: Server | undefined;
  private readonly secret: string;
  private readonly ingest: Pick<IngestQueue, "push">;
  private readonly debug: Debug;

  constructor(secret: string, ingest: Pick<IngestQueue, "push">, debug: Debug) {
    this.secret = secret;
    this.ingest = ingest;
    this.debug = debug;
    this.wire();
  }

  private wire(): void {
    this.app.post("*", (c) => this.deliver(c));
    this.app.notFound((c) =>
      c.json(
        {
          error: `no route ${c.req.method} (the receiver serves POST deliveries)`,
        },
        404,
      ),
    );
    this.app.onError((error, c) => {
      // A receiver fault is named, never a stack: the forge's delivery
      // history shows the failure and the daemon's log carries the
      // reason.
      console.error(`[forgejo-watcher] the webhook receiver failed: ${error}`);
      return c.json(
        { error: "the webhook receiver failed to process the delivery" },
        500,
      );
    });
  }

  private async deliver(
    c: Context<{ Bindings: HttpBindings }>,
  ): Promise<Response> {
    // Fail closed: no secret in the daemon's environment, no verified
    // delivery, ever. The 403 keeps the forge's delivery history saying
    // what is wrong instead of silently dropping.
    if (!this.secret) {
      return c.json(
        {
          error:
            "the webhook receiver has no secret configured — set WATCHER_WEBHOOK_SECRET in the daemon's secrets file; the delivery is refused",
        },
        403,
      );
    }
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (raw.length > BODY_LIMIT_BYTES) {
      return c.json(
        {
          error: `the delivery body exceeds the receiver's limit (${BODY_LIMIT_BYTES} bytes)`,
        },
        400,
      );
    }
    const signature = c.req.header("x-forgejo-signature");
    if (!signature || !verifySignature(raw, signature, this.secret)) {
      return c.json(
        {
          error:
            "the delivery's X-Forgejo-Signature does not verify over the body",
        },
        403,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return c.json({ error: "the delivery body is not JSON" }, 400);
    }
    if (!isRecord(payload)) {
      return c.json({ error: "the delivery body is not a JSON record" }, 400);
    }
    const entry = normalizeForgejoDelivery(payload);
    if (!entry) {
      this.debug("webhook.delivery.unnamed", {});
      return c.json({ ok: true, queued: 0 }, 200);
    }
    this.ingest.push(entry.repo, entry);
    return c.json({ ok: true, queued: 1 }, 200);
  }

  /** Bind to the caller's address; resolves with the port actually bound. */
  listen(host: string, port: number): Promise<number> {
    const server = createAdaptorServer({ fetch: this.app.fetch }) as Server;
    this.bound = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        const address = server.address();
        const bound =
          typeof address === "object" && address !== null ? address.port : port;
        // A server-level error after startup has no response to answer:
        // the adaptor covers the request's own socket errors, and this
        // listener covers the rest — routed through the same named fault
        // line the handler's onError path prints, the unit's restart
        // policy owning the recovery.
        server.removeAllListeners("error");
        server.on("error", (error) => {
          console.error(
            `[forgejo-watcher] the webhook receiver failed: ${error}`,
          );
        });
        resolve(bound);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.bound === undefined) {
        resolve();
        return;
      }
      this.bound.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

// The receiver's start: the bind is the caller's (the module option's
// default is loopback; a deployment's reachability choice names
// something else), and the promise resolves once listening so the
// daemon's log names a live url.
export const startWebhookReceiver = async ({
  host = "127.0.0.1",
  port,
  secret,
  ingest,
  debug = () => {},
}: {
  host?: string;
  port: number;
  secret: string;
  ingest: Pick<IngestQueue, "push">;
  debug?: Debug;
}): Promise<ReceiverServer> => {
  const receiver = new WebhookReceiver(secret, ingest, debug);
  const bound = await receiver.listen(host, port);
  return {
    url: `http://${host}:${bound}`,
    port: bound,
    close: () => receiver.close(),
  };
};

// The hook diagnosis (PRJ-542): the deployment registers one hook per
// watched repo by hand — url + secret + the v17 events — and the daemon
// says so when a watched repo's hooks read carries no active hook that
// names this receiver. The expected url is the deployment's stated
// webhookUrl when it set one (a tunnel front's address, an LAN bind's —
// the reachability choice's own url), else the receiver's own origin.
// One round reads one hooks list per watched repo; the rounds are
// throttled, the first one after start gives a fresh deployment a
// moment to register, and a read that fails says so on its debug line
// and is silent — a forge outage is not a missing hook.
export const startHookDiagnosis = ({
  watches,
  hooksOf,
  expectedUrl,
  debug = () => {},
  firstAfterMs = 60_000,
  intervalMs = 600_000,
}: {
  watches: () => Array<{ source: string; repo: string }>;
  hooksOf: (owner: string, name: string) => Promise<unknown>;
  expectedUrl: () => string;
  debug?: Debug;
  firstAfterMs?: number;
  intervalMs?: number;
}): { stop: () => void } => {
  let stopped = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];

  const round = async () => {
    if (stopped) return;
    const repos = new Set(
      watches()
        .filter(
          (watch) => watch.source === "forgejo" && watch.repo.includes("/"),
        )
        .map((watch) => watch.repo),
    );
    for (const repo of repos) {
      if (stopped) return;
      const [owner, name] = repo.split("/");
      let rows: unknown;
      try {
        rows = await hooksOf(owner, name);
      } catch (error) {
        debug("hook.list.unread", { repo, error: String(error) });
        continue;
      }
      if (!Array.isArray(rows)) {
        debug("hook.list.unparsed", { repo });
        continue;
      }
      const wanted = expectedUrl().replace(/\/+$/, "").toLowerCase();
      const found = rows.some(
        (row) =>
          isRecord(row) &&
          row.active !== false &&
          isRecord(row.config) &&
          typeof row.config.url === "string" &&
          row.config.url.trim().replace(/\/+$/, "").toLowerCase() === wanted,
      );
      if (found) continue;
      console.error(
        `[forgejo-watcher] webhook hook missing on ${repo}: no active forge hook names this receiver (${wanted}); events arrive only by the polling backstop — register the repo's webhook by hand: url ${wanted}, the secret in WATCHER_WEBHOOK_SECRET, the workflow_run, workflow_job, pull_request, and pull_request_review events`,
      );
    }
  };

  const schedule = (delay: number) => {
    const timer = setTimeout(() => {
      void round();
      if (!stopped) schedule(intervalMs);
    }, delay);
    timers.push(timer);
  };
  schedule(firstAfterMs);

  return {
    stop: () => {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
    },
  };
};
