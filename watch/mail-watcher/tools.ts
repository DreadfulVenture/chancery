// The family's tool surface (the ADR: one tool surface with a source
// discriminator; a source does not mint its own tools):
// watcher_register / watcher_list / watcher_forget over the kernel, and
// the projection's forge_state over the board. The schemas and the
// execute handlers are today's, moved verbatim from the entry.

import { readStamps } from "./kernel.ts";

// The register request's JSON schema, as the tool carries it.
const registerSchema = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: [
        "run",
        "pr",
        "branch",
        "pr-reviews",
        "slack-channel",
        "github-pr",
        "github-issue",
      ],
      description:
        "What is watched: run (one Actions run by id), pr (one PR index, followed to its close), branch (one branch name), pr-reviews (one PR's reviews — one wake per review that arrives after the watch, never the backlog, never an unsubmitted draft), slack-channel (one Slack channel's messages — one wake per message that arrives after the watch, content, sender, and timestamp in the wake; bot messages included, the channel's history at register is the spent backlog), github-pr (one GitHub pull request by number — one wake per new review, comment, or state change, ending at the PR's close), or github-issue (one GitHub issue by number — one wake per new comment or state change).",
    },
    repo: {
      type: "string",
      description:
        'The repository as owner/name, e.g. acme/widgets. For kind slack-channel: the literal "slack".',
    },
    ref: {
      type: "string",
      description:
        "For kind run: the Actions run id. For kind pr or pr-reviews: the PR index. For kind branch: the branch name. For kind slack-channel: the channel's id, e.g. C0123456789. For kind github-pr or github-issue: the pull request or issue number.",
    },
    note: {
      type: "string",
      description: "Optional free text carried on the watch and in its mail.",
    },
  },
  required: ["kind", "repo", "ref"],
  additionalProperties: false,
};

const forgetSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "The watch id from watcher_register." },
  },
  required: ["id"],
  additionalProperties: false,
};

const listSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const stateSchema = {
  type: "object",
  properties: {
    repo: {
      type: "string",
      description:
        "Optional repository as owner/name; omit it for every watched repo's board.",
    },
  },
  additionalProperties: false,
};
export const createTools = ({ ctx, kernel, debug, projectionDb }) => {
  const registerTool = {
    name: "watcher_register",
    description: `Watch a Forgejo run, PR, branch, or a PR's reviews and report into this session as chat mail. Watches ride this session's metadata, survive plugin reloads and host restarts, and live until watcher_forget — no expiry. A pr watch ends itself at the pull request's close: one terminal mail (merged, or closed unmerged) and the watch dissolves, no forget needed. A pr-reviews watch delivers one wake per new review on the pull request — every reviewer's, this session's own included; the reviews the PR already carries at register are the spent backlog, and an unsubmitted draft never wakes. A slack-channel watch delivers one wake per new message on the Slack channel — the message's content, sender, and timestamp in the wake; bot messages included, the subscriber filters, and the channel's history at register is the spent backlog. A github-pr or github-issue watch follows one GitHub pull request or issue: one wake per new review, comment, or state change — the reviews and comments it already carries at register are the spent backlog — and a github-pr watch ends itself at the PR's close with one terminal mail (merged, or closed unmerged). Re-registering the same pr or branch returns the existing claimed watch instead of a second owner; a github-pr watch claims the same way, a github-issue watch does not.`,
    input: registerSchema,
    execute: async (raw, context) => {
      const input = raw || {};
      const caller = context?.sessionID;
      if (!caller)
        throw new Error("watcher_register: tool context carried no session id");
      const parsed = await kernel.register(input, caller);
      if (parsed.outcome === "claimed") {
        return {
          content: JSON.stringify({
            ok: true,
            existing: true,
            id: parsed.id,
            claimedBy: parsed.claimedBy,
            delivery: `the watch is claimed: its verdict rides mail to ${parsed.claimedBy}`,
          }),
        };
      }
      if (parsed.outcome === "existing") {
        return {
          content: JSON.stringify({
            ok: true,
            existing: true,
            id: parsed.id,
            delivery: "already watching (this session owns the watch)",
          }),
        };
      }
      return {
        content: JSON.stringify({
          ok: true,
          existing: false,
          id: parsed.id,
          delivery: `watching ${parsed.kind} ${parsed.ref} on ${parsed.repo}; the verdict rides mail`,
        }),
      };
    },
  };

  const listTool = {
    name: "watcher_list",
    description:
      "List this session's Forgejo watches, with their delivered verdicts.",
    input: listSchema,
    execute: async (raw, context) => {
      const caller = context?.sessionID;
      if (!caller)
        throw new Error("watcher_list: tool context carried no session id");
      const rows = await readStamps(ctx, debug, caller);
      return {
        content: JSON.stringify({
          ok: true,
          watches: (rows ?? []).map((row) => ({
            id: row?.id,
            kind: row?.kind,
            repo: row?.repo,
            ref: row?.ref,
            note: row?.note ?? null,
            delivered: Object.keys(row?.delivered ?? {}),
          })),
        }),
      };
    },
  };

  const forgetTool = {
    name: "watcher_forget",
    description:
      "Forget a Forgejo watch registered by this session. A watch another session claimed is its owner's to forget.",
    input: forgetSchema,
    execute: async (raw, context) => {
      const input = raw || {};
      const caller = context?.sessionID;
      if (!caller)
        throw new Error("watcher_forget: tool context carried no session id");
      const id = String(input.id || "").trim();
      if (!id) throw new Error("watcher_forget: id is required");
      await kernel.forget(id, caller);
      return { content: JSON.stringify({ ok: true, id }) };
    },
  };

  // The projection's agent surface (PRJ-406): the whole board in one
  // call, rows exactly as the poll pass mapped them, staleness carried
  // by each row's syncedAt and said plainly in the description.
  const stateTool = {
    name: "forge_state",
    description:
      "The forgejo watcher's PR-state projection: for each watched repo, every open pull request, its reviews, and its head's CI statuses, as the last poll pass read them — the whole board in one call instead of a scour of forge reads. This is a mirror, not the forge: every row is exactly as stale as its syncedAt says, and a decision that needs point-truth takes a live forge read, not this projection.",
    input: stateSchema,
    execute: async (raw) => {
      let db;
      try {
        db = projectionDb();
      } catch (error) {
        return {
          content: JSON.stringify({
            ok: false,
            error: `the pr-state projection is unavailable: ${error?.message ?? error}`,
          }),
        };
      }
      const repo = String(raw?.repo ?? "").trim();
      return {
        content: JSON.stringify({
          ok: true,
          ...(repo ? { repo } : {}),
          ...db.board(repo || null),
        }),
      };
    },
  };
  return { registerTool, listTool, forgetTool, stateTool };
};
