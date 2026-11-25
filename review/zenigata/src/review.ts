/**
 * The review pipeline: guards, a per-PR git worktree (kept past the run
 * for the retention sweep, PRJ-382), three prompts
 * (blind, context, humanize) through the SessionDriver, validation with
 * one corrective retry per JSON stage, head re-check, post, and the
 * failure/abort paths. runReview is exported pure enough to drive from
 * tests; startServer wires it into the intake.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { canonicalJson } from "./canonical.js";
import type { Ctx } from "./ctx.js";
import { TimedOutError } from "./errors.js";
import {
  addReviewWorktree,
  ensureCanonicalClone,
  fetchCanonicalClone,
  pruneCanonicalWorktrees,
  removeReviewWorktree,
  canonicalCloneDir,
} from "./canonical-clone.js";
import { redactSecrets } from "./redact.js";
import { withTimeout } from "./with-timeout.js";
import { operatorSpeech } from "./operator-speech.js";
import type {
  ForgeEvent,
  InlineComment,
  PostedReview,
  Verdict,
} from "./contracts/forge.js";
import {
  appendJournal,
  journalPath,
  capFailedDraft,
  DROPPED_COMMENT_TRUNCATION_MARKER,
  type DroppedComment,
  type FailedDraft,
  type PhaseTiming,
  type ReviewRecord,
  type VerdictReconciliation,
} from "./journal.js";
import {
  dropUnanchorable,
  extractJsonDetailed,
  outputHead,
  parseRefusalLine,
  parseRefusalMessage,
  parseDiffHunks,
  validateReview,
  type ValidatedReview,
} from "./review/validate.js";

const execFileAsync = promisify(execFile);

/** Bounds so a finally block and the reconciliation never await unbounded work. */
const CLEANUP_TIMEOUT_MS = 15_000;
const RECONCILE_TIMEOUT_MS = 30_000;

export interface RunSummary {
  outcome: ReviewRecord["outcome"];
  verdict?: Verdict;
  inlineComments: number;
  headSha?: string;
  phases: PhaseTiming[];
  failure?: { stage: string; message: string };
}

/** Guard failure: no session, no post, outcome skipped. */
class GuardSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardSkip";
  }
}

/** A deliberate abort: the head moved; no post, nothing journaled as posted. */
class AbortRun extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortRun";
  }
}

type ReviewRequestedEvent = Extract<ForgeEvent, { kind: "review_requested" }>;

// ---------------------------------------------------------------------------
// Git helpers — execFile with argv arrays only; repo-controlled strings are
// never passed through a shell.
// ---------------------------------------------------------------------------

async function git(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: opts.cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const err = error as { stderr?: string; message: string };
    const detail = err.stderr?.trim() ?? err.message;
    // The args carry the adapter's credentialed cloneUrl and git's stderr
    // echoes it; redact before truncating or the slice can cut a URL
    // mid-userinfo, where no pattern matches any more.
    throw new Error(
      redactSecrets(`git ${args.join(" ")} failed: ${detail}`).slice(0, 500),
    );
  }
}

const slugifyRepo = (repo: string): string => repo.replace(/\//g, "-");

/**
 * Worktree directory name for one review: the slug plus a hash of the raw
 * repo string. Slugging collapses "acme/widget" and a repo literally named
 * "acme-widget" to the same name; the hash keeps them on distinct paths.
 */
export function worktreeDirName(repo: string, pr: number): string {
  const hash = createHash("sha1").update(repo).digest("hex").slice(0, 8);
  return `${slugifyRepo(repo)}-${pr}-${hash}`;
}

/** Schemes a clone URL may use; anything else is refused. */
const CLONE_SCHEMES = new Set(["https", "http", "ssh", "git", "file"]);

// `file` stays on the list because the test fixtures clone from bare
// file:// URLs; the adapter contract composes credentials for https/ssh.

/**
 * Parse and allowlist the clone URL. `ext::` and other transports run
 * arbitrary local commands, so only the schemes above get through.
 */
function parseCloneUrl(cloneUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(cloneUrl);
  } catch {
    // The raw cloneUrl may itself be credentialed; redact before the
    // message reaches the journal record, the logs, and any error reply.
    throw new Error(
      redactSecrets(`cloneUrl ${cloneUrl} is not an absolute URL`),
    );
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (!CLONE_SCHEMES.has(scheme)) {
    throw new Error(`cloneUrl scheme ${parsed.protocol} is not allowed`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * The re-review trigger contract, carried by every posted review body.
 * The contract is structure, not model output: the drafting model can
 * promise follow-up it will never deliver, while the pipeline's post
 * site appends this line without asking the model. The forge review
 * re-request is the whole trigger surface — zenigata reviews when a
 * human asks — and the footer is the mechanism; the prompt rule below
 * is only guidance, and a wrong model mood cannot change what posts.
 */
export const REVIEW_TRIGGER_FOOTER =
  "Reviews fire on a forge review re-request. PR comments trigger nothing.";

/**
 * The posted body's note about the comments that never reached the
 * forge, whichever stage dropped them (review 333; PRJ-440 extended the
 * accounting to the humanize stage). The draft's summary was written
 * for a draft that carried them, so the note groups the drops by their
 * source — the context stage's anchor refusals, the kept comments the
 * humanize stage's reply omitted, and anything whose source names
 * neither stage — names each by its reason, and says
 * where the full text lives and how the journal caps it; without it a
 * rescued run
 * — especially one whose humanize attempts both failed, posting the
 * context draft's body verbatim — would describe evidence the forge
 * never received. Applied at the one site that builds a posted body, so
 * the body and the inline comments it posts with agree whatever the
 * humanize stage did to the prose. The verdict is never touched here.
 */
export function annotateDroppedComments(
  body: string,
  drops: DroppedComment[],
): string {
  if (drops.length === 0) {
    return body;
  }
  const groups: string[] = [];
  const context = drops.filter((d) => d.source === "context");
  if (context.length > 0) {
    groups.push(
      "The draft also raised comment(s) that could not anchor on this diff and are not posted inline:",
      ...context.map((d) => `- ${d.reason}`),
    );
  }
  const humanize = drops.filter((d) => d.source === "humanize");
  if (humanize.length > 0) {
    groups.push(
      "The humanize stage dropped comment(s) the context stage kept; they are not posted inline:",
      ...humanize.map((d) => `- ${d.reason}`),
    );
  }
  // The fallback group (PRJ-442, review 355 note 16448): a drop whose
  // source names neither recording stage — a shape a newer or older
  // build wrote — lands in neither group above and would ship its note
  // with no heading at all. It renders here instead.
  const unclassified = drops.filter(
    (d) => d.source !== "context" && d.source !== "humanize",
  );
  if (unclassified.length > 0) {
    groups.push(
      "Comment(s) an unrecognized stage dropped are not posted inline:",
      ...unclassified.map((d) => `- ${d.reason}`),
    );
  }
  return [
    body,
    "",
    ...groups,
    "The full text of each dropped comment is kept in the review run's record, truncated at the 64KiB journal cap if oversize.",
  ].join("\n");
}

/**
 * The humanize stage's shrink reconcile (PRJ-440), as its own function
 * so the kept-set invariant has a loud edge a test can reach: the
 * context stage's kept set is never unset when the post site runs — the
 * context stage throws rather than resolving without a draft, and the
 * capture throws rather than resolving without one either — but if that
 * invariant ever broke, the check here refuses to degrade into a silent
 * no-check pass and fails the run instead (PRJ-442, review 355 note
 * 16445).
 *
 * The identity is the comment's `path:line` anchor, with two limits the
 * trace confirmed (PRJ-442, review 355 note 16446):
 *
 * - The forge takes two kept comments on one anchor: the adapter's
 *   payload schema puts no uniqueness on `{path, line}` and Forgejo's
 *   review creation posts one inline comment per array entry. So this
 *   comparison sees anchors, not counts: if the kept set holds two
 *   comments on one anchor and the reply omits exactly one, the anchor
 *   is still present and that partial loss goes unrecorded. The check
 *   detects anchor-set shrinkage, not per-comment shrinkage; a
 *   count-based identity is the shape that would close it.
 * - The humanize prompt asks the reply to keep anchors intact, but
 *   validation checks the payload against the diff alone, so a reply
 *   may move a comment to a different anchoring line and still
 *   validate. Such a move reads here as the original anchor omitted —
 *   the record names the old line as dropped although the comment's
 *   text posted under the new one. Naming a loss that is at worst a
 *   moved anchor is the honest direction; matching a moved comment
 *   back to its kept original needs a body-level identity the
 *   humanize rewrite breaks, and stays open.
 */
export function humanizeShrinkDrops(
  kept: InlineComment[] | undefined,
  posted: InlineComment[],
): DroppedComment[] {
  if (kept === undefined) {
    throw new Error(
      "the context stage left no kept-comment set; the shrink check refuses to run as a silent no-check pass",
    );
  }
  const postedAnchors = new Set(posted.map((c) => `${c.path}:${c.line}`));
  return kept
    .filter((c) => !postedAnchors.has(`${c.path}:${c.line}`))
    .map((c) => ({
      source: "humanize" as const,
      path: c.path,
      line: c.line,
      reason: `comment on ${c.path} line ${c.line} anchored in the kept set, but the humanize stage's reply omitted it`,
      body: c.body,
    }));
}

/**
 * Sentence-opening stems of trigger-footer statements. A payload can
 * carry one already — a redelivery, or a draft quoting or rewording the
 * register rule the prompt names — so every footer-bearing line strips
 * before the append. Recognition is by stem: a line keeping the opening
 * words with a reworded tail is a footer statement too. The first stem
 * matches the summon-command footer past posted reviews carry (the
 * command is gone); the second matches the one previous-generation
 * footer; the third matches the shipped footer.
 */
const TRIGGER_FOOTER_STEMS = [
  "A fresh `@zenigata @review` comment",
  "Re-reviews fire",
  "Reviews fire on a forge",
] as const;

/**
 * Append the trigger footer to a freshly-posted review body, exactly
 * once. Stripping footer-bearing lines before appending is what keeps
 * a paraphrased footer from posting twice beside the canonical one;
 * the stripped statement's splice seam (one adjacent blank line) goes
 * with it.
 */
export function withReviewTriggerFooter(body: string): string {
  const lines = body.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line: string | undefined = lines[i];
    if (
      line !== undefined &&
      TRIGGER_FOOTER_STEMS.some((stem) => line.startsWith(stem))
    ) {
      // One blank line after a stripped statement is the insertion's
      // own seam, not the draft's spacing; drop it too.
      if (lines[i + 1] === "") i += 1;
      continue;
    }
    kept.push(line ?? "");
  }
  return `${kept.join("\n").trimEnd()}\n\n${REVIEW_TRIGGER_FOOTER}`;
}

const CONVENTIONAL_COMMENTS_RULES = `
Inline comment rules (every inline comment body, no exceptions):
- The body starts with the exact line "Agent-generated:", then a blank line,
  then a first line in Conventional Comments format:
  <label> (<scope>): <text>
  Allowed labels: issue, suggestion, question, nitpick, todo, chore, note,
  thought. The only scopes are (blocking) and (non-blocking). The "praise"
  label is forbidden.
- "path" must be a file that appears in the diff; "line" must fall inside
  that file's changed line ranges on the new side of the diff.
- Consistency: if any comment is (blocking), the verdict must be
  "REQUEST_CHANGES"; if none is, the verdict must be "APPROVE".
`;

/**
 * Authoring register for every drafting pass: review prose never commits
 * the reviewer to future behavior. Reviews fire on forge triggers only,
 * so a promise in the prose would state a mechanism that does not exist;
 * the posted footer is the only statement of future re-review behavior.
 */
const NO_FUTURE_PROMISES_RULE = `
Never promise future reviews or future follow-through. Do not write
"the next push gets the same treatment", "it always does", "I'll keep
watching", or any sentence committing the reviewer to future behavior:
a review runs only when the forge triggers it, so such promises are
false. Ask the author for follow-up instead ("re-run the suite after
that fix"), and state future re-review behavior only as the posted
footer states it, quotable verbatim: "${REVIEW_TRIGGER_FOOTER}"`;

function blindPrompt(input: {
  persona: string;
  repo: string;
  pr: number;
  headRef: string;
  baseRef: string;
  headSha: string;
  diff: string;
  /** The deployment's humans list, for the operator-speech rule (PRJ-514). */
  humans: string[];
}): string {
  return `${input.persona}${operatorSpeech(input.humans)}

You are running the blind first pass of a pull-request review. Judge the
change on its own merits, against its base branch. You sit in the review
worktree: read the code around the diff, and run a command when a finding
needs the evidence. You have not seen the pull-request title, body, or
discussion; do not fetch or speculate about them. The pull request's own
commit messages and refs are withheld from this pass too: judge the code,
not the author's claims about it.

Repository: ${input.repo}, PR ${input.pr}, head ${input.headRef} @ ${input.headSha}, base ${input.baseRef}.

Produce raw findings only. One finding per line, each naming the file, the
new-side line, and the concrete problem. No verdict, no summary, no JSON,
no pleasantries.

Unified diff:

\`\`\`diff
${input.diff}
\`\`\``;
}

function contextPrompt(input: {
  persona: string;
  repo: string;
  pr: number;
  title: string;
  body: string;
  recalls: Array<{ content: string; source: string }>;
  blindFindings: string;
  diff: string;
}): string {
  const recalled =
    input.recalls.length === 0
      ? "(no stored corrections)"
      : input.recalls.map((r) => `- [${r.source}] ${r.content}`).join("\n");
  return `${input.persona}

Second pass: reconcile your blind-pass findings with the full context and
draft the final review.

Pull request ${input.repo}#${input.pr}:
Title: ${input.title}
Body:
${input.body}

Corrections previously stored for this repository:
${recalled}

Your blind-pass findings:
${input.blindFindings}

Unified diff:

\`\`\`diff
${input.diff}
\`\`\`
${CONVENTIONAL_COMMENTS_RULES}${NO_FUTURE_PROMISES_RULE}
Reply with ONLY a JSON object:

{
  "verdict": "APPROVE" or "REQUEST_CHANGES",
  "body": "<the review summary body>",
  "comments": [
    { "path": "<file path from the diff>", "line": <new-side line number>, "body": "<inline comment body>" }
  ]
}

No prose before or after the JSON object; a fenced \`\`\`json block is
tolerated, nothing else.`;
}

function correctiveRetryPrompt(input: {
  errors: string[];
  shapeReminder: string;
  /**
   * The diff's anchoring targets: per new-side path, the changed-line
   * windows a comment's "line" must fall inside. Carried on the retry so
   * a model failure on membership can correct against the real hunks.
   */
  diffTargets: Array<{ path: string; windows: string }>;
  /**
   * The head of the rejected output; present only when the attempt died
   * at the JSON parse step, so the model sees the text it actually sent
   * (PRJ-381).
   */
  rejectedHead?: string;
}): string {
  const head =
    input.rejectedHead === undefined
      ? ""
      : `\n\nThe rejected reply's first bytes as received:\n\n${input.rejectedHead}\n`;
  return `Your previous reply failed validation:

${input.errors.map((e) => `- ${e}`).join("\n")}${head}

Every comment anchors on the diff. Per new-side path, the changed line
windows (a comment's "line" must fall inside one):

${input.diffTargets.map((t) => `- ${t.path}: ${t.windows}`).join("\n")}

Reply again with ONLY the corrected JSON object. Same shape and rules as
before, nothing else:

${input.shapeReminder}`;
}

/**
 * The remediation order every JSON stage shares (PRJ-381): parse in
 * hand; on refusal the local transposition repair already ran inside
 * extractJsonDetailed; a still-refusing reply goes back through the
 * corrective retry with the real parse error and the rejected output's
 * head; only both attempts failing together aborts. Success at attempt
 * 0 — a repaired reply included — leaves the stage with zero additional
 * model traffic.
 */
const REVIEW_SHAPE_REMINDER = `{
  "verdict": "APPROVE" or "REQUEST_CHANGES",
  "body": "...",
  "comments": [ { "path": "...", "line": 1, "body": "Agent-generated:\\n\\n<label> (<scope>): ..." } ]
}`;

function humanizePrompt(input: {
  persona: string;
  payload: ValidatedReview;
}): string {
  return `${input.persona}

Humanize the review payload below. Keep the facts, the verdict, the
anchors (path and line), and the Conventional Comments headers intact;
rework only the prose so it reads like a person wrote it.

${JSON.stringify(input.payload, null, 2)}
${NO_FUTURE_PROMISES_RULE}

Reply with ONLY a JSON object:

{ "payload": <the same review shape, humanized>, "assessment": "<one line describing what you changed>" }

The payload must pass the same validation rules as the input
(${CONVENTIONAL_COMMENTS_RULES.trim()}).`;
}

// ---------------------------------------------------------------------------
// Reply-shape validation (used by the humanize stage)
// ---------------------------------------------------------------------------

function validateHumanizerOutput(
  value: unknown,
  diff: string,
):
  | { ok: true; payload: ValidatedReview; assessment: string }
  | { ok: false; errors: string[] } {
  const parsed = zHumanizer.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "output"}: ${issue.message}`,
      ),
    };
  }
  const review = validateReview(parsed.data.payload, diff);
  if (!review.ok) {
    return { ok: false, errors: review.errors };
  }
  return {
    ok: true,
    payload: review.value,
    assessment: parsed.data.assessment,
  };
}

const zHumanizer = z.object({
  payload: z.unknown(),
  assessment: z.string().min(1),
});

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

interface RunState {
  phases: PhaseTiming[];
  sessionId?: string;
  worktreeDir?: string;
  verdict?: Verdict;
  inlineComments: number;
  humanizer: { assessment?: string; changed: boolean };
  outcome: ReviewRecord["outcome"];
  failure?: { stage: string; message: string };
  headSha?: string;
  /** Posted payload (posted outcome only), kept for the journal index. */
  body?: string;
  comments?: InlineComment[];
  posted?: PostedReview;
  /** The posted outcome came from the reconciliation, not this run's post. */
  reconciled?: boolean;
  /** PRJ-381: raw replies of failed validation attempts, journaled. */
  failedDrafts: FailedDraft[];
  /**
   * PRJ-428: the comments that could not anchor and never reached the
   * forge — on a posted run the review carried the kept comments, on a
   * failed run the record names what the rescue would have dropped —
   * and the verdict move the drops would have forced, recorded as what
   * almost happened and never applied.
   */
  droppedComments?: DroppedComment[];
  verdictReconciled?: VerdictReconciliation;
  /**
   * PRJ-440: the context stage's kept half of the anchor partition —
   * the comment set the humanize stage receives, whether the plain
   * validation or the drop rescue produced it. The post site compares
   * the payload's comment set against it, so a humanize-stage shrink is
   * recorded and annotated instead of posting without a record of the
   * loss.
   */
  keptComments?: InlineComment[];
}

// The pipeline's trigger lives on the contract: runReview takes a forge
// review re-request, the whole trigger surface.
export async function runReview(
  ctx: Ctx,
  event: ReviewRequestedEvent,
): Promise<RunSummary> {
  const { config, forge, sessions, memory, logger, clock, metrics, persona } =
    ctx;
  const state: RunState = {
    phases: [],
    inlineComments: 0,
    humanizer: { changed: false },
    outcome: "failed",
    failedDrafts: [],
  };
  let currentStage = "intake";

  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const started = clock.now();
    currentStage = name;
    ctx.tracker.markStage(event.eventId, name);
    try {
      return await fn();
    } finally {
      const durationMs = clock.now() - started;
      state.phases.push({ phase: name, durationMs });
      // A cancelled run already settled elsewhere: the abandoned body's
      // phase durations would distort the histogram, so only the journal
      // record keeps them (via the phases push above).
      if (!cancelled) {
        metrics.observe(
          "zenigata_review_phase_seconds",
          { phase: name },
          durationMs / 1000,
        );
      }
    }
  };

  const startedAt = clock.now();
  const deadline = startedAt + config.reviewTimeoutSeconds * 1000;
  let timer: NodeJS.Timeout | undefined;
  // Set the moment the deadline fires. The race abandons the body but
  // does not stop it, so every stage after intake checks this flag at its
  // entry: a timed-out run creates no clone, no session, and no prompt.
  // The post stage checks it again immediately before the post. A failed
  // or timed-out run posts nothing to the PR — the journal is the
  // failure surface, and only a completed review posts — but the abort
  // cuts the client's postReview fetch while an adapter that already
  // received the request may still complete it: the run reconciles what
  // actually landed (see the failure path below) and the adapter is the
  // backstop: it SHOULD dedupe posts on (repo, pr, expectedHeadSha). See
  // docs/forge-adapter.md.
  let cancelled = false;
  /** True from the moment the post stage is entered, cancelled or not. */
  let postAttempted = false;
  const controller = new AbortController();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        cancelled = true;
        controller.abort();
        reject(new TimedOutError(currentStage));
      },
      Math.max(1, deadline - clock.now()),
    );
  });

  /**
   * Ask the adapter what actually landed for this (repo, pr, head). The
   * failure path runs it once the post stage was entered: an adapter that
   * received the request may complete it after the client gave up, and
   * the run must journal the review that landed rather than contradict
   * it. Bounded twice — the signal aborts the fetch at 30s and the race
   * gives up at 30s — so a hung adapter cannot wedge the run. A lookup
   * that fails or finds nothing returns false and the run journals the
   * failure as-is (the PR receives nothing from a failed run).
   */
  const reconcilePostedReview = async (): Promise<boolean> => {
    try {
      const found = await withTimeout(
        forge.getPostedReview(event.repo, event.pr, state.headSha ?? "", {
          signal: AbortSignal.timeout(RECONCILE_TIMEOUT_MS),
        }),
        RECONCILE_TIMEOUT_MS,
      );
      if (found === null) {
        return false;
      }
      state.posted = {
        reviewCommentId: found.reviewCommentId,
        commentRefs: found.commentRefs,
      };
      state.body = found.body;
      state.comments = found.comments;
      state.verdict = found.verdict;
      state.inlineComments = found.comments.length;
      state.outcome = "posted";
      state.failure = undefined;
      state.reconciled = true;
      logger.info(
        `reconciled ${event.repo}#${event.pr}: a review from the abandoned post already landed; the run journals it`,
      );
      return true;
    } catch (error) {
      logger.error(
        `reconciling the post for ${event.repo}#${event.pr} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  };

  const body = async (): Promise<void> => {
    // Guards.
    const shape = await stage("intake", async () => {
      if (
        !config.allowedLogins.some(
          (login) => login.toLowerCase() === event.requesterLogin.toLowerCase(),
        )
      ) {
        throw new GuardSkip(
          `requester ${event.requesterLogin} is not in the allowed logins`,
        );
      }
      const fetched = await forge.getPullRequest(event.repo, event.pr);
      if (fetched.isFork) {
        throw new GuardSkip(`PR ${event.repo}#${event.pr} is from a fork`);
      }
      if (
        config.allowedRepos.length > 0 &&
        !config.allowedRepos.includes(event.repo)
      ) {
        throw new GuardSkip(
          `repository ${event.repo} is not in the allowed repos`,
        );
      }
      state.headSha = fetched.headSha;
      return fetched;
    });

    // Git stage: ensure the persistent canonical clone, fetch the requested
    // refs into it, and build a disposable per-PR worktree at the head SHA.
    // Every ref-controlled value is validated before git runs: the argv must
    // never gain an option.
    const { dir, diff } = await stage("git", async () => {
      if (cancelled) {
        throw new Error("run cancelled");
      }
      if (shape.headRef.startsWith("-") || shape.baseRef.startsWith("-")) {
        throw new Error(
          `ref name looks like a git option (head ${shape.headRef}, base ${shape.baseRef})`,
        );
      }
      if (!/^[0-9a-fA-F]{40}$/.test(shape.headSha)) {
        throw new Error(`head SHA ${shape.headSha} is not a 40-hex commit id`);
      }
      // Validation only: the URL itself reaches git, not this parsed value.
      parseCloneUrl(shape.cloneUrl);
      const prDiff = await forge.getDiff(event.repo, event.pr);
      const worktreeDir = `${config.worktreesDir}/${worktreeDirName(event.repo, event.pr)}`;
      state.worktreeDir = worktreeDir;
      await mkdir(config.worktreesDir, { recursive: true });
      await rm(worktreeDir, { recursive: true, force: true });
      const cloneDir = await ensureCanonicalClone({
        stateDir: config.stateDir,
        repo: event.repo,
        cloneUrl: shape.cloneUrl,
      });
      // The "--" ends option parsing: a ref name can never become an
      // option again. Fetch with the credentialed URL so the canonical clone
      // stays current without relying on a persisted remote URL.
      await fetchCanonicalClone({
        dir: cloneDir,
        cloneUrl: shape.cloneUrl,
        refs: [shape.headRef, shape.baseRef],
      });
      // A registration for this path can survive the rm above: a run
      // that died between add and cleanup, a failed install, or a manual
      // state-dir tidy leaves the clone holding an entry whose directory
      // is gone, and `worktree add` then refuses the path. Prune first so
      // the stale case needs no recovery attempt; if the add still fails,
      // deregister through the cleanup helper and retry the add exactly
      // once. A failure after that surfaces as any stage failure does.
      await pruneCanonicalWorktrees({ canonicalCloneDir: cloneDir });
      try {
        await addReviewWorktree({
          canonicalCloneDir: cloneDir,
          worktreeDir,
          sha: shape.headSha,
        });
      } catch (error) {
        logger.info(
          `the review worktree add for ${event.repo}#${event.pr} failed; deregistering and retrying once: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await removeReviewWorktree({
          worktreesDir: config.worktreesDir,
          worktreeDir,
          canonicalCloneDir: cloneDir,
        });
        await addReviewWorktree({
          canonicalCloneDir: cloneDir,
          worktreeDir,
          sha: shape.headSha,
        });
      }
      const checkedOut = (
        await git(["rev-parse", "HEAD"], { cwd: worktreeDir })
      ).trim();
      if (checkedOut !== shape.headSha) {
        throw new Error(
          `checked-out SHA ${checkedOut} does not match requested ${shape.headSha}`,
        );
      }
      return { dir: worktreeDir, diff: prDiff };
    });

    /** The diff's anchoring targets: new-side paths and their hunk windows. */
    const diffTargets = [...parseDiffHunks(diff).values()]
      .filter((f) => f.ranges.length > 0)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => ({
        path: f.path,
        windows: f.ranges
          .map(([start, end]) =>
            start === end ? `${start}` : `${start}-${end}`,
          )
          .join(", "),
      }));

    // Blind pass.
    let blindFindings: string | undefined;
    await stage("blind", async () => {
      if (cancelled) {
        throw new Error("run cancelled");
      }
      state.sessionId = await sessions.createSession(dir, config.agent, {
        signal: controller.signal,
      });
      await sessions.prompt(
        state.sessionId,
        blindPrompt({
          persona,
          repo: event.repo,
          pr: event.pr,
          headRef: shape.headRef,
          baseRef: shape.baseRef,
          headSha: shape.headSha,
          diff,
          humans: config.humans,
        }),
        { signal: controller.signal },
      );
      blindFindings = await sessions.readOutput(state.sessionId, {
        signal: controller.signal,
      });
    });

    // Context pass: recall, reconcile, draft JSON; one corrective retry.
    let draft: ValidatedReview | undefined;
    await stage("context", async () => {
      if (cancelled) {
        throw new Error("run cancelled");
      }
      if (state.sessionId === undefined) {
        throw new Error("session was not created");
      }
      // Recall is advisory: stored corrections improve the draft, and a
      // memory outage must not fail the review. Scope by cwd (the review's
      // worktree checkout) so read and write resolve the same workspace
      // through the daemon's resolver.
      const recalls = await memory
        .recall("review corrections", { cwd: dir })
        .catch((error: unknown) => {
          logger.error(
            `memory recall failed, continuing without stored corrections: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return [];
        });
      const base = contextPrompt({
        persona,
        repo: event.repo,
        pr: event.pr,
        title: shape.title,
        body: shape.body,
        recalls,
        blindFindings: blindFindings ?? "",
        diff,
      });
      let errors: string[] = [];
      let rejectedHead: string | undefined;
      for (let attempt = 0; ; attempt++) {
        const prompt =
          attempt === 0
            ? base
            : correctiveRetryPrompt({
                errors,
                shapeReminder: REVIEW_SHAPE_REMINDER,
                diffTargets,
                rejectedHead,
              });
        await sessions.prompt(state.sessionId, prompt, {
          signal: controller.signal,
        });
        const output = await sessions.readOutput(state.sessionId, {
          signal: controller.signal,
        });
        // PRJ-381: the extract step carries the real parse refusal (and
        // has already run the local transposition repair); a refusal
        // here is never the zod "received undefined" ghost.
        const extraction = extractJsonDetailed(output);
        if (!extraction.ok) {
          state.failedDrafts.push({
            stage: "context",
            attempt,
            reply: capFailedDraft(output),
            parseError: parseRefusalMessage(extraction),
          });
          errors = [parseRefusalLine(extraction)];
          rejectedHead = outputHead(output);
          if (attempt >= 1) {
            throw new Error(
              `context draft failed validation twice: ${errors.join("; ")}`,
            );
          }
          continue;
        }
        const result = validateReview(extraction.value, diff);
        if (result.ok) {
          draft = result.value;
          return;
        }
        state.failedDrafts.push({
          stage: "context",
          attempt,
          reply: capFailedDraft(output),
        });
        errors = result.errors;
        if (attempt >= 1) {
          // PRJ-428: after the corrective retry, a comment that still
          // cannot anchor drops from the draft rather than killing the
          // run; the review posts with the comments that anchored, under
          // the draft's own verdict. Anything the rescue cannot reduce
          // into an honest, consistent, non-empty draft (a format
          // failure, a verdict inconsistency, a verdict the drops would
          // have to mint, every comment dropping) fails the stage as it
          // always did.
          const rescued = dropUnanchorable(extraction.value, diff);
          if (rescued.ok) {
            draft = rescued.value;
            state.droppedComments = rescued.drops;
            logger.info(
              `context draft for ${event.repo}#${event.pr}: dropped ${rescued.drops.length} unanchorable comment(s); posting the ${rescued.value.comments.length} that anchored under the draft's own verdict`,
            );
            return;
          }
          // The rescue refused: carry its honest accounting into the
          // record and fail through the existing path. A verdict move
          // the drops would have forced is named here as what almost
          // happened; the forge never sees a verdict the draft did not
          // issue.
          if (rescued.drops !== undefined && rescued.drops.length > 0) {
            state.droppedComments = rescued.drops;
          }
          if (rescued.verdictReconciled !== undefined) {
            state.verdictReconciled = rescued.verdictReconciled;
            logger.info(
              `context draft for ${event.repo}#${event.pr}: the drops would have forced the verdict from ${rescued.verdictReconciled.from} to ${rescued.verdictReconciled.to} (${rescued.verdictReconciled.because}); refusing to post a verdict the draft did not issue`,
            );
          }
          // The refusal's own reasons join the failure message: why the
          // run failed is the rescue's refusal, not just the anchor.
          const rescueErrors = rescued.errors.filter(
            (e) => !errors.includes(e),
          );
          throw new Error(
            `context draft failed validation twice: ${[...errors, ...rescueErrors].join("; ")}`,
          );
        }
      }
    });

    // The context stage's kept comments, whatever produced them: the
    // humanize stage receives exactly this set, and the post site
    // compares the payload against it (PRJ-440). The stage resolves only
    // with a draft in hand — it throws instead when none validated — so
    // the capture assigns without hedging; if that invariant ever broke,
    // this throws the same way the stage does rather than resolving the
    // kept set to nothing and letting the post site's shrink check
    // silently switch off (PRJ-442, review 355 note 16445).
    if (draft === undefined) {
      throw new Error("context draft was not produced");
    }
    state.keptComments = draft.comments;

    // Humanize pass: rewrite prose, keep the payload valid; one retry,
    // then post the pre-humanizer payload unhumanized.
    await stage("humanize", async () => {
      if (cancelled) {
        throw new Error("run cancelled");
      }
      if (state.sessionId === undefined || draft === undefined) {
        throw new Error("context draft was not produced");
      }
      const base = humanizePrompt({ persona, payload: draft });
      let errors: string[] = [];
      let rejectedHead: string | undefined;
      for (let attempt = 0; ; attempt++) {
        const prompt =
          attempt === 0
            ? base
            : correctiveRetryPrompt({
                errors,
                shapeReminder: REVIEW_SHAPE_REMINDER,
                diffTargets,
                rejectedHead,
              });
        await sessions.prompt(state.sessionId, prompt, {
          signal: controller.signal,
        });
        const output = await sessions.readOutput(state.sessionId, {
          signal: controller.signal,
        });
        const extraction = extractJsonDetailed(output);
        if (!extraction.ok) {
          state.failedDrafts.push({
            stage: "humanize",
            attempt,
            reply: capFailedDraft(output),
            parseError: parseRefusalMessage(extraction),
          });
          errors = [parseRefusalLine(extraction)];
          rejectedHead = outputHead(output);
          if (attempt >= 1) {
            state.humanizer.assessment =
              "humanizer failed validation; posted unhumanized";
            state.humanizer.changed = false;
            return;
          }
          continue;
        }
        const result = validateHumanizerOutput(extraction.value, diff);
        if (result.ok) {
          // Key order is not a rewrite: compare canonically so a
          // humanizer that only reordered object keys reads as unchanged.
          state.humanizer.changed =
            canonicalJson(draft) !== canonicalJson(result.payload);
          state.humanizer.assessment = result.assessment;
          draft = result.payload;
          return;
        }
        state.failedDrafts.push({
          stage: "humanize",
          attempt,
          reply: capFailedDraft(output),
        });
        errors = result.errors;
        if (attempt >= 1) {
          state.humanizer.assessment =
            "humanizer failed validation; posted unhumanized";
          state.humanizer.changed = false;
          return;
        }
      }
    });

    // Head re-check and post. A timed-out run takes no review action:
    // the flag is checked at entry (before the head re-check) and again
    // immediately before the post. A failed run posts nothing; see the
    // comment on `cancelled`.
    await stage("post", async () => {
      postAttempted = true;
      if (cancelled) {
        throw new Error("run timed out; refusing the head re-check and post");
      }
      const fresh = await forge.getPullRequest(event.repo, event.pr, {
        signal: controller.signal,
      });
      if (fresh.headSha !== state.headSha) {
        throw new AbortRun(
          `head moved during the review: ${state.headSha} -> ${fresh.headSha}`,
        );
      }
      if (draft === undefined) {
        throw new Error("context draft was not produced");
      }
      if (cancelled) {
        throw new Error("run timed out; refusing the post");
      }
      // PRJ-440: the humanize stage's shrink reconcile, at the one site
      // that builds a posted body. validateHumanizerOutput checks the
      // payload against the diff alone, so a reply that dropped comments
      // — each one anchoring, each well-formed — validates and would
      // post with no record of the loss. The payload's comment set goes
      // against the context stage's kept set: every kept anchor the
      // reply omitted rides the same honest accounting a context drop
      // does, and the body carries the annotation, so the body and the
      // inline comments it travels with agree whatever the stage did.
      // The comparison is shrink-only by direction: a reply that invents
      // a comment — an anchor the kept set never carried — posts
      // unrecorded here; an additions check is the named follow-up, not
      // part of this guard (PRJ-442, review 355 note 16447).
      // A humanize shrink never touches the verdict: an internally
      // inconsistent reply already refused validation and the run fell
      // back to the pre-humanizer draft.
      const humanizeDrops = humanizeShrinkDrops(
        state.keptComments,
        draft.comments,
      );
      if (humanizeDrops.length > 0) {
        state.droppedComments = [
          ...(state.droppedComments ?? []),
          ...humanizeDrops,
        ];
        logger.info(
          `humanize stage for ${event.repo}#${event.pr}: the reply omitted ${humanizeDrops.length} comment(s) the context stage kept; posting with the loss named in the body`,
        );
      }
      // The one site that constructs a posted body. The reconciliation
      // takes the body that already landed rather than appending again,
      // and withReviewTriggerFooter strips footer-bearing lines before
      // appending, so an echoed or reworded footer cannot double.
      const postedBody = withReviewTriggerFooter(
        annotateDroppedComments(draft.body, state.droppedComments ?? []),
      );
      try {
        state.posted = await forge.postReview(
          {
            repo: event.repo,
            pr: event.pr,
            expectedHeadSha: state.headSha,
            verdict: draft.verdict,
            body: postedBody,
            comments: draft.comments,
          },
          // The run's deadline may fire mid-post; the signal aborts the
          // client's fetch. An adapter that already received the request
          // may still complete it — the reconciliation below finds what
          // landed in that case.
          { signal: controller.signal },
        );
      } catch (error) {
        // The adapter enforces the head too; treat a refusal as the same
        // abort after confirming the head really moved. A cancelled run
        // skips the re-fetch entirely — the deadline already decided the
        // outcome — and a failing re-fetch must not mask the original
        // post error: the journal record names the post, not the GET.
        if (cancelled) {
          throw error;
        }
        let after: Awaited<ReturnType<typeof forge.getPullRequest>>;
        try {
          after = await forge.getPullRequest(event.repo, event.pr, {
            signal: controller.signal,
          });
        } catch {
          throw error;
        }
        if (after.headSha !== state.headSha) {
          throw new AbortRun(
            `head moved before the post: ${state.headSha} -> ${after.headSha}`,
          );
        }
        throw error;
      }
      state.body = postedBody;
      state.comments = draft.comments;
      state.verdict = draft.verdict;
      state.inlineComments = draft.comments.length;
      state.outcome = "posted";
    });
  };

  try {
    // The race abandons the body on timeout, but the body keeps running.
    // Attach a no-op catch as a second handler so the abandoned body's
    // eventual rejection (the post stage's refusal, a late error) never
    // surfaces as an unhandled rejection and crashes the process; the
    // race below still sees the body's rejection while it is live, and
    // the surviving failure path has already journaled the run.
    const bodyPromise = body();
    bodyPromise.catch(() => {});
    try {
      await Promise.race([bodyPromise, timeout]);
    } catch (error) {
      if (error instanceof GuardSkip) {
        state.outcome = "skipped";
        logger.info(`skipped ${event.repo}#${event.pr}: ${error.message}`);
      } else if (error instanceof AbortRun) {
        state.outcome = "aborted";
        logger.info(`aborted ${event.repo}#${event.pr}: ${error.message}`);
      } else {
        const stageName =
          error instanceof TimedOutError ? error.stage : currentStage;
        const message = error instanceof Error ? error.message : String(error);
        state.outcome = "failed";
        state.failure = { stage: stageName, message };
        logger.error(
          `review failed for ${event.repo}#${event.pr} in ${stageName}: ${message}`,
        );
        // When the post stage was entered, an in-flight review may have
        // landed after the client gave up; reconcile first and journal
        // the review that landed instead of a failure. A failed run
        // posts nothing to the PR: the journal (with the stage and the
        // failure message) is the operator surface, and only a completed
        // review reaches the pull request.
        let reconciled = false;
        if (postAttempted && state.headSha !== undefined) {
          reconciled = await reconcilePostedReview();
        }
        if (!reconciled) {
          logger.info(
            `failed run for ${event.repo}#${event.pr} left unposted; the journal record is the record`,
          );
        }
      }
    }

    const record = reviewRecord(
      event,
      state,
      startedAt,
      config.retentionWindowSeconds > 0,
      clock.now(),
    );
    // The retry policy's run counter must see this run whether it settled
    // in this process or after a restart: the live index counts it here
    // (under the event's identity), and loadIndex counts it from the
    // journal at the next boot.
    ctx.index.recordRun({
      repo: event.repo,
      pr: event.pr,
      eventId: event.eventId,
      outcome: state.outcome,
    });
    // Keep the reply index current before the journal append: a reply may
    // target this review's comments moments after the forge post, and the
    // index must already know them. Everything here is settlement
    // bookkeeping: a failure (an index or journal write the disk refuses,
    // a metrics family typo) must settle the run, not crash the process.
    if (
      state.outcome === "posted" &&
      state.posted !== undefined &&
      state.comments !== undefined
    ) {
      try {
        ctx.index.addPosted({
          repo: event.repo,
          pr: event.pr,
          reviewId: record.reviewId,
          body: state.body ?? "",
          comments: state.comments,
          posted: state.posted,
        });
      } catch (error) {
        logger.error(
          `indexing the posted review failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    try {
      await appendJournal(journalPath(config.stateDir), record);
    } catch (error) {
      logger.error(
        `appending the review record failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // The projection row follows the journal line at the same lifecycle
    // point; the write logs and moves on when it fails.
    ctx.statusDb.apply(record, "the review record");
    try {
      metrics.inc("zenigata_reviews_total", {
        repo: event.repo,
        status: state.outcome,
      });
    } catch (error) {
      logger.error(
        `counting the review failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return {
      outcome: state.outcome,
      verdict: state.verdict,
      inlineComments: state.inlineComments,
      headSha: state.headSha,
      phases: state.phases,
      failure: state.failure,
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    // PRJ-382: with the retention window on, the run leaves its session
    // and worktree standing and hands them to the sweep through the
    // journal record (it carries their ids and the finished stamp), which
    // retires them once they are older than the window. At window 0,
    // today's immediate teardown applies: neither cleanup step may await
    // unbounded work, so each races a 15s timeout and logs-and-moves-on
    // when it fires. The abandoned promise's eventual rejection is
    // handled by the race above.
    if (config.retentionWindowSeconds === 0) {
      if (state.sessionId !== undefined) {
        try {
          await withTimeout(
            sessions.dispose(state.sessionId),
            CLEANUP_TIMEOUT_MS,
          );
        } catch (error) {
          logger.error(
            `disposing the review session failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (state.worktreeDir !== undefined) {
        try {
          await withTimeout(
            removeReviewWorktree({
              worktreesDir: config.worktreesDir,
              worktreeDir: state.worktreeDir,
              canonicalCloneDir: canonicalCloneDir(config.stateDir, event.repo),
            }),
            CLEANUP_TIMEOUT_MS,
          );
        } catch (error) {
          logger.error(
            `removing the worktree failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
}

function reviewRecord(
  event: ReviewRequestedEvent,
  state: RunState,
  startedAt: number,
  /** True when the retention window keeps the run's work past settle. */
  retain: boolean,
  finishedAtMs: number,
): ReviewRecord {
  const record: ReviewRecord = {
    ts: new Date(startedAt).toISOString(),
    type: "review",
    reviewId: randomUUID(),
    repo: event.repo,
    pr: event.pr,
    eventId: event.eventId,
    commentId: event.commentId,
    headSha: state.headSha,
    requester: event.requesterLogin,
    // A copy, not the live array: an abandoned body keeps pushing phase
    // timings after the record is built, and the recorded phases must
    // stay frozen at record time.
    phases: [...state.phases],
    verdict: state.verdict,
    inlineComments: state.inlineComments,
    humanizer: {
      assessment: state.humanizer.assessment,
      changed: state.humanizer.changed,
    },
    outcome: state.outcome,
    failure: state.failure,
    reconciled: state.reconciled,
    body: state.body,
    comments: state.comments,
    posted: state.posted,
  };
  if (retain) {
    // PRJ-382: the retained work is the sweep's input, the stamp is its
    // clock compare. A run that never created a session or worktree
    // (a guard skip, a failure before the git stage) leaves its fields
    // unset; JSON drops them and the record never becomes a candidate.
    record.sessionId = state.sessionId;
    record.worktreeDir = state.worktreeDir;
    record.finishedAt = new Date(finishedAtMs).toISOString();
  }
  if (state.failedDrafts.length > 0) {
    // PRJ-381: the raw failing drafts ride the record; JSON drops the
    // field entirely when every attempt validated.
    record.failedDrafts = state.failedDrafts;
  }
  if (state.droppedComments !== undefined && state.droppedComments.length > 0) {
    // PRJ-428: the comments that never reached the forge, whatever the
    // run's outcome — the context stage's anchor refusals and, since
    // PRJ-440, the kept comments the humanize stage's reply omitted.
    // The body caps with the failed drafts' mechanics: on a failed run
    // the same text already rides the record inside the capped
    // failedDrafts, and an uncapped copy would double it. The marker is
    // the drop's own (PRJ-439) — a dropped comment is not a draft
    // attempt, and the failed drafts' marker stays byte-stable for the
    // status db's stored-row reads.
    record.droppedComments = state.droppedComments.map((d) => ({
      ...d,
      body: capFailedDraft(d.body, DROPPED_COMMENT_TRUNCATION_MARKER),
    }));
  }
  if (state.verdictReconciled !== undefined) {
    // PRJ-428: the verdict move the drops would have forced, recorded
    // as what almost happened; never applied to a posted payload.
    record.verdictReconciled = state.verdictReconciled;
  }
  return record;
}

/**
 * Settle a review event that never ran: journal a `skipped` record and
 * count it. Used when the retry policy refuses a redelivered event; the
 * refusal is not a run, and its record must not count as one (the
 * index's run counter ignores skipped outcomes).
 */
export async function skipReview(
  ctx: Ctx,
  event: ReviewRequestedEvent,
  reason: string,
): Promise<{ outcome: ReviewRecord["outcome"] }> {
  const { config, logger, clock, metrics } = ctx;
  logger.info(`skipped review for ${event.repo}#${event.pr}: ${reason}`);
  const record: ReviewRecord = {
    ts: new Date(clock.now()).toISOString(),
    type: "review",
    reviewId: randomUUID(),
    repo: event.repo,
    pr: event.pr,
    eventId: event.eventId,
    commentId: event.commentId,
    requester: event.requesterLogin,
    phases: [],
    inlineComments: 0,
    humanizer: { changed: false },
    outcome: "skipped",
    failure: { stage: "intake", message: reason },
  };
  try {
    await appendJournal(journalPath(config.stateDir), record);
  } catch (error) {
    logger.error(
      `appending the skipped review record failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  ctx.statusDb.apply(record, "the skipped review record");
  try {
    metrics.inc("zenigata_reviews_total", {
      repo: event.repo,
      status: "skipped",
    });
  } catch (error) {
    logger.error(
      `counting the skipped review failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { outcome: "skipped" };
}
