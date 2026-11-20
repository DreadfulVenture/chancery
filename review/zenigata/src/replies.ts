/**
 * The reply flow: answer a question on the bot's own review or inline
 * comment, optionally store one durable observation through the memory
 * gateway. The verdict and every Conventional Comments label never move
 * under questioning; only a fresh @review changes a verdict.
 */

import type { Ctx } from "./ctx.js";
import type { ForgeEvent } from "./contracts/forge.js";
import type { ObservationSource } from "./contracts/memory.js";
import { z } from "zod";
import { TimedOutError } from "./errors.js";
import {
  appendJournal,
  journalPath,
  capFailedDraft,
  type FailedDraft,
  type ReplyRecord,
} from "./journal.js";
import { ensureCanonicalClone } from "./canonical-clone.js";
import {
  extractJsonDetailed,
  outputHead,
  parseRefusalLine,
  parseRefusalMessage,
} from "./review/validate.js";
import { withTimeout } from "./with-timeout.js";

/** Bounds so the deadline races and cleanup never await unbounded work. */
const MEMORY_WRITE_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 15_000;

/** The posted answer is capped; a model-side megabyte never lands on the PR. */
const ANSWER_LIMIT = 8000;
const ANSWER_TRUNCATION_MARKER = "[answer truncated]";

function capAnswer(text: string): string {
  if (text.length <= ANSWER_LIMIT) {
    return text;
  }
  return `${text.slice(0, ANSWER_LIMIT)}\n\n${ANSWER_TRUNCATION_MARKER}`;
}

type ReplyEvent = Extract<ForgeEvent, { kind: "reply" }>;

export interface ReplySummary {
  outcome: ReplyRecord["outcome"];
  learning?: ObservationSource;
}

const replyOutputSchema = z.object({
  answer: z.string().min(1),
  learning: z
    .object({
      source: z.enum(["fact", "insight", "decision", "task"]),
      content: z.string().min(1),
    })
    .optional(),
});

/**
 * Posted in the thread when the reply points at a comment the bot has no
 * record of. The trigger sentence names the shipped re-fire set exactly:
 * a fresh `@zenigata @review` comment re-runs the review, and so does
 * re-requesting the review from the forge — each forge delivery runs at
 * most once under the current retry policy.
 */
const NO_RECORD_REPLY = [
  "I have no record of the comment this reply points at; it may predate my records.",
  "",
  "A fresh `@zenigata @review` comment re-runs the review, and re-requesting my review from the forge runs it too; each forge delivery runs at most once.",
].join("\n");

/** Posted in the thread when the answer run itself fails. */
const FAILED_REPLY = [
  "The answer run failed; the question stands.",
  "",
  "Nothing about the review moved. Ask again and I will take another pass.",
].join("\n");

/** The reply text admitted into the prompt is capped; long pastes are cut. */
const REPLY_TEXT_LIMIT = 4000;
const TRUNCATION_MARKER = "[reply truncated]";

function capReplyText(text: string): string {
  if (text.length <= REPLY_TEXT_LIMIT) {
    return text;
  }
  return `${text.slice(0, REPLY_TEXT_LIMIT)}\n\n${TRUNCATION_MARKER}`;
}

function replyPrompt(input: {
  persona: string;
  repo: string;
  originalBody: string;
  authorReply: string;
}): string {
  return `${input.persona}

Someone replied to your review comment. Answer in thread.

Your original comment:

${input.originalBody}

Their reply:

${input.authorReply}

Write a threaded answer addressed to them. Two things do not move under
questioning: the verdict and every Conventional Comments label. You may
clarify, correct mechanics, concede a factual point, or stand your
ground, but a verdict changes only when a fresh @review runs against a
new head. Keep the answer under 8000 characters; longer ones are cut
with a "[answer truncated]" marker.

Reply with ONLY a JSON object:

{
  "answer": "<the threaded reply to post>",
  "learning": { "source": "fact" | "insight" | "decision" | "task", "content": "<one durable observation worth storing>" }
}

"learning" is optional; include it only when the exchange surfaced
something durable about this repository. State the observation plainly;
repo scoping is carried structurally by the memory write, not by a text
label. No prose before or after the JSON object; a fenced \`\`\`json block
is tolerated, nothing else.`;
}

/**
 * Settle a reply that never ran: journal a `skipped` record and count it.
 * Used for a reply to a repository outside allowedRepos and for a reply
 * that arrived past the reply semaphore's waiter cap.
 */
export async function skipReply(
  ctx: Ctx,
  event: ReplyEvent,
  reason: string,
): Promise<ReplySummary> {
  ctx.logger.info(`skipped reply on ${event.repo}#${event.pr}: ${reason}`);
  const record: ReplyRecord = {
    ts: new Date(ctx.clock.now()).toISOString(),
    type: "reply",
    repo: event.repo,
    pr: event.pr,
    author: event.authorLogin,
    inReplyTo: event.inReplyTo,
    outcome: "skipped",
  };
  try {
    await appendJournal(journalPath(ctx.config.stateDir), record);
  } catch (error) {
    ctx.logger.error(
      `appending the skipped reply record failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  ctx.statusDb.apply(record, "the skipped reply record");
  try {
    ctx.metrics.inc("zenigata_replies_total", { repo: event.repo });
  } catch (error) {
    ctx.logger.error(
      `counting the skipped reply failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { outcome: "skipped" };
}

export async function runReply(
  ctx: Ctx,
  event: ReplyEvent,
): Promise<ReplySummary> {
  const { config, forge, sessions, memory, logger, clock, metrics } = ctx;

  // Same repo guard the review flow applies at intake: a reply for a
  // repository the deployment does not serve never creates a session or
  // posts anything; it settles as a skipped record.
  if (
    config.allowedRepos.length > 0 &&
    !config.allowedRepos.includes(event.repo)
  ) {
    return skipReply(
      ctx,
      event,
      `repository ${event.repo} is not in the allowed repos`,
    );
  }

  let sessionId: string | undefined;
  let outcome: ReplyRecord["outcome"] = "failed";
  let learning: ObservationSource | undefined;
  let postedCommentId: string | undefined;
  let postedAnswer: string | undefined;

  // The index is scoped: a comment id only answers for the repo and PR it
  // was posted on. Anything else takes the no-record path instead of
  // quoting a foreign body.
  const found = ctx.index.lookup(event.inReplyTo);
  const posted =
    found !== undefined && found.repo === event.repo && found.pr === event.pr
      ? found
      : undefined;
  if (found !== undefined && posted === undefined) {
    logger.info(
      `reply ${event.inReplyTo} on ${event.repo}#${event.pr} points at a comment from another PR; treating it as unknown`,
    );
  }
  const hasRecord = posted !== undefined;

  // Observations are gated: only replies from the allowed logins teach
  // the bot anything.
  const authorAllowed = config.allowedLogins.some(
    (login) => login.toLowerCase() === event.authorLogin.toLowerCase(),
  );

  // Same timer + cancelled-flag shape as runReview: the race abandons the
  // answer run at the deadline and the flag gates the post. The deadline
  // also aborts the reply's controller, which cuts the session calls'
  // in-flight fetches the way the review's controller does. The reply
  // shares the review timeout; no separate knob exists for it.
  const startedAt = clock.now();
  const deadline = startedAt + config.reviewTimeoutSeconds * 1000;
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const controller = new AbortController();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        cancelled = true;
        controller.abort();
        reject(new TimedOutError("answer"));
      },
      Math.max(1, deadline - clock.now()),
    );
  });

  // The learning captured from the successful parse; written only after
  // the answer posts.
  let pendingLearning:
    | { source: ObservationSource; content: string }
    | undefined;
  // PRJ-381: the raw outputs of failed validation attempts, journaled
  // with the record for any outcome.
  let failedDrafts: FailedDraft[] = [];

  const answerRun = async (): Promise<string> => {
    if (!hasRecord) {
      return NO_RECORD_REPLY;
    }
    if (cancelled) {
      throw new Error("run cancelled");
    }
    sessionId = await sessions.createSession(config.stateDir, config.agent, {
      signal: controller.signal,
    });
    const base = replyPrompt({
      persona: ctx.persona,
      repo: event.repo,
      originalBody:
        posted.kind === "inline"
          ? `${posted.body}\n(file: ${posted.path}, line: ${posted.line})`
          : posted.body,
      authorReply: capReplyText(event.text),
    });
    // PRJ-381's remediation order, shared with the review pipeline's
    // JSON stages: parse in hand, the local transposition repair inside
    // extractJsonDetailed, one corrective retry with the real parse
    // error; only both attempts failing together fails the run.
    let errors: string[] = [];
    let rejectedHead: string | undefined;
    for (let attempt = 0; ; attempt++) {
      const prompt =
        attempt === 0
          ? base
          : [
              "Your previous reply failed validation:",
              ...errors.map((e) => `- ${e}`),
              // Present on the parse-refusal path: the model sees the
              // text it actually sent, not a ghost summary of it.
              ...(rejectedHead === undefined
                ? []
                : [
                    "",
                    "The rejected output's first bytes as received:",
                    "",
                    rejectedHead,
                  ]),
              "",
              "Reply again with ONLY the corrected JSON object:",
              `{ "answer": "...", "learning": { "source": "fact" | "insight" | "decision" | "task", "content": "..." } }`,
            ].join("\n");
      await sessions.prompt(sessionId, prompt, { signal: controller.signal });
      const output = await sessions.readOutput(sessionId, {
        signal: controller.signal,
      });
      if (cancelled) {
        // The deadline fired while the turn ran: the abandoned body may
        // not overwrite the shared pendingLearning.
        throw new Error("run cancelled");
      }
      const extraction = extractJsonDetailed(output);
      if (!extraction.ok) {
        failedDrafts.push({
          stage: "answer",
          attempt,
          reply: capFailedDraft(output),
          parseError: parseRefusalMessage(extraction),
        });
        errors = [parseRefusalLine(extraction)];
        rejectedHead = outputHead(output);
        if (attempt >= 1) {
          throw new Error(
            `reply output failed validation twice: ${errors.join("; ")}`,
          );
        }
        continue;
      }
      const parsed = replyOutputSchema.safeParse(extraction.value);
      if (parsed.success) {
        pendingLearning = parsed.data.learning;
        return parsed.data.answer;
      }
      failedDrafts.push({
        stage: "answer",
        attempt,
        reply: capFailedDraft(output),
      });
      errors = parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "output"}: ${issue.message}`,
      );
      if (attempt >= 1) {
        throw new Error(
          `reply output failed validation twice: ${errors.join("; ")}`,
        );
      }
    }
  };

  // Post the short failure reply in the thread — but only when the lookup
  // found one of our own comments to answer in; before any context exists
  // the run logs and journals only.
  const postFailureReply = async (): Promise<void> => {
    if (!hasRecord) {
      return;
    }
    try {
      await forge.postReply({
        repo: event.repo,
        pr: event.pr,
        inReplyTo: event.inReplyTo,
        body: FAILED_REPLY,
      });
    } catch (error) {
      logger.error(
        `posting the failure reply for ${event.repo}#${event.pr} also failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  try {
    const answerPromise = answerRun();
    // Second handler: if the race abandons the body at the deadline and it
    // rejects later, the rejection must never surface unhandled.
    answerPromise.catch(() => {});

    let answer: string | undefined;
    let failure: unknown;
    try {
      answer = await Promise.race([answerPromise, timeout]);
    } catch (error) {
      failure = error;
    }
    if (answer !== undefined && cancelled) {
      // The deadline fired the instant the answer landed; the post refuses.
      failure = new TimedOutError("answer");
      answer = undefined;
    }

    if (answer !== undefined) {
      postedAnswer = capAnswer(answer);
      try {
        const posted = await forge.postReply({
          repo: event.repo,
          pr: event.pr,
          inReplyTo: event.inReplyTo,
          body: postedAnswer,
        });
        outcome = "posted";
        postedCommentId = posted.commentId;
        // Index the bot's own answer so a second reply in the thread — a
        // reply to the bot's answer — resolves instead of taking the
        // no-record path. An index failure is settlement bookkeeping:
        // it must not fail the reply.
        try {
          ctx.index.addReply({
            repo: event.repo,
            pr: event.pr,
            commentId: posted.commentId,
            body: postedAnswer,
          });
        } catch (indexError) {
          logger.error(
            `indexing the posted reply failed: ${
              indexError instanceof Error
                ? indexError.message
                : String(indexError)
            }`,
          );
        }
      } catch (error) {
        outcome = "failed";
        logger.error(
          `posting the reply to ${event.repo}#${event.pr} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await postFailureReply();
      }
    } else {
      outcome = "failed";
      logger.error(
        `reply to ${event.repo}#${event.pr} failed: ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
      await postFailureReply();
    }

    // The observation stores only after the answer landed: a failed post
    // stores nothing, and only an allowed author teaches the bot.
    if (outcome === "posted" && pendingLearning !== undefined) {
      if (!authorAllowed) {
        logger.info(
          `dropping the learning from ${event.authorLogin}: not in the allowed logins`,
        );
      } else {
        learning = pendingLearning.source;
        try {
          // Repo-stamped writes need a real cwd the daemon can resolve to
          // this repository's project. Resolve it from a persistent
          // per-repo checkout under the bot's state dir (lazily cloned
          // from the forge-reported clone URL); never fabricate a path or
          // fall back to a text label.
          const shape = await forge.getPullRequest(event.repo, event.pr);
          const repoCwd = await ensureCanonicalClone({
            stateDir: config.stateDir,
            repo: event.repo,
            cloneUrl: shape.cloneUrl,
          });
          // The daemon call races a 30s bound: a hung write must give up
          // its semaphore slot, and the answer and journal are
          // unaffected either way.
          await withTimeout(
            memory.write(pendingLearning.source, pendingLearning.content, {
              cwd: repoCwd,
            }),
            MEMORY_WRITE_TIMEOUT_MS,
          );
          metrics.inc("zenigata_memory_observations_total", {
            source: pendingLearning.source,
          });
        } catch (error) {
          // A memory failure (or failure to resolve a repo cwd) must not
          // fail the reply.
          logger.error(
            `memory write failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          learning = undefined;
        }
      }
    }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    // PRJ-382: with the retention window on, the reply session survives
    // its answer and the record below hands it to the sweep, which
    // disposes it inside the window. At window 0, immediate teardown
    // applies: the dispose is bounded — a hung one must not wedge the
    // settled-event promise (and with it, future duplicate handling)
    // forever.
    if (config.retentionWindowSeconds === 0 && sessionId !== undefined) {
      try {
        await withTimeout(sessions.dispose(sessionId), CLEANUP_TIMEOUT_MS);
      } catch (error) {
        logger.error(
          `disposing the reply session failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const record: ReplyRecord = {
      ts: new Date(clock.now()).toISOString(),
      type: "reply",
      repo: event.repo,
      pr: event.pr,
      author: event.authorLogin,
      inReplyTo: event.inReplyTo,
      outcome,
      learning,
      postedCommentId,
      body: postedAnswer,
    };
    if (config.retentionWindowSeconds > 0) {
      // A run before the session was created (a disallowed repo, a
      // rejected replay) carries neither field; JSON drops them and the
      // record never becomes a sweep candidate.
      record.sessionId = sessionId;
      record.finishedAt = new Date(clock.now()).toISOString();
    }
    if (failedDrafts.length > 0) {
      // PRJ-381: the raw failing outputs ride the record; JSON drops the
      // field entirely when every attempt validated.
      record.failedDrafts = failedDrafts;
    }
    try {
      await appendJournal(journalPath(config.stateDir), record);
    } catch (error) {
      logger.error(
        `appending the reply record failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // The projection row follows the journal line; the write logs and
    // moves on when it fails, never throwing.
    ctx.statusDb.apply(record, "the reply record");
    // Settlement bookkeeping like the review path's counter: a metrics
    // failure settles the run, it does not crash the process.
    try {
      metrics.inc("zenigata_replies_total", { repo: event.repo });
    } catch (error) {
      logger.error(
        `counting the reply failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { outcome, learning };
}
