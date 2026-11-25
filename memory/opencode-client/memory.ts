import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The hook payloads and host surface the plugin reads, shaped by what
// each hook touches; the genuinely dynamic rows stay as any. The host's
// own types are not importable from here.
type MomentEvent = { kind: string; command?: unknown; tool?: string };

type SessionOpenData = {
  project?: string;
  doc_created_at?: string;
  inputs_count?: number;
  doc?: string;
  topk?: Array<{
    id?: string;
    timestamp?: string;
    veracity?: string;
    author_type?: string;
    content: string;
  }>;
};

type MomentDelivery = {
  section: string;
  created_at?: string;
  scope: string;
  project?: string;
  note: string;
  rule_id?: string | number;
};

// A capture-queue row: the payload enqueued for the daemon's drain. The
// daemon's own envelope fields ride through the index signature.
type CaptureRecord = {
  kind?: string;
  role?: string;
  conversation_id?: string;
  text?: string;
  [key: string]: unknown;
};

// The config getter loadConfig() returns: an indexed lookup with the
// raw settings object riding along for the optional keys.
type ConfigGetter = {
  (key: string, envVar: string): string;
  settings: Record<string, any>;
};

interface HostSession {
  get(input: { sessionID: string }): Promise<any>;
  hook(name: string, callback: (event: any) => unknown): Promise<unknown>;
  synthetic(input: {
    sessionID: string;
    text: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

interface HostContext {
  location?: { directory?: string };
  session: HostSession;
  mcp: {
    transform(
      callback: (editor: {
        set: (name: string, config: unknown) => void;
      }) => unknown,
    ): Promise<unknown>;
  };
  tool: {
    hook(name: string, callback: (event: any) => unknown): Promise<unknown>;
  };
  event: {
    subscribe(input: { signal: AbortSignal }): AsyncIterable<any>;
  };
}

// Whoever installs the daemon records its address and the paths it owns
// here. A plugin inherits the environment OpenCode was launched from, which
// knows none of them, so every value is read rather than assumed: talking
// to a port nobody serves and appending captures to a directory nothing
// drains both fail silently, and a deployment that chose its own port is
// indistinguishable from one that did not.
// Point observations, off unless the level says otherwise. The level name
// and the line shape match the daemon's so one setting turns on both sides
// of a round trip and the two logs read alike. Set by the factory once the
// config has been read, since the deployment carries the level too.
let debugging = false;

function debug(op: string, attrs: Record<string, unknown>): void {
  if (!debugging) return;
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const parts = Object.entries(attrs).map(([key, value]) => `${key}=${value}`);
  console.error(`${stamp} level=debug op=${op} ${parts.join(" ")}`);
}

function configPath(): string {
  return (
    process.env.MEMORY_CLIENT_CONFIG ||
    join(process.env.HOME || ".", ".local/services/memory/client.json")
  );
}

function loadConfig(): ConfigGetter {
  const path = configPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    parsed = null;
  }
  const settings =
    parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : {};
  debugging =
    (process.env.MEMORY_SPAN_LOG || settings.log_level || "").toLowerCase() ===
    "debug";
  // Throwing here costs the whole plugin, which is the intent: OpenCode
  // catches it and logs "failed to load plugin", where a fallback would
  // have produced a session that looks wired up and stores nothing.
  const getter = ((key: string, envVar: string): string => {
    const value = process.env[envVar] || settings[key];
    if (!value) {
      throw new Error(
        `[memory] no ${key}: set ${envVar}, or have the deployment write it to ${path}`,
      );
    }
    return value as string;
  }) as ConfigGetter;
  // Optional keys have no throwing lookup; the raw object rides along.
  getter.settings = settings;
  return getter;
}

const MAX_MEMORY_CHARACTERS = 1200;
const MEMORY_ELISION = "…[truncated]…";
// Compliance-ladder delivery (PRD-179): the turn report is the ladder's only
// per-prompt round trip, so the same failure economics apply — a wedged
// daemon must not collect a timeout from every prompt.
const COMPLIANCE_TIMEOUT_MS = 1000;
const COMPLIANCE_BACKOFF_MS = 30_000;

// Session-start KB delivery: one fetch per session, on the first prompt.
// The daemon renders nothing for a repo without a KB, so a miss is
// recorded as delivered — the session that opened before its KB was
// composed simply catches the next one, and the plugin stops paying a
// round trip per prompt asking. A failed fetch backs off (a wedged
// daemon must not collect a timeout from every prompt), and the
// retry-after-backoff is the pending-list heal.
const SESSION_OPEN_TIMEOUT_MS = 5000;
const SESSION_OPEN_BACKOFF_MS_DEFAULT = 30_000;
// Tool-moment delivery: same failure economics as session-open — a wedged
// daemon must not collect a timeout from every tool call.
const TOOL_MOMENT_TIMEOUT_MS = 2000;
const TOOL_MOMENT_BACKOFF_MS = 30_000;
// MCP tool names this daemon serves, as opencode decorates them: every
// tool of a server named `memory` carries the `memory_` prefix (the
// canonical name rides behind it — memory_tool_rule_add is
// tool_rule_add's decorated form, memory_persona_codify is
// persona_codify's). A tool from any other server never matches this
// prefix, so builtins and foreign tools skip the round trip without an
// allowlist that drifts from the daemon's actual surface.
const MCP_SERVER_PREFIX = "memory_";
const SHELL_TOOL = "shell";

// The reading verbs (PRJ-178's stamp set), as opencode decorates them: the
// daemon's canonical name rides behind the server prefix. This set decides
// which tool events report a compliance pull; the daemon re-checks
// membership on the canonical name, so the two definitions can only agree.
const COMPLIANCE_PULL_TOOLS = new Set(
  [
    "memory_recall",
    "memory_get",
    "memory_list",
    "memory_find_conversations",
    "memory_find_duplicates",
    "knowledge_read",
    "rule_recall",
  ].map((tool) => `${MCP_SERVER_PREFIX}${tool}`),
);

function isMomentTool(tool: string): boolean {
  return tool === SHELL_TOOL || tool.startsWith(MCP_SERVER_PREFIX);
}

// The event a tool call maps to, or null when this tool binds nothing:
// shell commands match command keys; this daemon's MCP tools match their
// canonical names (the daemon strips the decoration).
function momentEvent(tool: string, input: unknown): MomentEvent | null {
  if (tool === SHELL_TOOL) {
    const command =
      input && typeof input === "object"
        ? (input as { command?: unknown }).command
        : "";
    return command ? { kind: "command", command } : null;
  }
  if (tool.startsWith(MCP_SERVER_PREFIX)) {
    return { kind: "mcp", tool: tool.slice(MCP_SERVER_PREFIX.length) };
  }
  return null;
}

// Everything the daemon round trip needs. setup() binds these operations
const TOOLS_WITH_CWD = new Set([
  "memory_memory_remember",
  "memory_rule_recall",
  "memory_memory_recall",
  "memory_tool_rule_add",
  "memory_tool_rule_lookup",
  "memory_tool_rule_copy",
  "memory_rule_codify",
]);

// The tools whose session link the plugin injects, overwriting whatever
// landed in input: every lineage-gated write (the daemon's gate resolves
// the conversation), knowledge_read (the deferred-facts pointer), and the
// reads whose provenance pointers the gate redacts for unanchored callers
// — those need the conversation to decide whether pointers may be shown
// (PRD 20261114-lineage-gated-writes). Same decoration rule as above.
const TOOLS_WITH_SESSION = new Set(
  [
    "memory_remember",
    "memory_update",
    "memory_forget",
    "memory_mark_checked",
    "persona_codify",
    "persona_update",
    "persona_reinforce",
    "rule_codify",
    "rule_forget",
    "rule_feedback",
    "tool_rule_add",
    "tool_rule_remove",
    "tool_rule_promote",
    "tool_rule_copy",
    "knowledge_read",
    "memory_recall",
    "memory_list",
    "memory_find_conversations",
  ].map((tool) => `${MCP_SERVER_PREFIX}${tool}`),
);

function enqueue(queueDir: string, record: CaptureRecord): void {
  try {
    mkdirSync(queueDir, { recursive: true });
    appendFileSync(
      join(queueDir, "capture.jsonl"),
      `${JSON.stringify(record)}\n`,
    );
    debug("capture.queued", {
      kind: record.kind || record.role,
      conversation: record.conversation_id,
      chars: (record.text || "").length,
    });
  } catch (error) {
    console.error(`[memory] capture failed: ${error}`);
  }
}

function requestWithTimeout(
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

// The session-start block (PRJ-176): the standing KB doc plus the opening
// request's top-k facts, provenance-framed per the PRD's framing
// requirements — what it is and when it was composed, the advisory
// framing, the correction protocol, attribution on use, and the pull
// pointer for everything the render cap left out. Facts elide head+tail
// at the same budget and in the same shape as every other injected
// surface, so all of them agree byte-for-byte.
function formatSessionOpen(data: SessionOpenData): string {
  const parts = [
    `Project knowledge: ${data.project} — composed ${data.doc_created_at}, folded from ${data.inputs_count} recorded row(s).`,
    "",
    data.doc,
  ];
  const facts = (data.topk || []).map((item) => {
    const truncated = item.content.length > MAX_MEMORY_CHARACTERS;
    const content = truncated
      ? `${item.content.slice(0, MAX_MEMORY_CHARACTERS / 2)}${MEMORY_ELISION}${item.content.slice(
          -MAX_MEMORY_CHARACTERS / 2,
        )}`
      : item.content;
    return `- ${item.id ?? "unknown-id"} [${item.timestamp || "unknown time"}] (${
      item.veracity || "unknown"
    }, ${item.author_type || "unknown"}) ${content}${truncated ? " [truncated]" : ""}`;
  });
  if (facts.length) {
    parts.push("", "Facts matching this request:", ...facts);
  }
  parts.push(
    "",
    "Judge relevance and ignore what does not apply; this never assigns tasks. Correct it the same way you correct any memory: write the truer fact with memory_remember (a newer fact wins at the next build) or forget the row that carried the claim. When a reply uses this material, say it came from the memory store. The standing doc and everything beyond this block: knowledge_read.",
  );
  return `\n\n<system-reminder>\n${parts.join("\n")}\n</system-reminder>`;
}

// One fired tool rule, informational: the daemon's framing section with
// the note as the body — the same system-reminder frame every injected
// block rides in.
function formatToolMoment(delivery: MomentDelivery): string {
  return `\n\n<system-reminder>
${delivery.section}

- [${delivery.created_at || "unknown time"}] (${delivery.scope}${
    delivery.project ? `: ${delivery.project}` : ""
  }) ${delivery.note}${delivery.rule_id ? ` (rule ${delivery.rule_id})` : ""}
</system-reminder>`;
}

// The compliance reminder (PRD-179): the daemon's framed section — heading,
// tier text, tail — inside the same system-reminder frame as everything
// else this plugin delivers.
function formatCompliance(section: string): string {
  return `\n\n<system-reminder>\n${section}\n</system-reminder>`;
}

// Throwaway prompts never reach capture, and never reach the compliance
// ladder's turn count: the ladder measures real work, not acknowledgements.
const TRIVIAL_PROMPT =
  /^(yes|no|ok|okay|thanks|continue|go ahead|do it)\b[.!]*$/i;

// Everything the daemon round trip needs. setup() binds these operations
// to the hook payload shapes, so a behaviour change lands in one place
// rather than drifting across hooks.
const createCore = ({
  directory,
  worktree,
  sessionApi,
}: {
  directory?: string;
  worktree?: string;
  sessionApi: { get(input: { sessionID: string }): Promise<any> };
}) => {
  // Read inside the factory: tests point this at a fake daemon and a queue
  // by writing client.json before calling setup().
  const setting = loadConfig();
  const queueDir = setting("queue_dir", "MEMORY_QUEUE_DIR");
  const daemonUrl = setting("daemon_url", "MEMORY_DAEMON_URL");
  const root = directory || worktree || process.cwd();
  // Every location the plugin resolved. A client pointed at the wrong port
  // or a stale queue behaves exactly like one with nothing to say.
  debug("plugin.start", {
    config: configPath(),
    daemon: daemonUrl,
    queue: queueDir,
    root,
  });
  const compacting = new Set();
  const childSessions = new Set();
  const topLevelSessions = new Set();
  // Driven `opencode run` sessions register their parent link once — the
  // first prompt is the reliable moment (session.created does not always
  // fire in run mode), and the guard keeps it a one-time line.
  const drivenRegistered = new Set();
  const assistantParts = new Map();
  // Sessions whose session-start block is settled: either delivered or
  // answered with the honest silence of "no KB for this repo". Survives
  // compaction — once per session means once per session. Overlapping
  // prompts must not double-fetch, and a wedged daemon must not collect
  // a timeout from every prompt.
  const sessionOpenDone = new Set();
  const sessionOpenBusy = new Set();
  const sessionOpenBusyUntil = new Map();
  const toolMomentBusyUntil = new Map();
  // The compliance turn leg backs off the same way a refused delivery does:
  // a wedged daemon must not collect a timeout from every prompt.
  const complianceBusyUntil = new Map();
  // The informational block a before-hook fetch produced, waiting for the
  // after-hook that renders it beside the tool's output. Keyed by
  // `session\0call` — concurrent tool calls in one session correlate
  // their halves through the call id, not the session.
  const toolMomentPending = new Map();
  // Optional knob (client.json / env): the tests shrink it to exercise
  // the retry; deployments get the 30s default.
  const sessionOpenBackoffMs = (): number => {
    const raw =
      process.env.MEMORY_SESSION_OPEN_BACKOFF_MS ||
      setting.settings.session_open_backoff_ms;
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : SESSION_OPEN_BACKOFF_MS_DEFAULT;
  };

  // The director plugin's dispatch stamp (PRJ-343): a worker session
  // carries `chancery.coordinatedBy` in durable session metadata, naming
  // the session that dispatched it. The plugin runs in the worker's
  // process, so the worker's own session row is the record of it; read
  // live through the session domain rather than from the event pump,
  // whose delivery can race the brief's first prompt. The coordinator
  // stamp keeps driving the director's mail machinery and the wake
  // ordering: the coalescing check below reads it and nothing else.
  const DIRECTOR_STAMP = "chancery";
  const DIRECTOR_DIRECTOR = "coordinatedBy";
  // The origin declaration (ADR 20261124-session-origin-signal): the
  // create-time record a programmatic spawn stamps beside the
  // coordinator stamp, `{ initiator, parent }` — the cross-tool lineage
  // signal. Whatever tool spawned the session declares it, and the
  // vocabulary deliberately avoids opencode's `agent` word (that names
  // the persona role); the store's own vocabulary is applied at this
  // client, the signal's one mapping point.
  const ORIGIN_STAMP = "chancery_origin";
  // The origin record parsed, or null — undeclared. A value that does
  // not parse exactly (an initiator outside the vocabulary, or a parent
  // that is missing, or blank after trimming) reads as undeclared,
  // never as programmatic: absence is the human default, so a half-
  // written record or an unrelated stamp under a different key cannot
  // invent a parent link. The parent trims before it is trusted, the
  // way the driven path trims its external pointer: only a usable,
  // trimmed id registers or declares a parent.
  type OriginRecord = { initiator: "human" | "program"; parent: string };
  const originRecordOf = (raw: unknown): OriginRecord | null => {
    if (typeof raw !== "object" || raw === null) return null;
    const value = raw as { initiator?: unknown; parent?: unknown };
    if (
      (value.initiator === "human" || value.initiator === "program") &&
      typeof value.parent === "string" &&
      value.parent.trim()
    ) {
      return { initiator: value.initiator, parent: value.parent.trim() };
    }
    return null;
  };
  // The dispatch carries no parent link, so the worker's registration
  // line is the only way the session registry learns the structure
  // (PRJ-510): parent = the declared record's parent session, initiator
  // agent, the conversation chaining worker -> director session -> human
  // root. That keeps the full write surface the lineage gate grants a
  // line under a human root and attributes the worker's captured turns
  // as agent voice (PRD 20261114-lineage-gated-writes).
  // PRJ-344: opencode 2.2.5 promotes one inbox item per turn boundary.
  // The director module queues the brief as the waking prompt, and this
  // hook runs inside that prompt's admission — an item injected here as
  // its own inbox entry lands ahead of the brief and wins the first
  // boundary, leaving the brief to a boundary that may never come (a
  // session whose first turn stalls dispatches zero tokens). For a
  // director-dispatched session the block therefore coalesces into the
  // waking prompt itself, through the hook's mutable prompt contract.
  // Interactive sessions keep the synthetic injection: the contract
  // there is configured and shipped as is.
  // One lookup, every stamp consumer shared (PRJ-510): the coordinator
  // stamp and the origin declaration ride one durable metadata bag, so
  // one session.get answers the coalescing boolean (PRJ-344) and the
  // lineage registration together, and one prompt pays one session.get.
  // A failed live read answers nothing and caches nothing — the session
  // keeps today's route for this prompt and the lookup is paid again
  // next prompt, so a transient blip never hardens into an answer. A
  // settled read caches both fields; an absent stamp parses as null,
  // never as a read failure.
  type SessionStamps = {
    coordinator: string | null;
    origin: OriginRecord | null;
  };
  const sessionStamps = new Map<string, SessionStamps>();
  // The sessions whose declaration registered a lineage link: one-time
  // per session lifetime, the way driven adoption is; cleared on
  // delete, so a re-prompted session re-looks-up and re-links.
  const dispatchLinked = new Set<string>();
  const stampsOf = async (
    sessionID: string,
  ): Promise<SessionStamps | undefined> => {
    const cached = sessionStamps.get(sessionID);
    if (cached) return cached;
    try {
      const info = await sessionApi.get({ sessionID });
      const metadata = info?.metadata;
      const raw = metadata?.[DIRECTOR_STAMP]?.[DIRECTOR_DIRECTOR];
      const settled: SessionStamps = {
        coordinator: typeof raw === "string" && raw ? raw : null,
        origin: originRecordOf(metadata?.[ORIGIN_STAMP]),
      };
      sessionStamps.set(sessionID, settled);
      return settled;
    } catch {
      debug("session.dispatch.lookup.failed", { session: sessionID });
      return undefined;
    }
  };
  const isDirectorDispatched = async (sessionID: string): Promise<boolean> => {
    const stamps = await stampsOf(sessionID);
    return Boolean(stamps?.coordinator);
  };
  // One-time registration of the link the origin declaration carries,
  // mirroring the driven adoption. A record declaring initiator
  // "program" with a parent other than this session enqueues the
  // registration row; no record, a record that parses as undeclared, or
  // a parent equal to this session's own id registers nothing and stays
  // silent — the human default. A failed read enqueues nothing and marks
  // nothing — the next prompt retries. Returns false when the read
  // failed, so the caller knows the session's lineage state is still
  // unresolved.
  const adoptDispatchParent = async (sessionID: string): Promise<boolean> => {
    const stamps = await stampsOf(sessionID);
    if (stamps === undefined) return false;
    const origin = stamps.origin;
    if (
      origin &&
      origin.initiator === "program" &&
      origin.parent !== sessionID &&
      !dispatchLinked.has(sessionID)
    ) {
      dispatchLinked.add(sessionID);
      enqueue(queueDir, {
        kind: "session",
        conversation_id: sessionID,
        parent_conversation_id: origin.parent,
        cwd: root,
        app: "opencode",
        // A declared-programmatic session is started by its creating
        // agent, whatever the root above it is — the lineage walk
        // decides anchoring (the same rationale as a child session's
        // registration).
        initiator: "agent",
        ts: Date.now() / 1000,
      });
    }
    return true;
  };

  // Who started a session — the lineage gate's initiator (PRD
  // 20261114-lineage-gated-writes). A deployment whose sessions are all
  // agent-driven (the webhook bot) declares it in client.json or env; a
  // session with a parent, one driven through MEMORY_PARENT_
  // CONVERSATION_ID, or one whose registered origin link marks it
  // agent-started, is agent-started by construction; everything else
  // is the human's own session. It rides the connection URL (the
  // deployment's default for this client) and each capture's payload
  // (the per-session value), never a model-supplied argument.
  const declaredInitiator = (() => {
    const declared = (
      process.env.MEMORY_INITIATOR ||
      setting.settings.initiator ||
      ""
    ).toLowerCase();
    return declared === "agent" ? "agent" : "human";
  })();
  const initiatorOf = (sessionID: string): "agent" | "human" => {
    if (
      childSessions.has(sessionID) ||
      drivenRegistered.has(sessionID) ||
      dispatchLinked.has(sessionID)
    ) {
      return "agent";
    }
    return declaredInitiator;
  };

  // A driven `opencode run` has no session.created parent event: the
  // outer side hands the pointer over through the environment, and this
  // registration line is how the daemon learns the link (and that the
  // session is agent-started). The outer side's own trusted layer set
  // the variable; a model inside this session cannot change the fact
  // that its process was launched with it. Unlike a native child, a
  // driven session keeps capturing — its turns are the agent voice the
  // drain stamps, and they stay in session search (PRD req 4).
  const adoptDrivenParent = (sessionID: string): void => {
    if (drivenRegistered.has(sessionID)) return;
    const parent = (process.env.MEMORY_PARENT_CONVERSATION_ID || "").trim();
    if (!parent || parent === sessionID) return;
    drivenRegistered.add(sessionID);
    enqueue(queueDir, {
      kind: "session",
      conversation_id: sessionID,
      parent_conversation_id: parent,
      cwd: root,
      app: "opencode",
      initiator: "agent",
      ts: Date.now() / 1000,
    });
  };

  return {
    root,
    initiatorOf,
    isDirectorDispatched,
    // The client name and the lineage initiator ride on the URL rather
    // than on each tool call: the daemon stamps writes from the first and
    // gates them on the second, and one client cannot claim to be
    // another by editing a payload.
    mcpUrl: `${daemonUrl}/mcp?app=opencode&initiator=${declaredInitiator}`,
    // Session context for MCP tool calls: the daemon is one process serving
    // every session, and tool calls carry no directory — so the plugin (the
    // only layer that knows this process's project root) injects it before
    // the call reaches the wire. The store never fabricates: no cwd -> bare
    // stamps.
    wantsCwd(tool: string): boolean {
      return TOOLS_WITH_CWD.has(tool);
    },

    // Tool-moment delivery (PRJ-170): what the enrolled tool_rules say
    // when a bound tool is about to run. Deterministic on the daemon —
    // a token comparison, not a similarity roll — so every fire
    // delivers, and there is no per-session busy guard here: the route
    // is cheap (no scorer, no gate), and skipping the fetch on overlap
    // would skip the hold check, which is the one skip this channel
    // must never take. Concurrent calls in one session correlate their
    // before/after halves through the call id, not the session.
    async toolMoment(
      sessionID: string,
      callID: string,
      tool: string,
      input: unknown,
    ): Promise<any> {
      if (!sessionID) return null;
      if (Date.now() < (toolMomentBusyUntil.get(sessionID) || 0)) return null;
      try {
        const event = momentEvent(tool, input);
        if (!event) return null;
        const response = await requestWithTimeout(
          `${daemonUrl}/tool-moment`,
          {
            app: "opencode",
            conversation_id: sessionID,
            cwd: root,
            event,
          },
          TOOL_MOMENT_TIMEOUT_MS,
        );
        if (!response.ok) {
          debug("tool.moment.refused", {
            session: sessionID,
            status: response.status,
          });
          toolMomentBusyUntil.set(
            sessionID,
            Date.now() + TOOL_MOMENT_BACKOFF_MS,
          );
          return null;
        }
        return await response.json();
      } catch (error) {
        toolMomentBusyUntil.set(sessionID, Date.now() + TOOL_MOMENT_BACKOFF_MS);
        console.error(`[memory] tool-moment failed: ${error}`);
        return null;
      }
    },

    // The before-hook's hold leg: fetch the moment, and throw when the
    // daemon held this execution. An informational fetch parks its block
    // under the call id for the after-hook to render — the fire happened
    // here, but the read lands beside the tool's own output.
    async toolMomentHold(
      sessionID: string,
      callID: string,
      tool: string,
      input: unknown,
    ): Promise<void> {
      const data = await this.toolMoment(sessionID, callID, tool, input);
      if (!data) return;
      if (data.held) {
        // The rejection IS the delivery (PRD req 2, holds ON): the error
        // text is the daemon's rendered block, and the call never ran.
        throw new Error(data.error);
      }
      if (data.deliveries && data.deliveries.length) {
        toolMomentPending.set(`${sessionID}\u0000${callID}`, data);
      }
    },

    // The after-hook's informational leg: renders and clears the pending
    // block the before-hook's fetch parked under this call's id. No
    // second fetch, and the entry is consumed unconditionally — a call
    // that failed or was canceled after its fetch still clears it, so a
    // stale block never narrates the wrong tool's output.
    async toolMomentInfo(
      sessionID: string,
      callID: string,
    ): Promise<string | null> {
      const pendingKey = `${sessionID}\u0000${callID}`;
      const pending = toolMomentPending.get(pendingKey);
      toolMomentPending.delete(pendingKey);
      if (!pending || !pending.deliveries || !pending.deliveries.length)
        return null;
      return pending.deliveries.map(formatToolMoment).join("");
    },

    // The compliance ladder (PRD-179) — turn leg: one active prompt arrived.
    // Content never leaves the client: the daemon sees only the event kind
    // and the conversation. Child sessions count too — subagents do real
    // work, and the ladder observes the session, not the org chart. Returns
    // the framed reminder when a tier fired, null otherwise.
    async complianceTurn(
      sessionID: string,
      text: string,
    ): Promise<string | null> {
      if (
        !sessionID ||
        !text ||
        text.startsWith("/") ||
        TRIVIAL_PROMPT.test(text) ||
        compacting.has(sessionID)
      )
        return null;
      if (Date.now() < (complianceBusyUntil.get(sessionID) || 0)) return null;
      try {
        const response = await requestWithTimeout(
          `${daemonUrl}/compliance`,
          { type: "turn", app: "opencode", conversation_id: sessionID },
          COMPLIANCE_TIMEOUT_MS,
        );
        if (!response.ok) {
          debug("compliance.refused", {
            session: sessionID,
            status: response.status,
          });
          complianceBusyUntil.set(
            sessionID,
            Date.now() + COMPLIANCE_BACKOFF_MS,
          );
          return null;
        }
        const data = (await response.json()) as { section?: string } | null;
        return data && data.section ? formatCompliance(data.section) : null;
      } catch (error) {
        complianceBusyUntil.set(sessionID, Date.now() + COMPLIANCE_BACKOFF_MS);
        console.error(`[memory] compliance turn failed: ${error}`);
        return null;
      }
    },

    // The pull leg: the agent executed one of the reading verbs — the
    // ladder's whole reset. Awaited so the state write settles before the
    // tool's own execution continues; skipped silently when the daemon is
    // unreachable, because a missed reset is corrected by the next pull.
    async compliancePull(sessionID: string, tool: string): Promise<null> {
      if (!sessionID || !COMPLIANCE_PULL_TOOLS.has(tool)) return null;
      try {
        const response = await requestWithTimeout(
          `${daemonUrl}/compliance`,
          {
            type: "pull",
            app: "opencode",
            conversation_id: sessionID,
            tool,
          },
          COMPLIANCE_TIMEOUT_MS,
        );
        if (!response.ok) {
          debug("compliance.refused", {
            session: sessionID,
            status: response.status,
          });
        }
      } catch (error) {
        debug("compliance.pull.failed", { session: sessionID });
      }
      return null;
    },

    // Marks the boundary and returns the note for the summarizing request,
    // or nothing when this session is a subagent's.
    compacting(sessionID: string): string | undefined {
      if (childSessions.has(sessionID)) return;
      compacting.add(sessionID);
      enqueue(queueDir, {
        kind: "compaction",
        conversation_id: sessionID,
        trigger: "opencode",
        cwd: root,
        app: "opencode",
        ts: Date.now() / 1000,
      });
      return "Memory store has consolidated the conversation at this compaction boundary. Recall before relying on details that may have been summarized away.";
    },

    // The session-start block, at most once per session: the standing KB
    // doc plus the opening request's top-k facts. Rides the first real
    // prompt because that is where the request exists to match against;
    // this route makes no LLM call, and a "continue" opening still
    // deserves the arc. A failed fetch leaves the gate unset, so the next
    // prompt retries (the pending-list heal pattern); an answer — block
    // or honest silence — settles the session for good.
    async sessionOpen(
      sessionID: string,
      text: string,
    ): Promise<string | undefined> {
      if (sessionOpenDone.has(sessionID)) return;
      if (childSessions.has(sessionID) || compacting.has(sessionID)) return;
      if (!text || text.startsWith("/")) return;
      if (Date.now() < (sessionOpenBusyUntil.get(sessionID) || 0)) return;
      if (sessionOpenBusy.has(sessionID)) return;
      sessionOpenBusy.add(sessionID);
      try {
        const response = await requestWithTimeout(
          `${daemonUrl}/session-open`,
          { prompt: text, cwd: root, conversation_id: sessionID },
          SESSION_OPEN_TIMEOUT_MS,
        );
        if (!response.ok) {
          debug("session.open.refused", {
            session: sessionID,
            status: response.status,
          });
          sessionOpenBusyUntil.set(
            sessionID,
            Date.now() + sessionOpenBackoffMs(),
          );
          return;
        }
        const data = (await response.json()) as SessionOpenData | null;
        sessionOpenDone.add(sessionID);
        if (!data || !data.doc) return;
        return formatSessionOpen(data);
      } catch (error) {
        console.error(`[memory] session-open failed: ${error}`);
        sessionOpenBusyUntil.set(
          sessionID,
          Date.now() + sessionOpenBackoffMs(),
        );
      } finally {
        sessionOpenBusy.delete(sessionID);
      }
    },

    // Captures the turn for the store. Nothing is delivered here: content
    // never rides message arrival (ADR 20261104-retire-per-message-delivery)
    // — this is the capture boundary, not a recall one.
    async userPrompt(sessionID: string, text: string): Promise<void> {
      adoptDrivenParent(sessionID);
      if (childSessions.has(sessionID) || compacting.has(sessionID)) return;
      // The origin declaration's registration row must precede this session's
      // first capture row in the queue: the drain registers a conversation
      // from the first payload that names it, and a turn registering
      // first would create the row with the deployment's default
      // initiator — agent prose stamped human voice. A failed stamp read
      // captures nothing this prompt and retries on the next one.
      if (!(await adoptDispatchParent(sessionID))) return;
      if (
        !text ||
        text.startsWith("/") ||
        /^(yes|no|ok|okay|thanks|continue|go ahead|do it)\b[.!]*$/i.test(text)
      )
        return;
      topLevelSessions.add(sessionID);
      enqueue(queueDir, {
        role: "user",
        text,
        cwd: root,
        app: "opencode",
        conversation_id: sessionID,
        initiator: initiatorOf(sessionID),
        ts: Date.now() / 1000,
      });
    },

    sessionCreated(sessionID: string, parentID?: string): void {
      if (parentID) {
        childSessions.add(sessionID);
        // Children skip capture, so this registration line is the registry's
        // only signal about them: provenance and the structural parent link
        // ride it. The daemon's drain handles kind:"session" upstream.
        enqueue(queueDir, {
          kind: "session",
          conversation_id: sessionID,
          parent_conversation_id: parentID,
          cwd: root,
          app: "opencode",
          // A child session is started by its parent agent, whatever the
          // root above it is — the lineage walk decides anchoring.
          initiator: "agent",
          ts: Date.now() / 1000,
        });
        return;
      }
      adoptDrivenParent(sessionID);
    },

    // Assistant turns flush at the end of the turn: long enough to be
    // useful, never partial (the drain classifies anyway — the plugin
    // stays dumb).
    assistantText(sessionID: string, text: string): void {
      if (!topLevelSessions.has(sessionID)) return;
      const parts = assistantParts.get(sessionID) || [];
      parts.push(text || "");
      assistantParts.set(sessionID, parts);
    },

    sessionIdle(sessionID: string): void {
      const parts = assistantParts.get(sessionID);
      if (!parts || !topLevelSessions.has(sessionID)) return;
      const text = parts.join(" ").trim();
      if (text.length >= 100) {
        enqueue(queueDir, {
          role: "assistant",
          text,
          cwd: root,
          app: "opencode",
          conversation_id: sessionID,
          initiator: initiatorOf(sessionID),
          ts: Date.now() / 1000,
        });
      }
      assistantParts.delete(sessionID);
    },

    sessionCompacted(sessionID: string): void {
      compacting.delete(sessionID);
    },

    sessionDeleted(sessionID: string): void {
      compacting.delete(sessionID);
      topLevelSessions.delete(sessionID);
      childSessions.delete(sessionID);
      assistantParts.delete(sessionID);
      sessionOpenDone.delete(sessionID);
      sessionOpenBusy.delete(sessionID);
      sessionOpenBusyUntil.delete(sessionID);
      sessionStamps.delete(sessionID);
      dispatchLinked.delete(sessionID);
      toolMomentBusyUntil.delete(sessionID);
      complianceBusyUntil.delete(sessionID);
      for (const key of [...toolMomentPending.keys()]) {
        if (key.startsWith(`${sessionID}\u0000`)) toolMomentPending.delete(key);
      }
    },
  };
};

const setup = async (ctx: HostContext): Promise<() => void> => {
  const core = createCore({
    directory: ctx.location?.directory,
    sessionApi: ctx.session,
  });

  await ctx.mcp.transform((editor) => {
    editor.set("memory", { type: "remote", url: core.mcpUrl });
  });

  // The session-start block persists as a synthetic through the session
  // API: it lowers to a user-role message riding this turn's projection at
  // the tail, never renders in the TUI (synthetics without a description
  // get no row), and the daemon's dedupe still sees the text in context
  // because the synthetic stays in the session history. No hook-order
  // dependence: the standing contract and floor moved to the config
  // `instructions` route, which the harness watches and re-delivers on
  // change. A director-dispatched worker takes the coalesced route instead
  // (PRJ-344, isDirectorDispatched): its block rides the waking prompt's own
  // inbox item, so the brief never waits behind one at a turn boundary.
  await ctx.session.hook("prompt", async (event) => {
    // The text as this prompt arrived — the operator's words, or a
    // coordinator's brief, depending on the session. Capture and the
    // compliance leg below key on it rather than on the value routing
    // leaves in event.prompt.text: memory content delivered here is
    // context for the turn, not the turn's own words, and must not be
    // recorded as either.
    const text = event.prompt.text;
    const open = await core.sessionOpen(event.sessionID, text);
    if (open) {
      if (await core.isDirectorDispatched(event.sessionID)) {
        // Coalesce, through the hook's mutable prompt contract: the
        // waking prompt's own inbox item carries the block, so the brief
        // and the block promote together at the first boundary.
        event.prompt.text = `${event.prompt.text}${open}`;
      } else {
        await ctx.session.synthetic({
          sessionID: event.sessionID,
          text: open,
        });
      }
    }
    // Capture only — content never rides message arrival.
    await core.userPrompt(event.sessionID, text);
    // The compliance ladder's turn leg (PRD-179): the daemon decides
    // whether this many silent active turns deserve a reminder, and the
    // reminder is the only thing this hook delivers — no memory content.
    const compliance = await core.complianceTurn(event.sessionID, text);
    if (compliance)
      await ctx.session.synthetic({
        sessionID: event.sessionID,
        text: compliance,
      });
  });

  await ctx.session.hook("compaction", (event) => {
    const note = core.compacting(event.sessionID);
    if (note) event.system.push({ type: "text", text: note });
  });

  await ctx.tool.hook("execute.before", async (event) => {
    if (
      core.wantsCwd(event.tool) &&
      event.input &&
      typeof event.input === "object"
    ) {
      event.input.cwd = core.root;
    }
    // The session link rides exactly the way cwd does: this plugin is the
    // only layer that knows the session, so it injects conversation_id
    // before the call reaches the wire, overwriting whatever landed in
    // input — the model's own value never survives this client. The
    // lineage initiator does NOT ride here: the daemon reads it off the
    // connection URL, which the deployment built, so a model-supplied
    // lineage is stripped at the gate no matter what lands in input (PRD
    // 20261114-lineage-gated-writes). The write tools need the
    // conversation for the daemon's lineage gate; knowledge_read needs it
    // to find the facts deferred at session start; the redacted reads
    // need it so the gate can decide whether provenance pointers may be
    // shown. A client without this plugin stamps the link at its own
    // layer; a write that carries none anchors to the provenance-
    // unrecorded placeholder honestly.
    if (
      TOOLS_WITH_SESSION.has(event.tool) &&
      event.input &&
      typeof event.input === "object"
    ) {
      event.input.conversation_id = event.sessionID;
    }
    // The compliance pull report (PRD-179) rides ahead of the hold so the
    // ladder's reset lands even when the hold throws below: the agent
    // pulled, regardless of what the gate did with the call.
    await core.compliancePull(event.sessionID, event.tool);
    // Tool-moment holds run here because this is the only hook that can
    // reject a call: with the holds flag on, a bound tool's first
    // execution in the conversation throws, and the thrown message — the
    // daemon's rendered rule text — is the error the model reads. A
    // before-hook returns void otherwise; informational delivery rides
    // execute.after, beside the tool's own output.
    return core.toolMomentHold(
      event.sessionID,
      event.id,
      event.tool,
      event.input,
    );
  });

  await ctx.tool.hook("execute.after", async (event) => {
    // The pending moment block is consumed unconditionally — a call that
    // failed or was canceled after its fetch must not leave its block to
    // narrate the next tool's output.
    if (isMomentTool(event.tool)) {
      const moment = await core.toolMomentInfo(event.sessionID, event.id);
      if (event.status === "completed" && moment) {
        await ctx.session.synthetic({
          sessionID: event.sessionID,
          text: moment,
        });
      }
    }
  });

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        const data = event.data || {};
        switch (event.type) {
          case "session.created":
            core.sessionCreated(data.sessionID, data.parentID);
            break;
          // The replayable boundary for one assistant text block; the
          // streaming deltas beside it are live-only fragments.
          case "session.text.ended":
            core.assistantText(data.sessionID, data.text);
            break;
          // The end of a turn is the end of its execution, however it ended.
          case "session.execution.succeeded":
          case "session.execution.failed":
          case "session.execution.interrupted":
            core.sessionIdle(data.sessionID);
            break;
          case "session.compacted":
            core.sessionCompacted(data.sessionID);
            break;
          case "session.deleted":
            core.sessionDeleted(data.sessionID);
            break;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error(`[memory] event subscription failed: ${error}`);
      }
    }
  })();

  return () => controller.abort();
};

export default {
  id: "memory-store",
  setup,
  formatSessionOpen,
};
