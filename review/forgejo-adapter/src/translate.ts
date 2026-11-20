import { z } from "zod";

const repoPattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export const ForgeEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("review_requested"),
    eventId: z.string(),
    repo: z.string().regex(repoPattern, "must be owner/name"),
    pr: z.number().int().positive(),
    requesterLogin: z.string(),
    commentId: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("reply"),
    eventId: z.string(),
    repo: z.string().regex(repoPattern, "must be owner/name"),
    pr: z.number().int().positive(),
    authorLogin: z.string(),
    inReplyTo: z.string(),
    commentId: z.string(),
    text: z.string(),
  }),
]);

export type ForgeEvent = z.infer<typeof ForgeEventSchema>;

function repoFullName(payload: any): string | undefined {
  const full = payload?.repository?.full_name;
  if (typeof full === "string" && repoPattern.test(full)) return full;
  const owner =
    payload?.repository?.owner?.login ?? payload?.repository?.owner?.username;
  const name = payload?.repository?.name;
  if (typeof owner === "string" && typeof name === "string") {
    const candidate = `${owner}/${name}`;
    if (repoPattern.test(candidate)) return candidate;
  }
  return undefined;
}

function deliveryEventId(
  deliveryId: string | undefined,
  fallback: string,
): string {
  if (deliveryId && deliveryId.trim() !== "") return deliveryId;
  return fallback;
}

/**
 * A top-level comment is a review request when it addresses the bot and
 * carries the command: at least one @-mention token that is not the command
 * itself, plus the `@review` token. Matching is whitespace-tokenized and
 * case-insensitive, so "@zenigata @review", "@ZENIGATA\n@review", and
 * "@review @zenigata" all trigger, while ordinary PR chatter without the
 * command stays ignored. The adapter has no config naming the bot's login,
 * so the mention is what "addresses the bot" can honestly mean here — the
 * intake still gates runs on its own requester allowlist.
 */
function isReviewCommandComment(text: string): boolean {
  let addressed = false;
  let command = false;
  for (const token of text.split(/\s+/)) {
    if (!token.startsWith("@")) continue;
    const name = token.slice(1).toLowerCase();
    if (name === "review") command = true;
    else if (name !== "") addressed = true;
  }
  return addressed && command;
}

/**
 * Translate a Forgejo webhook into a contract-shaped event, or null when the
 * webhook does not map to a supported contract event. Unsupported events are
 * intentionally ignored (no third event kind is invented).
 */
export function translateForgejoWebhook(opts: {
  event: string;
  deliveryId?: string;
  payload: unknown;
}): ForgeEvent | null {
  const { event, deliveryId, payload } = opts;
  const p = payload as any;
  const repo = repoFullName(p);
  if (!repo) return null;

  if (event === "pull_request") {
    const action = String(p?.action ?? "");
    if (action === "review_requested") {
      const pr = Number(p?.pull_request?.number ?? p?.number);
      if (!Number.isInteger(pr) || pr <= 0) return null;
      const requesterLogin = String(
        p?.sender?.login ?? p?.sender?.username ?? "unknown",
      );
      // The event's identity is the forge delivery id, so each re-request
      // of the same PR is a fresh event even though the reviewer's id
      // never changes; the same delivery replayed stays one identity.
      // commentId is metadata: the requested reviewer's forge id, the
      // stable repeat in the webhook payload, carried for narration.
      const commentId = String(
        p?.requested_reviewer?.id ??
          p?.pull_request?.id ??
          `review-request-${pr}`,
      );
      const text = String(
        p?.pull_request?.title
          ? `review requested: ${p.pull_request.title}`
          : "review requested",
      );
      const eventId = deliveryEventId(
        deliveryId,
        `pr-${repo}-${pr}-review_requested-${commentId}`,
      );
      const translated: ForgeEvent = {
        kind: "review_requested",
        eventId,
        repo,
        pr,
        requesterLogin,
        commentId,
        text,
      };
      return ForgeEventSchema.parse(translated);
    }
    return null;
  }

  if (event === "pull_request_comment" || event === "issue_comment") {
    const action = String(p?.action ?? "");
    if (action !== "created") return null;
    // Only PR-related issue comments translate.
    const prNumber = Number(
      p?.pull_request?.number ??
        p?.issue?.number ??
        p?.issue?.pull_request?.number,
    );
    const isPr = Boolean(p?.pull_request || p?.issue?.pull_request);
    if (!isPr || !Number.isInteger(prNumber) || prNumber <= 0) return null;
    const comment = p?.comment ?? {};
    const commentId = comment?.id != null ? String(comment.id) : "";
    const body = typeof comment?.body === "string" ? comment.body : "";
    const authorLogin = String(
      comment?.user?.login ??
        comment?.user?.username ??
        p?.sender?.login ??
        "unknown",
    );
    // Contract requires inReplyTo: only translate when the forge payload provides a reply target.
    const inReplyToRaw =
      comment?.in_reply_to_id ??
      comment?.in_reply_to ??
      comment?.reply_to ??
      p?.in_reply_to;
    const inReplyTo = inReplyToRaw != null ? String(inReplyToRaw) : "";
    if (!commentId) return null;

    if (inReplyTo) {
      const eventId = deliveryEventId(
        deliveryId,
        `comment-${repo}-${prNumber}-${commentId}`,
      );
      const translated: ForgeEvent = {
        kind: "reply",
        eventId,
        repo,
        pr: prNumber,
        authorLogin,
        inReplyTo,
        commentId,
        text: body,
      };
      return ForgeEventSchema.parse(translated);
    }
    // Top-level comment: the only thing it can mean is the review-mention
    // command. The forge delivery id is the event identity, so a fresh
    // @review comment (a fresh delivery) is a fresh event and the same
    // delivery replayed stays one identity; the comment's own id rides as
    // metadata, which keeps per-comment history meaningful.
    if (!isReviewCommandComment(body)) return null;
    const eventId = deliveryEventId(
      deliveryId,
      `pr-${repo}-${prNumber}-review_requested-${commentId}`,
    );
    const translated: ForgeEvent = {
      kind: "review_requested",
      eventId,
      repo,
      pr: prNumber,
      requesterLogin: authorLogin,
      commentId,
      text: body,
    };
    return ForgeEventSchema.parse(translated);
  }

  return null;
}
