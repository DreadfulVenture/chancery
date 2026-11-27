/**
 * The intake route: POST /v1/events. The auth contract is the bearer
 * token, compared timing-safely; the body contract is the 1 MiB cap
 * answered with 413 before the socket drops (the refusal must be out on
 * the wire before the socket goes, or the client never sees it); the
 * payload contract is the forge event schema, parsed by zod. An accepted
 * event answers 202 and dispatches into the pipeline.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HttpBindings } from "@hono/node-server";
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { ForgeEventSchema } from "../contracts/forge.js";
import type { EventPipeline } from "../pipeline.js";

/** The intake refuses a body past this size with 413. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** The body crossed MAX_BODY_BYTES and was not read to the end. */
class BodyTooLarge extends Error {}

/** One text/plain response, content-type pinned byte for byte. */
export const plain = (
  c: Context,
  status: ContentfulStatusCode,
  body: string,
): Response =>
  c.body(body, status, { "Content-Type": "text/plain; charset=utf-8" });

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
    // Compare a dummy against itself to keep the branch timing flat.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      settle();
    };
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop consuming; the caller answers 413 first and drops the
        // socket only after the response is out.
        request.pause();
        finish(() => reject(new BodyTooLarge("body too large")));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () =>
      finish(() => resolve(Buffer.concat(chunks).toString("utf8"))),
    );
    request.on("error", (error) => finish(() => reject(error)));
    // A client that disconnects mid-body emits neither "end" nor "error":
    // only "close" fires, so the promise must settle there too or the
    // handler never responds.
    request.on("close", () =>
      finish(() =>
        reject(new Error("connection closed before the body was read")),
      ),
    );
  });
}

export class IntakeRoute {
  constructor(
    private readonly eventToken: string,
    private readonly pipeline: EventPipeline,
  ) {}

  handle = async (
    c: Context<{ Bindings: HttpBindings }>,
  ): Promise<Response> => {
    const incoming = c.env.incoming;
    const outgoing = c.env.outgoing;
    const token = bearerToken(incoming);
    if (token === undefined || !tokenEquals(token, this.eventToken)) {
      return plain(c, 401, "unauthorized");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(incoming));
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        // The 413 goes out first; the socket drops after the response has
        // flushed, or the client never sees the refusal.
        const refusal = plain(c, 413, "body too large");
        outgoing.on("finish", () => incoming.destroy());
        return refusal;
      }
      return plain(c, 400, "invalid event");
    }
    const event = ForgeEventSchema.safeParse(parsed);
    if (!event.success) {
      return plain(c, 400, "invalid event");
    }
    const accepted = plain(c, 202, "accepted");
    if (event.data.kind === "review_requested") {
      this.pipeline.processReview(event.data);
    } else {
      this.pipeline.processReply(event.data);
    }
    return accepted;
  };
}
