import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import { ForgejoHttpError, type ForgejoClient } from "./forgejo-client.js";
import { deliverToIntake } from "./intake.js";
import { redactSecrets } from "./redact.js";
import { translateForgejoWebhook } from "./translate.js";

const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLarge extends Error {
  constructor() {
    super("body too large");
    this.name = "BodyTooLarge";
  }
}

const prQuerySchema = z.object({
  repo: z.string().min(1),
  pr: z.coerce.number().int().positive(),
});

const reviewQuerySchema = z.object({
  repo: z.string().min(1),
  pr: z.coerce.number().int().positive(),
  head: z.string().min(1),
});

const reviewPayloadSchema = z.object({
  repo: z.string(),
  pr: z.number().int().positive(),
  expectedHeadSha: z.string(),
  verdict: z.enum(["APPROVE", "REQUEST_CHANGES"]),
  body: z.string(),
  comments: z.array(
    z.object({ path: z.string(), line: z.number(), body: z.string() }),
  ),
});

const replyPayloadSchema = z.object({
  repo: z.string(),
  pr: z.number().int().positive(),
  inReplyTo: z.string(),
  body: z.string(),
});

const failurePayloadSchema = z.object({
  repo: z.string(),
  pr: z.number().int().positive(),
  inReplyTo: z.string().optional(),
  body: z.string(),
});

export interface ServerDeps {
  forgejo: ForgejoClient;
  logger?: Pick<Console, "info" | "error" | "warn">;
  deliver?: typeof deliverToIntake;
}

export interface ServerHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) {
    return undefined;
  }
  return header.slice("Bearer ".length);
}

function tokenEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      settle();
    };
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.pause();
        finish(() => reject(new BodyTooLarge()));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => finish(() => resolve(Buffer.concat(chunks))));
    request.on("error", (error) => finish(() => reject(error)));
    request.on("close", () =>
      finish(() =>
        reject(new Error("connection closed before the body was read")),
      ),
    );
  });
}

function respond(
  response: ServerResponse,
  status: number,
  body: string | object,
  contentType?: string,
): void {
  if (typeof body === "string") {
    response.writeHead(status, {
      "Content-Type": contentType ?? "text/plain; charset=utf-8",
    });
    response.end(body);
    return;
  }
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function humanError(error: unknown): { status: number; message: string } {
  if (error instanceof ForgejoHttpError) {
    // Preserve 409 expected-head refusals with their human-readable body.
    return {
      status: error.status,
      message: redactSecrets(error.message).slice(0, 500),
    };
  }
  if (error instanceof Error) {
    return { status: 502, message: redactSecrets(error.message).slice(0, 500) };
  }
  return { status: 502, message: "forge adapter error" };
}

function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  headers: IncomingMessage["headers"],
): boolean {
  // Prefer SHA-256 signature headers and recognize Forgejo/Gitea variants.
  // Select the signature the code verifies (HMAC-SHA256) even if other
  // signature headers are present.
  const sig =
    (headers["x-hub-signature-256"] as string | undefined) ??
    (headers["x-forgejo-signature-256"] as string | undefined) ??
    (headers["x-gitea-signature-256"] as string | undefined) ??
    (headers["x-forgejo-signature"] as string | undefined) ??
    (headers["x-gitea-signature"] as string | undefined);
  if (!sig) return false;
  const hmac = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expected = sig.startsWith("sha256=") ? `sha256=${hmac}` : hmac;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function startServer(
  config: Config,
  deps: ServerDeps,
): Promise<ServerHandle> {
  const logger = deps.logger ?? console;
  const deliver = deps.deliver ?? deliverToIntake;

  const requireOutboundAuth = (request: IncomingMessage): boolean => {
    const token = bearerToken(request);
    return token !== undefined && tokenEquals(token, config.outboundToken);
  };

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const reqUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        const path = reqUrl.pathname;

        if (request.method === "GET" && path === "/healthz") {
          respond(response, 200, "ok");
          return;
        }

        // Outbound endpoints (bot -> adapter)
        if (
          path === "/pr" ||
          path === "/pr/diff" ||
          path === "/review" ||
          path === "/reply" ||
          path === "/failure"
        ) {
          if (!requireOutboundAuth(request)) {
            respond(response, 401, "unauthorized");
            return;
          }
        }

        if (request.method === "GET" && path === "/pr") {
          const parsed = prQuerySchema.safeParse({
            repo: reqUrl.searchParams.get("repo") ?? "",
            pr: reqUrl.searchParams.get("pr") ?? "",
          });
          if (!parsed.success) {
            respond(response, 400, "invalid query");
            return;
          }
          const pr = await deps.forgejo.getPullRequest(
            parsed.data.repo,
            parsed.data.pr,
          );
          respond(response, 200, pr);
          return;
        }

        if (request.method === "GET" && path === "/pr/diff") {
          const parsed = prQuerySchema.safeParse({
            repo: reqUrl.searchParams.get("repo") ?? "",
            pr: reqUrl.searchParams.get("pr") ?? "",
          });
          if (!parsed.success) {
            respond(response, 400, "invalid query");
            return;
          }
          const diff = await deps.forgejo.getDiff(
            parsed.data.repo,
            parsed.data.pr,
          );
          respond(response, 200, diff, "text/plain; charset=utf-8");
          return;
        }

        if (request.method === "GET" && path === "/review") {
          const parsed = reviewQuerySchema.safeParse({
            repo: reqUrl.searchParams.get("repo") ?? "",
            pr: reqUrl.searchParams.get("pr") ?? "",
            head: reqUrl.searchParams.get("head") ?? "",
          });
          if (!parsed.success) {
            respond(response, 400, "invalid query");
            return;
          }
          const found = await deps.forgejo.getPostedReview(
            parsed.data.repo,
            parsed.data.pr,
            parsed.data.head,
          );
          if (!found) {
            respond(response, 404, "no review for that head");
            return;
          }
          respond(response, 200, found);
          return;
        }

        if (request.method === "POST" && path === "/review") {
          let body: unknown;
          try {
            body = JSON.parse((await readBody(request)).toString("utf8"));
          } catch (error) {
            if (error instanceof BodyTooLarge) {
              respond(response, 413, "body too large");
              response.on("finish", () => request.destroy());
              return;
            }
            respond(response, 400, "invalid json");
            return;
          }
          const parsed = reviewPayloadSchema.safeParse(body);
          if (!parsed.success) {
            respond(response, 400, "invalid review payload");
            return;
          }
          const posted = await deps.forgejo.postReview(parsed.data);
          respond(response, 200, posted);
          return;
        }

        if (request.method === "POST" && path === "/reply") {
          let body: unknown;
          try {
            body = JSON.parse((await readBody(request)).toString("utf8"));
          } catch (error) {
            if (error instanceof BodyTooLarge) {
              respond(response, 413, "body too large");
              response.on("finish", () => request.destroy());
              return;
            }
            respond(response, 400, "invalid json");
            return;
          }
          const parsed = replyPayloadSchema.safeParse(body);
          if (!parsed.success) {
            respond(response, 400, "invalid reply payload");
            return;
          }
          const posted = await deps.forgejo.postReply(parsed.data);
          respond(response, 200, posted);
          return;
        }

        if (request.method === "POST" && path === "/failure") {
          let body: unknown;
          try {
            body = JSON.parse((await readBody(request)).toString("utf8"));
          } catch (error) {
            if (error instanceof BodyTooLarge) {
              respond(response, 413, "body too large");
              response.on("finish", () => request.destroy());
              return;
            }
            respond(response, 400, "invalid json");
            return;
          }
          const parsed = failurePayloadSchema.safeParse(body);
          if (!parsed.success) {
            respond(response, 400, "invalid failure payload");
            return;
          }
          await deps.forgejo.postFailureComment(parsed.data);
          respond(response, 200, "ok");
          return;
        }

        // Inbound webhook (forge -> adapter -> zenigata intake)
        if (request.method === "POST" && path === "/webhooks/forgejo") {
          let raw: Buffer;
          try {
            raw = await readBody(request);
          } catch (error) {
            if (error instanceof BodyTooLarge) {
              respond(response, 413, "body too large");
              response.on("finish", () => request.destroy());
              return;
            }
            respond(response, 400, "invalid body");
            return;
          }
          if (
            !verifyWebhookSignature(config.webhookSecret, raw, request.headers)
          ) {
            respond(response, 401, "invalid signature");
            return;
          }
          let payload: unknown;
          try {
            payload = JSON.parse(raw.toString("utf8"));
          } catch {
            respond(response, 400, "invalid json");
            return;
          }
          const eventName = String(
            request.headers["x-gitea-event"] ??
              request.headers["x-forgejo-event"] ??
              "",
          );
          const deliveryId = String(
            request.headers["x-gitea-delivery"] ??
              request.headers["x-forgejo-delivery"] ??
              "",
          );
          const translated = translateForgejoWebhook({
            event: eventName,
            deliveryId: deliveryId || undefined,
            payload,
          });
          if (!translated) {
            // Unsupported or unmappable event: acknowledge without inventing a contract kind.
            respond(response, 202, "ignored");
            return;
          }
          const delivered = await deliver({
            intakeUrl: config.intakeUrl,
            eventToken: config.eventToken,
            event: translated,
            timeoutMs: config.requestTimeoutMs,
          });
          if (!delivered.ok) {
            respond(
              response,
              502,
              `intake delivery failed: ${delivered.status} ${redactSecrets(delivered.body).slice(0, 200)}`,
            );
            return;
          }
          respond(response, 202, "accepted");
          return;
        }

        respond(response, 404, "not found");
      } catch (error) {
        const { status, message } = humanError(error);
        logger.error?.(`forgejo-adapter request failed: ${message}`);
        if (!response.headersSent) {
          respond(response, status, message);
        } else {
          response.end();
        }
      }
    })();
  });

  const listen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        const bound =
          typeof address === "object" && address !== null ? address.port : port;
        resolve(bound);
      });
    });

  const port = await listen(config.listenPort);
  logger.info?.(`forgejo-adapter listening on port ${port}`);

  return {
    server,
    port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
