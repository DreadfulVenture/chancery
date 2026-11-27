// Coordination patterns (failure narration, coordinator stamps) derived
// from @sysread/thatch's opencode v2 coordinator, MIT — see LICENSE.

// The director module (PRJ-317): directors dispatch and steer worker sessions
// in-process over the host session API — no `opencode run` subprocess, no
// stdout event stream. The dispatching session id is stamped into the
// child's session metadata at create time; each watched child's turn end
// files one stored report for that stamp and sends the director a fixed
// wake notice, and the director pulls the bodies with report_read.
// Provider and turn failures file as reports too, rather than as a silent
// success.
//
// Transport, against the opencode v2 plugin surface (v2.3.0 is the
// deployed host — system commit 3d29196, deployed 15:52; 2.0.29 is the
// design basis the single-delivery work was verified against):
// - session.prompt admits the message and returns while the turn runs
//   asynchronously; its default delivery is a steer, which wakes an idle
//   session. Dispatch and steering are enqueues; the tools never await a
//   worker's turn and never stream one.
// - the host runs one plugin activation per location, and a worker's turn
//   runs in the worker's own location. Plugin event streams are not
//   filtered by location: every activation sees every session's events.
//   One deliverer per turn end: the activation whose location directory is
//   the worker session's directory. It adopts the worker lazily from its
//   stamp (session.get) on the first event it sees for it, so a dispatching
//   director's location going idle, a plugin reload, or a host restart
//   costs no report lane, and no session.list walk is needed (2.0.29's
//   surface had none; the tool fails named when a surface lacks it). Two
//   locations that share a directory under
//   different workspace ids would both match, as would an old and a new
//   activation overlapping during a location reload; the delivery claim
//   below is what keeps those to one stored report and one notice.
// - subagent sessions inherit their parent's metadata and location, stamp
//   included, so a session with a parentID is never a worker of its own.
// - session.metadata is a durable host-opaque record carrying the dispatch
//   stamp the lazy adoption reads.
// - a turn's session.text.ended blocks arrive between its
//   session.execution.started and one terminal execution event
//   (succeeded / failed / interrupted). Report = the buffered text plus
//   the terminal's own kind; at most one stored report and one wake
//   notice per terminal event. A turn interrupted by shutdown and later
//   resumed has two terminal events, so it can bring a notice and then
//   the resumed turn's own report. A succeeded turn whose final step
//   ended (provider finish "stop") without producing one text block is a
//   degenerate completion — a provider cut mid-execution — and files as
//   its own "truncated" kind (PRJ-499); a turn with no recorded step
//   evidence files as "report", since there is nothing to judge.
// - a dispatched session has no permission answerer: no TUI dialog and no
//   `opencode run` auto-replier is attached, so an ask-shaped permission
//   rule would park the turn's tool fiber on a deferred nobody resolves —
//   busy forever, no terminal, no mail. The dispatch therefore stamps an
//   unattended permission policy on the worker's session at create time,
//   before the waking prompt is admitted; session-level rules out-rank
//   agent- and config-level rules in the host's evaluation.
// - a session that has never ended a turn carries no time.idle at all: the
//   mapper renders the row's null time_idle as undefined, so "no time.idle"
//   on the session object reads as "never ended a turn", never an invented
//   epoch zero. Verified against the opencode v2 source,
//   packages/core/src/session/info.ts:57:
//
//     idle: row.time_idle === null ? undefined : DateTime.makeUnsafe(row.time_idle),
//
// PRJ-342 completes the family with a read-only discovery leg:
// director_sessions enumerates the sessions the host's session API knows —
// id, directory, agent, busy/idle, and the last turn-end stamp — so a
// coordinator can poll lanes whose ids it does not already hold. It reads
// the host's in-process session rows, with no second state store behind
// it; it returns no message content and no metadata, and when the client
// surface lacks session.list (as 2.0.29's did) it fails named instead of
// reaching for storage.
//
// The UP direction is pull (PRJ-347). A turn end stores the report and
// wakes the director; the bodies are read on demand:
//
// - The report row lives in ctx.storage, the plugin-scoped view of the
//   host's kv table (SQLite: packages/core/src/kv/sql.ts; the plugin
//   surface: packages/core/src/plugin/host.ts:498 and :663-690, promise-
//   adapted at packages/plugin/src/promise/adapter.ts:508-512). It
//   survives a plugin reload and a host restart. Rows are keyed
//   report/<director>/<worker>/<terminal event id>, so a scan of one
//   director's prefix is exactly that director's mail, unread flags ride
//   the row, and the claim below is what makes one row and one notice out
//   of overlapping activations. Read rows are pruned after a week on the
//   next store for the same director.
// - The wake notice is a synthetic whose text is fixed apart from the
//   worker session id and the cumulative unread count — never any text
//   the worker wrote. Worker text reaches the model only as a report_read
//   tool result. The notice rides plain, and the wrapped forms are the
//   wrong shape twice over: a user message made only of <system-reminder>
//   blocks is classified by the deployed provider (cursor-opencode-
//   provider 0.8.7, dist/language-model.js) as a host note that
//   contributes nothing to the user turn (hostTailNote returns {},
//   :7030; liveUserTurn falls back to ".", :7553-7561) — every wrapped
//   mail reached the model as ".". A <system-update>-wrapped note does
//   not ride as the user turn either, but it is not lost: the same wake
//   delivers it through the turn-boundary collection
//   (prepareUserTurnHostNotes, :~4005-4009) as a one-shot reminder
//   (:1901) that admitContextEpoch combines into a mid-conversation
//   system note (dist/context/epoch.js:136 and :168-177), rewrapped as
//   <system_reminder> — system authority, which plugin-authored content
//   must never carry. The plain-text notice needs neither path: it is
//   the live user turn itself, and its fixed words are the plugin's.
//   Plain text returns undefined from hostTailNote (:7025). The host
//   passes a synthetic's text through as the user
//   turn's content verbatim (packages/core/src/session/runner/
//   to-llm-message.ts:274-275), with description and metadata kept out of
//   the prompt — that pair is what renders the notice as a "◈ Notice" row
//   (metadata.source names the module), the same shape the host's own
//   shell-error synthetics use (packages/core/src/session/session.ts:
//   202-206).
// - One wake per terminal event, the unread count coalescing the state
//   across events: suppressing a wake while earlier reports sit unread
//   risks a report nothing ever pulls, and the fixed notice bounds each
//   event's cost. report_read drains every unread report in one call,
//   under numeric page and character budgets, and marks what it returned
//   read. A notice whose send fails keeps its claim — the row is stored,
//   and a sibling re-noticing the same terminal event would overwrite it
//   with its own buffer's text — so the stranded report waits for the
//   next terminal event's coalesced count. A report whose store failed
//   gives the claim back and wakes nobody, since a notice without a
//   pullable report would lie; the export pointer is logged.
//
// An interrupt with no recorded reason reads as "shutdown" on the wire;
// the host keeps that turn's claim and may resume it after a restart, but
// nothing guarantees a resume, or that a resumed turn's end reaches this
// module. That interrupt attempts its own notice rather than staying
// silent; the pump can be torn down by the same shutdown before it sends.

import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The director module's tools as the host's ToolEditor sees them: a plain JSON Schema
// object for `input`, and an execute the host calls with the raw tool
// input and a context carrying the calling session's id.
type ToolContext = { sessionID?: string };
type ToolDefinition = {
  name: string;
  description: string;
  input: unknown;
  output: unknown;
  execute: (
    input: any,
    context?: ToolContext,
  ) => Promise<{
    content: string;
    output: unknown;
  }>;
};

// The worker record one activation tracks per adopted session.
type WorkerEntry = {
  director: string;
  title?: string | null;
  directory?: string | null;
  agent?: string | null;
  model?: string;
  pendingTurn?: boolean;
  midTurn?: boolean;
  reason?: string | null;
};

// A stored report row (report/<director>/<worker>/<event id>).
type ReportRow = {
  to: string;
  worker: string;
  eventID: string | null;
  kind: string;
  title?: string | null;
  directory?: string | null;
  agent?: string | null;
  reason?: string | null;
  partial: boolean;
  text: string;
  created: number;
  read: boolean;
  readAt?: number;
};

// A stored manifest row (manifest/<owner>/<key>/<row id>).
type ManifestRow = {
  id: string;
  key: string;
  fact: string;
  owner: string;
  at: number;
  supersedes?: string;
};

// A stored worktree row (worktree/<encoded path>). `branch` is the
// checked-out branch at write time; `base`/`baseCommit` record what the
// head was checked against when the row was written.
type WorktreeRow = {
  path: string;
  repo: string;
  branch: string;
  head: string;
  base: string | null;
  baseCommit: string | null;
  owner: string;
  session: string | null;
  createdAt: number;
};

// A host event on the module's pump; the handlers read type, id, and the
// per-type data.
type HostEvent = { id?: string; type: string; data?: any };

// The plugin host surface the module touches. The host's own types are not
// importable from here, so the domains are shaped by what it reads,
// with the genuinely dynamic rows left as any.
interface StorageDomain {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
  remove(key: string): Promise<unknown>;
  scan(input: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: Array<{ key: string; value: unknown }>;
    next?: string;
  }>;
}

interface SessionDomain {
  get(input: { sessionID: string }): Promise<any>;
  create(input: {
    title?: string;
    agent?: string;
    permissions?: Array<{ action: string; resource: string; effect: string }>;
    metadata?: Record<string, unknown>;
    location?: { directory: string };
  }): Promise<any>;
  switchModel(input: {
    sessionID: string;
    model: { providerID: string; id: string; variant?: string };
  }): Promise<unknown>;
  prompt(input: {
    sessionID: string;
    text: string;
    delivery?: string;
  }): Promise<unknown>;
  synthetic(input: {
    sessionID: string;
    text: string;
    description?: string;
    metadata?: Record<string, unknown>;
    // PRJ-534: the persistence flag the host gates the wake on
    // (resume !== false wakes, packages/core/src/session/session.ts:286-310
    // at v2.3.0); the reminder's persistence carries resume:false so a
    // stored reminder never wakes the session — no empty turns.
    resume?: boolean;
  }): Promise<unknown>;
  // director_sessions and the worktree removal's live-session check
  // require the enumeration surface and fail named when it is absent.
  list?(input?: { cursor?: string }): Promise<any>;
  // PRJ-522: the transcript read the usage surfaces ride — the host's
  // Session.context, the same message list the model replays
  // (packages/core/src/session/store.ts:201 at v2.3.0). Absent: the
  // usage reads return nothing.
  context?(input: { sessionID: string }): Promise<any>;
  // drive-project re-targets the session it runs in to the director agent;
  // the command degrades to a plain prompt when the surface lacks it.
  switchAgent?(input: { sessionID: string; agent: string }): Promise<unknown>;
  // The prompt hook fires inside the prompt request, awaited, before the
  // runner builds the session's tool snapshot
  // (packages/core/src/session/prompt.ts hooks.trigger → admission.admit →
  // execution.wake). The permission re-assert registers its late agent
  // transform here (PRJ-469). A host without this hook logs the error
  // below and skips the re-assert, so the config floor's deny strips the
  // write-half tools from the director agent's catalog as before the fix.
  // The callback's input is the host's SessionPrompt shape, whose
  // messageID is required on the prompt event — verified in the opencode
  // tree, in the SessionPrompt interface
  // (packages/plugin/src/effect/session.ts). The union below marks it
  // optional because the context event carries no messageID.
  // The context hook is the model-request assembly hook: the host fires it
  // per model call over the LLM transcript, whose messages carry
  // {role, content, id?, metadata?} — messages is required and content is
  // always an array of parts, never a string: Message.make normalizes
  // string input into a parts array before the event flows
  // (packages/ai/src/schema/messages.ts at v2.2.5; the event is built from
  // SessionModelRequest.baseTranscript's toLLMMessages output,
  // packages/core/src/session/runner/llm.ts, also at v2.2.5). The
  // delegation reminder's splice registers here (PRJ-529). The two events
  // share the hook name, not the shape.
  hook?(
    name: string,
    callback: (input: {
      sessionID: string;
      messageID?: string;
      agent?: string;
      messages: Array<{
        id?: string;
        role: string;
        content: Array<{
          type: string;
          text?: string;
          [key: string]: unknown;
        }>;
        metadata?: Record<string, unknown>;
      }>;
      prompt?: unknown;
      metadata?: Record<string, unknown>;
      delivery?: unknown;
    }) => Promise<void> | void,
  ): Promise<{ dispose: () => Promise<void> }>;
}

// The plugin options ride the object-form config entry; a discovered
// plugin has none. The director's one knob is the debug switch below.
type PluginOptions = { logLevel?: unknown };

// The registration domains, optional like every surface the module reads:
// the tools and the mail leg are the load requirement; the agent, skills,
// and commands registered from the shipped files are the enhancement, and
// a host without a domain (or the tests' fake) runs without them.
interface AgentDomain {
  transform(
    callback: (editor: {
      update: (id: string, fn: (agent: any) => void) => void;
    }) => unknown,
  ): Promise<unknown>;
}

interface SkillDomain {
  transform(
    callback: (editor: {
      add: (skill: {
        id: string;
        name: string;
        description?: string;
        path: string;
        content: string;
      }) => void;
    }) => unknown,
  ): Promise<unknown>;
}

interface CommandDomain {
  transform(
    callback: (editor: {
      add: (definition: {
        name: string;
        description?: string;
        execute: (invocation: {
          sessionID: string;
          prompt?: { text?: unknown };
          delivery?: string;
        }) => Promise<void>;
      }) => void;
    }) => unknown,
  ): Promise<unknown>;
}

interface HostContext {
  location?: { directory?: string; project?: { directory?: string } };
  options?: PluginOptions;
  storage: StorageDomain;
  session: SessionDomain;
  // The model catalog (ModelDomain extends ModelApi, v2.3.0
  // packages/plugin/src/promise/plugin.ts:44): the usage read resolves
  // the anchor's model ref against it. Optional like the enhancement
  // domains; without it the usage reads return nothing.
  model?: {
    list(input?: { providerID?: string }): Promise<
      Array<{
        providerID: string;
        id: string;
        modelID: string;
        limit?: { context?: number; input?: number };
      }>
    >;
  };
  tool: {
    transform(
      callback: (editor: { add: (tool: ToolDefinition) => void }) => unknown,
    ): Promise<{ dispose?: () => unknown } | undefined>;
  };
  // The promise adapter's event surface (packages/plugin/src/promise/
  // adapter.ts:331-335 at v2.3.0): an AsyncIterable over the host's event
  // stream, with an optional server-side types filter. The mail pump rides
  // it unfiltered with an abort signal; the reminder's persistence leg
  // rides it types-filtered, the way plan.ts's subscription does.
  event: {
    subscribe(input?: {
      signal?: AbortSignal;
      types?: string[];
    }): AsyncIterable<HostEvent>;
  };
  agent?: AgentDomain;
  skill?: SkillDomain;
  command?: CommandDomain;
}

const STAMP = "chancery";
const DIRECTOR_STAMP = "coordinatedBy";
// The origin declaration (ADR 20261124-session-origin-signal): every
// programmatic spawn declares its origin at create time. The dispatch
// stamps the record beside the coordinator stamp — the memory client
// reads it to register the worker's lineage, while the coordinator
// stamp above stays the mail machinery's key: two stamps, one bag,
// different consumers.
const ORIGIN_STAMP = "chancery_origin";

// The origin record the dispatch declares (ADR
// 20261124-session-origin-signal): a programmatic spawn's create-time
// metadata under `chancery_origin`, initiator "program", parent naming
// the creating session. The memory client parses this shape at its one
// mapping point; the origin contract test ties the producers to the
// consumer across the package boundary.
export function originRecord(parent: string | null): {
  initiator: "program";
  parent: string | null;
} {
  return { initiator: "program", parent };
}

// PRJ-343: the unattended-worker contract. The host's rule evaluation takes
// the LAST matching rule, and a session's own rules merge after its agent's,
// so this stamp converts every ask — the shape that parks unattended turns —
// into allow. It also overrides config-level deny rules for the session; a
// dispatched worker that must respect a deny while running headless is not a
// supported shape, because a deny it may not bypass and an ask it cannot
// answer are indistinguishable from outside the tool fiber.
const UNATTENDED_POLICY: Array<{
  action: string;
  resource: string;
  effect: string;
}> = [{ action: "*", resource: "*", effect: "allow" }];

// The host's session.list is paged; director_sessions walks it. The cap
// keeps a host that keeps serving cursors from spinning the walk forever.
const SESSION_PAGE_CAP = 10;

// Report body size budget (characters), applied where the body is
// rendered — report_read returns it as a tool result, and compaction cuts
// an old tool result to 1,250 characters in the checkpoint (a synthetic
// message, by contrast, is kept verbatim: opencode compaction.ts
// messageToText). A body near that size costs a director's checkpoint
// about what a tool result does, and the wake notice above it is fixed
// and small.
const REPORT_HEAD_CHARS = 1200;
const REPORT_STATUS_CHARS = 300;
const REPORT_BLOCKED_CHARS = 800;

const stampOf = (metadata: any): string | null =>
  metadata?.[STAMP]?.[DIRECTOR_STAMP] || null;

// Exported for the plugin family that reuses this mail leg
// (mail-watcher, PRJ-244): one envelope definition, never a fork. The
// module's own wake notice no longer rides it — a <system-reminder>-only
// user message is exactly what the deployed provider drops to "." (the
// UP-direction note above) — but the export and its output stay
// byte-identical for the family.
export function mailEnvelope(lines: string[]): string {
  return `<system-reminder>\n${lines.join("\n")}\n</system-reminder>`;
}

// The shipped guidance files' frontmatter, parsed strictly. The grammar is
// the subset these files carry — line-based maps indented in two-space
// steps, quoted or bare scalars, numbers, and the folded or literal block
// scalars — and anything else is an error, not a guess. The host never
// re-parses these files (the plugin hands it the parsed values), so this
// parser is the single decoding step and every field it accepts is
// deliberate. Exported for the tests and the package load check.
type FrontmatterValue = string | number | Record<string, FrontmatterValue>;

export class FrontmatterError extends Error {}

export function parseFrontmatter(text: string): {
  data: Record<string, FrontmatterValue>;
  body: string;
} {
  if (!text.startsWith("---\n"))
    throw new FrontmatterError("the file does not open with a --- fence");
  const lines = text.split("\n");
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      close = index;
      break;
    }
  }
  if (close === -1)
    throw new FrontmatterError("the frontmatter fence never closes");
  const data = parseMap(lines.slice(1, close), 0, 0).data;
  return { data, body: lines.slice(close + 1).join("\n") };
}

function parseMap(
  lines: string[],
  start: number,
  indent: number,
): { data: Record<string, FrontmatterValue>; next: number } {
  const data: Record<string, FrontmatterValue> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const lineIndent = indentOf(lines, index);
    if (lineIndent < indent) return { data, next: index };
    if (lineIndent !== indent)
      throw new FrontmatterError(
        `unexpected frontmatter indentation (wanted ${indent}, found ${lineIndent}): ${JSON.stringify(line)}`,
      );
    const entry = parseEntry(line, indent);
    if (entry === null)
      throw new FrontmatterError(
        `unparsable frontmatter line: ${JSON.stringify(line)}`,
      );
    if (entry.block) {
      const [value, consumed] = parseBlockScalar(
        lines,
        index + 1,
        indent,
        entry.block,
      );
      data[entry.key] = value;
      index = consumed;
    } else if (entry.inline === undefined) {
      const nested = parseMap(lines, index + 1, indent + 2);
      data[entry.key] = nested.data;
      index = nested.next;
    } else {
      data[entry.key] = entry.inline;
      index += 1;
    }
  }
  return { data, next: index };
}

function indentOf(lines: string[], index: number): number {
  const line = lines[index];
  const spaces = line.length - line.trimStart().length;
  if (spaces % 2 !== 0)
    throw new FrontmatterError(
      `frontmatter indentation is not a two-space step: ${JSON.stringify(line)}`,
    );
  return spaces;
}

// One `key: value` line. Returns null when the line is not an entry; the
// inline value is undefined when the value continues on deeper lines or in
// a block scalar.
function parseEntry(
  line: string,
  indent: number,
): {
  key: string;
  inline?: FrontmatterValue;
  block?: { marker: ">" | "|"; chomp: "strip" | "clip" };
} | null {
  const rest = line.slice(indent);
  let key: string;
  let after: string;
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const quote = rest[0];
    const end = rest.indexOf(quote, 1);
    if (end === -1) return null;
    key = rest.slice(1, end);
    after = rest.slice(end + 1);
  } else {
    const colon = rest.indexOf(":");
    if (colon === -1) return null;
    key = rest.slice(0, colon);
    after = rest.slice(colon);
  }
  if (!after.startsWith(":")) return null;
  const value = after.slice(1).trim();
  if (value === "") return { key };
  if (value === ">" || value === "|" || value === ">-" || value === "|-") {
    return {
      key,
      block: {
        marker: value[0] as ">" | "|",
        chomp: value.endsWith("-") ? "strip" : "clip",
      },
    };
  }
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return { key, inline: value.slice(1, -1) };
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return { key, inline: Number(value) };
  // A plain scalar: the rest of the line. YAML bars the indicator
  // characters from starting one and reserves " #" for an inline comment;
  // both are errors here rather than reinterpretations.
  if (/^[&*!>%@`#[\]{},]|^-\s/.test(value)) return null;
  if (/(^|\s)#/.test(value)) return null;
  return { key, inline: value };
}

// A block scalar's lines: every line indented deeper than the key (blank
// lines included), stripped of their common indent, then kept (|) or
// folded (>) per the marker. Folding turns the break between two content
// lines into one space and a blank line into a newline; chomping strips
// (-) or clips one trailing newline.
function parseBlockScalar(
  lines: string[],
  start: number,
  keyIndent: number,
  block: { marker: ">" | "|"; chomp: "strip" | "clip" },
): [string, number] {
  let index = start;
  const collected: Array<string | null> = [];
  let contentIndent: number | null = null;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      collected.push(null);
      index += 1;
      continue;
    }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= keyIndent) break;
    contentIndent ??= lineIndent;
    if (lineIndent < contentIndent) break;
    collected.push(line.slice(contentIndent));
    index += 1;
  }
  while (collected.length && collected[collected.length - 1] === null)
    collected.pop();
  let value: string;
  if (block.marker === "|") {
    value = collected.map((line) => line ?? "").join("\n");
  } else {
    value = "";
    let pending = 0;
    for (const line of collected) {
      if (line === null) {
        pending += 1;
        continue;
      }
      if (value === "") value = line;
      else if (pending === 0) value += ` ${line}`;
      else value += `${"\n".repeat(pending)}${line}`;
      pending = 0;
    }
  }
  if (block.chomp === "clip") value += "\n";
  return [value, index];
}

// V1 action names onto the v2 tool actions, the same mapping the host
// applies when it reads a legacy agent file (normalizeAction,
// packages/core/src/v1/config/migrate.ts), so the shipped rules keep
// matching whatever spelling the floor uses.
function normalizeAction(action: string): string {
  if (action === "write" || action === "patch" || action === "apply_patch")
    return "edit";
  if (action === "task") return "subagent";
  if (action === "bash") return "shell";
  return action;
}

export type AgentDefinition = {
  description?: string;
  mode?: string;
  system: string;
  permissions: Array<{ action: string; resource: string; effect: string }>;
  request?: { body?: Record<string, unknown> };
};

// The agent definition file's frontmatter, mapped onto the host's
// Agent.Info fields. The permission map's shape is the legacy one (an
// action to a bare effect, or to a resource/effect map); temperature rides
// the request body overlay the same way the host's own migration puts it.
export function loadAgentDefinition(text: string): AgentDefinition {
  const { data, body } = parseFrontmatter(text);
  const allowed = ["description", "mode", "temperature", "permission"];
  const unknown = Object.keys(data).filter((key) => !allowed.includes(key));
  if (unknown.length)
    throw new FrontmatterError(
      `unknown agent frontmatter fields: ${unknown.join(", ")}`,
    );
  const definition: AgentDefinition = { system: body.trim(), permissions: [] };
  if (data.description !== undefined && typeof data.description !== "string")
    throw new FrontmatterError("description must be a string");
  if (typeof data.description === "string")
    definition.description = data.description;
  if (data.mode !== undefined && typeof data.mode !== "string")
    throw new FrontmatterError("mode must be a string");
  if (typeof data.mode === "string") {
    if (!["primary", "subagent", "all"].includes(data.mode))
      throw new FrontmatterError(`unknown agent mode: ${data.mode}`);
    definition.mode = data.mode;
  }
  const temperature = data.temperature;
  if (temperature !== undefined && typeof temperature !== "number")
    throw new FrontmatterError("temperature must be a number");
  if (temperature !== undefined) definition.request = { body: { temperature } };
  const permissionMap = data.permission;
  if (permissionMap !== undefined) {
    if (typeof permissionMap !== "object" || permissionMap === null)
      throw new FrontmatterError("permission must be a map");
    for (const [action, rule] of Object.entries(permissionMap)) {
      const normalized = normalizeAction(action);
      if (typeof rule === "string") {
        definition.permissions.push({
          action: normalized,
          resource: "*",
          effect: effectOf(rule),
        });
        continue;
      }
      if (typeof rule !== "object" || rule === null)
        throw new FrontmatterError(
          `permission for ${action} must be an effect or a map`,
        );
      for (const [resource, effect] of Object.entries(rule)) {
        if (typeof effect !== "string")
          throw new FrontmatterError(
            `permission effect for ${action} ${resource} must be a string`,
          );
        definition.permissions.push({
          action: normalized,
          resource,
          effect: effectOf(effect),
        });
      }
    }
  }
  return definition;
}

function effectOf(effect: string): string {
  if (!["allow", "deny", "ask"].includes(effect))
    throw new FrontmatterError(`unknown permission effect: ${effect}`);
  return effect;
}

export type SkillDefinition = {
  name: string;
  description?: string;
  body: string;
};

// A skill file's frontmatter: exactly the two fields the shipped skills
// carry. Exported for the tests and the package load check.
export function loadSkillDefinition(text: string): SkillDefinition {
  const { data, body } = parseFrontmatter(text);
  const unknown = Object.keys(data).filter(
    (key) => key !== "name" && key !== "description",
  );
  if (unknown.length)
    throw new FrontmatterError(
      `unknown skill frontmatter fields: ${unknown.join(", ")}`,
    );
  if (typeof data.name !== "string")
    throw new FrontmatterError("skill frontmatter needs a name");
  if (data.description !== undefined && typeof data.description !== "string")
    throw new FrontmatterError("description must be a string");
  const definition: SkillDefinition = { name: data.name, body: body.trim() };
  if (typeof data.description === "string")
    definition.description = data.description;
  return definition;
}

export type CommandFile = {
  name: string;
  description?: string;
  agent?: string;
  template: string;
};

// A command file's frontmatter: exactly description and agent, and the
// body as the prompt template. The file's stem is the command name.
// Exported for the tests and the package load check.
export function loadCommandDefinition(file: string, text: string): CommandFile {
  const { data, body } = parseFrontmatter(text);
  const unknown = Object.keys(data).filter(
    (key) => key !== "description" && key !== "agent",
  );
  if (unknown.length)
    throw new FrontmatterError(
      `unknown command frontmatter fields in ${file}: ${unknown.join(", ")}`,
    );
  if (data.description !== undefined && typeof data.description !== "string")
    throw new FrontmatterError(`${file}: description must be a string`);
  if (data.agent !== undefined && typeof data.agent !== "string")
    throw new FrontmatterError(`${file}: agent must be a string`);
  const definition: CommandFile = {
    name: file.replace(/\.md$/, ""),
    template: body.trim(),
  };
  if (typeof data.description === "string")
    definition.description = data.description;
  if (typeof data.agent === "string") definition.agent = data.agent;
  return definition;
}

function describe(sessionID: string, entry: WorkerEntry | ReportRow): string {
  return `session ${sessionID} "${entry.title}" (${entry.directory || "directory unknown"}), agent ${entry.agent}`;
}

// Delivery claims: worker session plus terminal event id. Every plugin
// activation runs in the host's one JS realm, re-imports on a plugin
// reload included (opencode loads plugins with a plain import() in the
// main context), so one Map on globalThis is shared by all of them and
// survives this module being evaluated again. Claim and check are
// synchronous, so no other activation's handler runs between them. Keys
// are pruned after a day; overlapping activations claim one terminal
// event within seconds of each other.
const CLAIMS = Symbol.for("chancery.director.claims");
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

function claims(): Map<string, number> {
  const host = globalThis as Record<symbol, Map<string, number> | undefined>;
  host[CLAIMS] ??= new Map<string, number>();
  return host[CLAIMS]!;
}

function claimDelivery(key: string): boolean {
  const held = claims();
  const now = Date.now();
  for (const [existing, at] of held) {
    if (now - at >= CLAIM_TTL_MS) held.delete(existing);
  }
  if (held.has(key)) return false;
  held.set(key, now);
  return true;
}

function releaseDelivery(key: string): void {
  claims().delete(key);
}

// A long final text is cut to its head; the worker's last STATUS line and
// last BLOCKED paragraph ride verbatim ahead of it unless the head already
// holds them, and a pointer names where the full text and the work itself
// can be read. Lengths and the cut count are UTF-16 code units (JavaScript
// string length).
function reportBody(
  sessionID: string,
  entry: WorkerEntry | ReportRow,
  text: string,
): string[] {
  if (text.length <= REPORT_HEAD_CHARS) return [text];
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const span = (from: number, to: number) => ({
    start: starts[from],
    text: lines.slice(from, to + 1).join("\n"),
  });
  const statusAt = lines.findLastIndex((line) => /^\s*STATUS:/.test(line));
  const blockedAt = lines.findLastIndex((line) => /^\s*BLOCKED\b/.test(line));
  const where = entry.directory || "the worker's directory";
  // A turn that carried neither marker renders its ENDING, not its head.
  // The ending is the completion evidence — a mid-flow cut ends
  // mid-sentence there — while a head cut lands mid-word and mimics the
  // truncation it should reveal (PRJ-499).
  if (statusAt === -1 && blockedAt === -1) {
    const tail = cutTail(text, REPORT_HEAD_CHARS);
    const notShown = text.length - tail.length;
    return [
      tail,
      "",
      `[… ${notShown} more UTF-16 code units at the start not shown. Full text: opencode session export ${sessionID}. The work itself is in ${where}.]`,
    ];
  }
  let blocked: { start: number; text: string } | undefined;
  if (blockedAt !== -1) {
    const end = lines.findIndex(
      (line, index) => index > blockedAt && !line.trim(),
    );
    blocked = span(blockedAt, end === -1 ? lines.length - 1 : end - 1);
  }
  // A STATUS line inside the shown part of the BLOCKED paragraph is
  // already shown there.
  const insideBlocked =
    blocked &&
    statusAt >= blockedAt &&
    starts[statusAt] + lines[statusAt].length <=
      blocked.start + cutAt(blocked.text, REPORT_BLOCKED_CHARS).length;
  const status =
    statusAt === -1 || insideBlocked ? undefined : span(statusAt, statusAt);

  const head = cutAt(text, REPORT_HEAD_CHARS);
  const kept: string[] = [];
  let shownPastHead = 0;
  const pairs: Array<[{ start: number; text: string } | undefined, number]> = [
    [status, REPORT_STATUS_CHARS],
    [blocked, REPORT_BLOCKED_CHARS],
  ];
  for (const [part, limit] of pairs) {
    if (!part) continue;
    // What would be shown is already inside the head: skip it, whether or
    // not the whole part ends there.
    const shown = cutAt(part.text, limit);
    if (part.start + shown.length <= head.length) continue;
    kept.push(shown.length < part.text.length ? `${shown}…` : shown);
    shownPastHead += Math.max(
      0,
      part.start + shown.length - Math.max(part.start, head.length),
    );
  }
  const notShown = Math.max(0, text.length - head.length - shownPastHead);
  return [
    ...kept,
    ...(kept.length ? [""] : []),
    head,
    "",
    `[… ${notShown} more UTF-16 code units not shown. Full text: opencode session export ${sessionID}. The work itself is in ${where}.]`,
  ];
}

// A cut never ends between the two halves of a surrogate pair.
function cutAt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const last = text.charCodeAt(limit - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

// A tail cut never starts between the two halves of a surrogate pair.
function cutTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const start = text.length - limit;
  const first = text.charCodeAt(start);
  return text.slice(first >= 0xdc00 && first <= 0xdfff ? start - 1 : start);
}

// The pump sees only live events, so an activation that adopted a worker
// on a text block, after its turn started, holds only the text after it.
const PARTIAL_LINE = (sessionID: string): string =>
  `PARTIAL: this report began mid-turn; text from before it is missing. Full text: opencode session export ${sessionID}.`;

// The report store: one row per terminal event, keyed
// report/<director>/<worker>/<terminal event id> in ctx.storage — the
// plugin-scoped view of the host's kv table, which survives a plugin
// reload and a host restart. The delivery claim serializes writers, so
// the first claimant's row stands and a later activation for the same
// terminal event never reaches a store call.
const REPORT_PREFIX = "report/";
const KINDS: Record<string, string> = {
  report: "Worker turn report",
  failed: "Worker turn NOT COMPLETED (turn-not-completed)",
  interrupted: "Worker turn interrupted (no recorded reason)",
  truncated: "Worker turn TRUNCATED (final step produced no text)",
};

// Read rows are the director's own trail; a week of them answers "what
// did this worker say" without the session export. Pruned on the next
// store for the same director, so the walk stays one director's prefix.
const READ_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Unread rows carry no expiry — pending mail is never aged out — but a
// director that never pulls cannot grow the store without bound. Past
// this cap the oldest rows go, oldest first, on the next store for the
// same director.
const DIRECTOR_ROW_CAP = 100;

// One prefix walk over ctx.storage, sorted keys, page-capped. Shared by
// the report ledger and the manifest surface (PRJ-393): one walk, never a
// fork. The label names the caller's surface in the truncation log.
const SCAN_PAGE = 500;
const SCAN_PAGE_CAP = 20;

async function scanRows(
  storage: StorageDomain,
  prefix: string,
): Promise<{
  rows: Array<{ key: string; value: unknown }>;
  truncated: boolean;
}> {
  const rows: Array<{ key: string; value: unknown }> = [];
  let after: string | undefined;
  for (let page = 0; page < SCAN_PAGE_CAP; page += 1) {
    const result = await storage.scan({ prefix, after, limit: SCAN_PAGE });
    rows.push(...result.entries);
    after = result.next;
    if (!after) return { rows, truncated: false };
  }
  console.error(
    `[director] scan under ${prefix} stopped at the ${SCAN_PAGE_CAP}-page cap with a cursor pending; the result is truncated`,
  );
  return { rows, truncated: true };
}

// PRJ-393 review 225: the manifest surface never acts on a partial row
// set. A scan truncated at the report walk's cap would drop superseding
// rows beyond the cursor and republish the facts they retired — the
// outcome the tombstone machinery exists to prevent — and since manifest
// rows are never pruned, that cap is a destination, not a safety valve.
// The manifest's scans therefore walk to exhaustion, with the page cap
// as the loop bound rather than a stop, and the bound raised (10,000
// pages, five million rows) far past what a real manifest reaches so
// exhaustion is the normal exit. A host that keeps serving cursors past
// the bound fails the call with a named error, never a silent partial
// compose. The report leg keeps the stopping scanRows: its rows are
// pruned and capped, so truncation there is a bounded, stated condition.
const MANIFEST_SCAN_PAGE_CAP = 10000;

// PRJ-472: worktree_remove's live-session check never acts on a partial
// session list either. The check exists because a live session in the
// tree must stop the removal, so a walk that stopped at a page cap with
// a cursor pending is not a safe refusal: it is the check failing while
// looking like one (2026-11-21: two removals refused because the host's
// session list had outgrown 10 pages). Its walk goes to exhaustion like
// the manifest's scans, with the page cap as the loop bound, and a host
// still serving cursors past the bound fails named. director_sessions
// keeps its stopping walk: honest truncation is the right shape for
// discovery, which claims nothing by what it reached.
const LIVE_SESSION_PAGE_CAP = 10000;

async function scanEveryRow(
  storage: StorageDomain,
  prefix: string,
): Promise<Array<{ key: string; value: unknown }>> {
  const rows: Array<{ key: string; value: unknown }> = [];
  let after: string | undefined;
  for (let page = 0; page < MANIFEST_SCAN_PAGE_CAP; page += 1) {
    const result = await storage.scan({ prefix, after, limit: SCAN_PAGE });
    rows.push(...result.entries);
    after = result.next;
    if (!after) return rows;
  }
  throw new Error(
    `[director] manifest scan under ${prefix} did not exhaust within the ${MANIFEST_SCAN_PAGE_CAP}-page cap; refusing to act on a partial row set`,
  );
}

function decodeRow(entry: { value: unknown }): ReportRow | null {
  const row = entry.value;
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  return typeof record.worker === "string" &&
    typeof record.text === "string" &&
    typeof record.created === "number"
    ? (record as ReportRow)
    : null;
}

async function storeReport(
  ctx: HostContext,
  director: string,
  worker: string,
  eventID: string | null | undefined,
  kind: string,
  entry: WorkerEntry,
  text: string,
): Promise<void> {
  const row: ReportRow = {
    to: director,
    worker,
    eventID: eventID || null,
    kind,
    title: entry.title,
    directory: entry.directory,
    agent: entry.agent,
    reason: entry.reason ?? null,
    partial: Boolean(entry.midTurn),
    text,
    created: Date.now(),
    read: false,
  };
  await ctx.storage.set(
    `${REPORT_PREFIX}${director}/${worker}/${eventID || `noid-${row.created}-${Math.random().toString(36).slice(2, 8)}`}`,
    row,
  );
  try {
    const scan = await scanRows(ctx.storage, `${REPORT_PREFIX}${director}/`);
    const cutoff = row.created - READ_RETENTION_MS;
    const kept: Array<{ key: string; row: ReportRow }> = [];
    for (const found of scan.rows) {
      const old = decodeRow(found);
      if (!old) continue;
      if (old.read && (old.readAt ?? old.created) < cutoff) {
        await ctx.storage.remove(found.key);
        continue;
      }
      kept.push({ key: found.key, row: old });
    }
    // The cap bounds a never-pulling director: past it, the oldest
    // surviving rows (read or unread) go.
    if (kept.length > DIRECTOR_ROW_CAP) {
      kept.sort(
        (a, b) =>
          a.row.created - b.row.created ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      );
      for (const drop of kept.slice(0, kept.length - DIRECTOR_ROW_CAP))
        await ctx.storage.remove(drop.key);
      console.error(
        `[director] report store for ${director} passed its ${DIRECTOR_ROW_CAP}-row cap; ${kept.length - DIRECTOR_ROW_CAP} oldest rows dropped`,
      );
    }
  } catch (error) {
    // Pruning is hygiene, never delivery: a failed sweep leaves the new
    // row stored and the notice on its way.
    console.error(`[director] read-row prune failed: ${error}`);
  }
}

async function unreadReports(
  ctx: HostContext,
  director: string,
): Promise<{
  unread: Array<{ key: string; row: ReportRow }>;
  truncated: boolean;
}> {
  const scan = await scanRows(ctx.storage, `${REPORT_PREFIX}${director}/`);
  const unread: Array<{ key: string; row: ReportRow }> = [];
  for (const found of scan.rows) {
    const row = decodeRow(found);
    if (row && row.read === false) unread.push({ key: found.key, row });
  }
  unread.sort(
    (a, b) =>
      a.row.created - b.row.created ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return { unread, truncated: scan.truncated };
}

// The worker contract's completion marker, anywhere in the turn's text —
// the same line reportBody's keep rules look for.
const hasStatusLine = (text: string): boolean => /^\s*STATUS:/m.test(text);

// The pulled body: the kind header, the worker/session line, the PARTIAL
// label when the storing activation joined mid-turn, and the text under
// today's cap rules. Worker text enters the model here and only here —
// as a tool result.
function renderReportBody(row: ReportRow): string {
  const lines = [KINDS[row.kind] || KINDS.report, describe(row.worker, row)];
  if ((row.kind === "failed" || row.kind === "truncated") && row.reason)
    lines.push(`reason: ${row.reason}`);
  if (row.kind === "interrupted")
    lines.push(
      "",
      "The turn was interrupted with no recorded reason, as a host shutdown is. The host may resume it after a restart; if resumed, it reports when it ends. A worker that stays busy across a restart may never report, so check its session (director_worker_status) before re-dispatching or steering it.",
      `Full text: opencode session export ${row.worker}.`,
    );
  if (row.kind === "failed")
    lines.push(
      "",
      "The worker's turn did not complete. Treat its outputs as unverified.",
    );
  if (row.kind === "truncated")
    lines.push(
      "",
      "The turn's final step ended with no text and no tool call — a provider cut mid-execution produces exactly this shape. Treat the turn's outputs as unverified.",
    );
  if (row.kind === "report" && row.text && !hasStatusLine(row.text))
    lines.push(
      "",
      "note: the turn filed as succeeded but its final text carries no STATUS line — the worker's completion signal is missing.",
    );
  if (row.partial) lines.push(PARTIAL_LINE(row.worker));
  lines.push(
    "",
    ...(row.text
      ? reportBody(row.worker, row, row.text)
      : ["(no final text from this turn reached the report)"]),
  );
  return lines.join("\n");
}

// The wake notice: fixed apart from the worker session id, the unread
// count, and the worker's context share when it is past the threshold.
// It is sent as a plain-text synthetic on purpose — see the
// UP-direction note in the header — with the description and metadata
// pair that renders it as a "◈ Notice" row.
const NOTICE_DESCRIPTION = "Director module: worker report ready to read";
const NOTICE_SOURCE = "director";

function noticeText(worker: string, unread: number, share?: number): string {
  const noun = unread === 1 ? "report" : "reports";
  const base = `Worker turn report filed by session ${worker}: ${unread} ${noun} unread for you. Call the report_read tool to read ${unread === 1 ? "it" : "them"}.`;
  if (share === undefined) return base;
  return `${base} Its context is at ${Math.round(share * 100)}% of its model's window; start its next slice in a fresh session — state rides the manifest.`;
}

// PRJ-525: a watched worker's context usage rides the host's event
// stream. The host emits one session.step.started and one
// session.step.ended per provider step (v2.3.0
// packages/schema/src/session-event.ts): the start carries the model ref
// the step is measured under, the end carries the step's full
// TokenUsage.Info, and the TUI's footer computes the same tokens +
// percent pair from the ended event instead of replaying anything
// (v2.3.0 packages/tui/src/mini/stream-v2.transport.ts). Per-step
// composes to per-turn: a turn's last step is the transcript's newest
// tokened assistant anchor, so the newest step.ended per session carries
// what the transcript's findLast would have found. The pump records the
// newest usable sample per watched worker, and the reads below use the
// recorded sample without touching the transcript while one exists. The
// one transcript read left is the restart fallback: after a host
// restart the plugin's memory is empty, so the first read for a session
// replays the transcript once — the same anchor walk PRJ-522 used — and
// the stream re-arms from there.
//
// Measurement is still the way compaction measures it (PRJ-522): the
// anchor measure is input + cache.read + cache.write + output +
// reasoning (v2.3.0 packages/core/src/session/compaction.ts:1153), taken
// from the anchor hasMeasuredPrompt accepts (:1194): assistant, no
// error, tokens present, prompt tokens above zero — on the event path
// the same prompt-tokens-above-zero test keeps a zero-token step from
// overwriting a good sample. The window is the model's limit, sized the
// same way compaction sizes a request (inputWindow, :1185): the smaller
// of input and context when both are set, else whichever exists. The
// model is resolved from the sample's own ref — the ref the tokens were
// measured under — against the host's catalog (ModelDomain,
// packages/plugin/src/promise/plugin.ts:44). Every absence or failure —
// no sample, a spent fallback, unreadable transcript, no tokened
// anchor, model not in the catalog, unknown window — returns undefined:
// the callers render nothing rather than guess, and the read never
// throws.

// One step's measurement, recorded by the pump and replayed by the
// reads: the raw TokenUsage.Info the step ended with, and the model ref
// the step started under.
type UsageSample = {
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  model: { providerID: string; id: string };
};

type ContextUsage = {
  tokens: number;
  window: number;
  share: number;
};

// The operator's number (PRJ-522): a worker at or past this share of
// its model's window shows in the wake notice (the gate is
// `share >= CONTEXT_WARN_SHARE`, inclusive). A constant, not a config
// option, until a second number is wanted.
const CONTEXT_WARN_SHARE = 0.5;

const promptTokensOf = (tokens: {
  input: number;
  cache?: { read?: number; write?: number };
}): number =>
  tokens.input + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);

const sumTokensOf = (tokens: {
  input: number;
  output: number;
  reasoning: number;
  cache?: { read?: number; write?: number };
}): number =>
  (tokens.input ?? 0) +
  (tokens.cache?.read ?? 0) +
  (tokens.cache?.write ?? 0) +
  (tokens.output ?? 0) +
  (tokens.reasoning ?? 0);

// The transcript read: the restart fallback's anchor walk, unchanged
// from PRJ-522. The tokens-null guard and the prompt-tokens test are the
// anchor's own usability rule; the ref guards keep a message without a
// usable model ref from seeding a sample.
async function transcriptSample(
  ctx: HostContext,
  sessionID: string,
): Promise<UsageSample | undefined> {
  if (typeof ctx.session?.context !== "function") return undefined;
  let messages: any[];
  try {
    messages = await ctx.session.context({ sessionID });
  } catch (error) {
    console.error(`[director] context read for ${sessionID} failed: ${error}`);
    return undefined;
  }
  if (!Array.isArray(messages)) return undefined;
  // The anchor guard mirrors compaction's hasMeasuredPrompt plus the
  // deployed schema's encoding (TokenUsage.Info): tokens ride as an
  // object with a numeric input or not at all. A `tokens: null` row is
  // an unmeasured message, not a zero-token one — skipped here rather
  // than fed to a read of its fields.
  const anchor = messages.findLast(
    (message) =>
      message?.type === "assistant" &&
      !message.error &&
      message.tokens !== null &&
      typeof message.tokens === "object" &&
      typeof message.tokens.input === "number" &&
      promptTokensOf(message.tokens) > 0,
  );
  if (!anchor) return undefined;
  const tokens = anchor.tokens;
  const ref = anchor.model;
  if (typeof ref?.providerID !== "string" || typeof ref?.id !== "string")
    return undefined;
  return {
    tokens: {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cache: {
        read: tokens.cache?.read ?? 0,
        write: tokens.cache?.write ?? 0,
      },
    },
    model: { providerID: ref.providerID, id: ref.id },
  };
}

// The window: the model's limit sized the way compaction sizes a
// request, resolved from the sample's own ref against the host's
// catalog. The catalog read happens per usage read, the way the old
// transcript read's did — the window tracks the catalog, not the sample.
async function measureUsage(
  ctx: HostContext,
  sample: UsageSample,
  sessionID: string,
): Promise<ContextUsage | undefined> {
  const measured = sumTokensOf(sample.tokens);
  if (!ctx.model || typeof ctx.model.list !== "function") return undefined;
  let models;
  try {
    models = await ctx.model.list();
  } catch (error) {
    console.error(
      `[director] model catalog read for ${sessionID} failed: ${error}`,
    );
    return undefined;
  }
  if (!Array.isArray(models)) return undefined;
  const model = models.find(
    (row) =>
      row?.providerID === sample.model.providerID &&
      (row?.id === sample.model.id || row?.modelID === sample.model.id),
  );
  const limit = model?.limit;
  const window =
    limit?.input && limit?.context
      ? Math.min(limit.input, limit.context)
      : (limit?.context ?? limit?.input);
  if (!window || window <= 0) return undefined;
  return { tokens: measured, window, share: measured / window };
}

// Epoch-millis comparison for time.busy versus time.idle: "busy" means the
// most recent execution started after the previous one ended. The wire
// shape is epoch millis; the strings branch keeps a datetime-formatted row
// from misreading as a tiny epoch.
function epoch(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value === "") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stateOf(info: unknown): "busy" | "idle" {
  const time =
    ((info as { time?: unknown } | null | undefined)?.time as
      | { busy?: unknown; idle?: unknown }
      | undefined) || {};
  const busy = epoch(time.busy);
  const idle = epoch(time.idle);
  // While an execution runs, idle holds the previous execution's end, so the
  // comparison (not an is-null check) is what separates busy from idle.
  const running = busy !== undefined && (idle === undefined || busy >= idle);
  return running ? "busy" : "idle";
}

// The reply's structured half. Every tool in this module returns its reply
// as both the content text (JSON, for a native tool-call caller) and this
// declared output value. The declaration is what carries the reply across
// the host's two callers: the CodeMode bridge
// (packages/core/src/codemode/tool.ts, resultValue) hands a script caller
// `executed.output` only when the tool declares an output schema, and the
// raw content text otherwise — text a script caller reading `.sessionID`
// off it sees as object-less, the silent misread PRJ-523 recorded. The
// schema itself stays permissive on purpose: the reply shapes are the
// tests' contract, not a runtime validation cliff.
const REPLY_OUTPUT = { type: "object", additionalProperties: true };

const dispatchSchema = {
  type: "object",
  properties: {
    directory: {
      type: "string",
      description:
        "Absolute path of the worktree directory the worker session runs in.",
    },
    brief: {
      type: "string",
      description:
        "The work brief delivered verbatim as the worker's waking prompt.",
    },
    agent: {
      type: "string",
      description: "Agent the worker runs as. Default: build.",
    },
    title: {
      type: "string",
      description:
        "Slice name for the session. Derived from the brief when omitted.",
    },
    model: {
      type: "string",
      description:
        'Model the worker runs on, an opencode model reference "provider/model" with an optional "#variant"; the model id may carry slashes and colons (e.g. "example-proxy/auto/example-model", "kilo/baidu/ernie-5.5-preview:free"). Omitted: the host catalog default decides.',
    },
    base: {
      type: "string",
      description:
        'The commit the target worktree\'s HEAD must be at — a ref ("origin/main", a branch name) or a sha. When given, the dispatch validates the worktree at the call and refuses the mismatch named (not a worktree, a detached HEAD, or a HEAD not at this base, both commits named) instead of a worker discovering the staleness mid-turn; the result and the tracking row carry the worktree it validated. Omitted: no validation.',
    },
  },
  required: ["directory", "brief"],
  additionalProperties: false,
};

const steerSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string", description: "The worker session to steer." },
    instruction: {
      type: "string",
      description: "Delivered verbatim as the session's waking prompt.",
    },
  },
  required: ["sessionID", "instruction"],
  additionalProperties: false,
};

const statusSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string", description: "The worker session to read." },
  },
  required: ["sessionID"],
  additionalProperties: false,
};

// Budgets are numbers, not strings: the caller states caps, never free
// text, and the tool clamps rather than parsing.
const readSchema = {
  type: "object",
  properties: {
    limit: {
      type: "number",
      description:
        "Most reports returned in one call, 1–20. Default 5. The rest stay unread for the next call.",
    },
    maxChars: {
      type: "number",
      description:
        "Character budget over the returned bodies, 200–100000. Default 4000. The first unread report is always returned; later ones stop at the budget.",
    },
  },
  additionalProperties: false,
};

// The per-turn delegation reminder (PRJ-519): agents holding the director
// lane forget to hand work off and start implementing in their own session.
// It is a reminder, not a block: coordination bookkeeping in the director
// session (manifests, report reading, PR text) stays legitimate work there.
//
// The mechanism (PRJ-534): the built-in plan plugin's reminder mechanism,
// mirrored against packages/core/src/plugin/plan.ts at v2.3.0. Two legs:
//
// - Persistence. An event subscription over session.created and
//   session.agent.selected stores the enter reminder as a host synthetic
//   with resume:false (the host admits the synthetic and gates the wake on
//   resume !== false, packages/core/src/session/session.ts:286-310 at
//   v2.3.0; the promise adapter's synthetic endpoint carries the flag, in
//   the protocol's session.synthetic request schema). A stored reminder
//   rides the transcript into every model window with no wake and no empty
//   turn — the transcript carries it, not the hook.
// - Reconcile. The context hook — the host's model-request assembly hook —
//   re-checks the window per model call and splices what the window lost
//   (compaction and committed reverts can strip reminders while the
//   session's agent stays put): the enter reminder when the agent is the
//   director and the window lacks it, a leave line when the agent moved
//   off the director and the window still holds it. What it splices, it
//   persists the same way, so the splice survives the next window too.
//   plan.ts's reconcile is this same hook, with the same position rule:
//   before a user-role tail, else appended at the window's end.
//
// Provenance, stated so the mechanism's own history is honest: PRJ-529's
// splice-only era assumed the context hook never fired for a scanned
// promise-adapter plugin — the deployed 2.3.0 host disproves that. Live
// probes at the deployed binary (2026-11-25): a minimal probe plugin's
// context registration fired twice per turn, and this module's splice
// delivered correctly in a fresh location under the director agent
// (an observer hook registered after it read the reminder back out of the
// assembled window). Prompt and context hooks share one registry and one
// trigger path; plugin hook registrations persist on the plugin
// activation's scope, not a per-request one. What the probes leave open:
// the live TUI director session's delivery gap is real (the model's own
// turn report confirmed its windows lacked the reminder after the serve
// restart) but unexplained — its registration state lives in the serve's
// memory, unreadable from outside. The persistence leg is what makes
// delivery independent of that state: the reminder is in the transcript
// before any hook must fire, and the reconcile only covers windows that
// lost it. The splice-era deduction-by-exact-text is retired with the
// era: the reconcile's scan of the window is the dedupe, exactly plan.ts's
// lastReminder — any user-role message whose one text part is the enter
// or leave text counts, copies the old persisting mechanism left in
// stored history included, with no special-casing.
const REMINDER = `<system-reminder>
Director session: the lane is coordination. Slice the objective and hand each slice to a worker — dispatch (director_dispatch), steer (director_steer), verify the worker's claims yourself from the worktree and command output, ship under the standing grant, report. Edits in this session are for coordination bookkeeping only (manifests, worker-report reading, PR text); verification reads, gate runs, and the briefs you dispatch with are yours. Implementation edits are not, and neither is research — open-ended investigation to answer a question, design recon, archaeology — put the work in a worker's hands.
</system-reminder>`;

// The stale-reconcile's neutralizing line, plan.ts's leave as the model:
// the reminder text is addressed to the director lane, so a window that
// still carries it after the session's agent moved off the director gets
// this line spliced and persisted in its place.
const LEAVE = `<system-reminder>
You are no longer the director lane's coordinator. The previous delegation reminder no longer applies: nothing here asks you to dispatch or steer workers, and the session's edit restrictions tied to that reminder are lifted.
</system-reminder>`;

// The reconcile's window scan, plan.ts's lastReminder as the model: the
// newest reminder in the window, enter or leave, by exact text. The scan
// is the dedupe — a window carrying either copy counts as carried, and
// nothing is special-cased by age or origin.
function lastReminder(
  messages: Array<{
    role: string;
    content: Array<{ type: string; text?: string }>;
  }>,
): string | undefined {
  return messages.reduce<string | undefined>((found, message) => {
    const part =
      message.role === "user" && message.content?.length === 1
        ? message.content[0]
        : undefined;
    if (part?.type !== "text") return found;
    return part.text === REMINDER || part.text === LEAVE ? part.text : found;
  }, undefined);
}

// The persistence trigger's reminder choice, plan.ts's switchReminder as
// the model: the enter reminder on a session created as the director or
// switched onto the director, the leave line on a switch off it, nothing
// otherwise.
function switchReminder(event: HostEvent): string | undefined {
  const data = event.data ?? {};
  if (event.type === "session.created") {
    if (data.agent !== "director") return undefined;
    return REMINDER;
  }
  if (event.type !== "session.agent.selected") return undefined;
  if (data.agent === data.previous) return undefined;
  if (data.agent === "director") return REMINDER;
  if (data.previous === "director") return LEAVE;
  return undefined;
}

const setup = async (ctx: HostContext): Promise<() => void> => {
  // The debug switch rides the plugin options (the object-form config
  // entry); a discovered plugin carries none, so it defaults off. The
  // module doesn't read the environment: a client runs with whatever its
  // editor was launched from, so a deployment that wants this set lists
  // the plugin in its config.
  const configLevel = String(ctx.options?.logLevel ?? "").toLowerCase();
  const debug = (op: string, attrs: Record<string, unknown>): void => {
    if (configLevel !== "debug") return;
    const parts = Object.entries(attrs).map(
      ([key, value]) => `${key}=${value}`,
    );
    console.error(
      `${new Date().toISOString()} level=debug op=${op} ${parts.join(" ")}`,
    );
  };

  // The director's guidance surface rides the package beside the module:
  // the agent definition, the three orchestration skills, and the two
  // commands. This block registers all of it, so a deployment links one
  // folder and the host gets the whole surface. Registration is an
  // enhancement, not a load requirement. The tools and the mail leg run
  // without these domains (a host whose surface lacks one, and the tests'
  // fake, carry none). A missing domain or a malformed file gets logged
  // and skipped; the load doesn't fail. The files resolve beside the
  // module, which is why the packaged artifact must mirror the source
  // layout (package.nix).
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  // The definition's permission entries, kept for the permission
  // re-assert below. Empty when the agent file failed to load: the
  // re-assert then has nothing to re-assert and doesn't register
  // anything.
  let directorPermissions: AgentDefinition["permissions"] = [];
  try {
    const definition = loadAgentDefinition(
      readFileSync(join(moduleDir, "agent", "director.md"), "utf8"),
    );
    directorPermissions = definition.permissions;
    await ctx.agent?.transform((editor) => {
      // The upsert is the host's contract: update creates the agent from
      // Info.default(id) when the id is missing, then applies the
      // callback (the update branch in packages/core/src/agent.ts;
      // upstream #45841). The file link that used to guarantee the agent
      // is gone, so this registration is the agent's only path into a
      // deployment.
      editor.update("director", (agent: any) => {
        if (definition.description !== undefined)
          agent.description = definition.description;
        if (definition.mode !== undefined) agent.mode = definition.mode;
        agent.system = definition.system;
        // The rules land after the host's default set, and the host
        // evaluates last-match-wins (Permission.evaluate takes the last
        // rule matching the action and resource, in
        // packages/core/src/permission.ts), so the shipped denies hold. A
        // consumer's own agents.director rules load after configured
        // plugins and land after these, so the consumer wins per rule.
        agent.permissions.push(...definition.permissions);
        if (definition.request && agent.request)
          Object.assign(agent.request.body, definition.request.body);
      });
      // Inside the transform: a host without the domain doesn't run it,
      // so the span cannot claim a registration that did not happen.
      debug("agent.registered", {});
    });
  } catch (error) {
    console.error(`[director] agent registration skipped: ${error}`);
  }

  try {
    const skills = ["orchestrate", "dispatch-worker", "steer-worker"].map(
      (id) => {
        const path = join(moduleDir, "skills", id, "SKILL.md");
        return {
          id,
          path,
          skill: loadSkillDefinition(readFileSync(path, "utf8")),
        };
      },
    );
    await ctx.skill?.transform((editor) => {
      for (const { id, path, skill } of skills) {
        editor.add({
          id,
          name: skill.name,
          ...(skill.description === undefined
            ? {}
            : { description: skill.description }),
          path,
          content: skill.body,
        });
        debug("skill.registered", { id });
      }
    });
  } catch (error) {
    console.error(`[director] skill registration skipped: ${error}`);
  }

  try {
    const commands = ["drive-project.md", "status-report.md"].map((file) => {
      const path = join(moduleDir, "commands", file);
      return loadCommandDefinition(file, readFileSync(path, "utf8"));
    });
    await ctx.command?.transform((editor) => {
      for (const command of commands) {
        editor.add({
          name: command.name,
          ...(command.description === undefined
            ? {}
            : { description: command.description }),
          execute: async (invocation) => {
            const arguments_ =
              typeof invocation.prompt?.text === "string"
                ? invocation.prompt.text
                : "";
            if (command.agent !== undefined && ctx.session.switchAgent) {
              // The absent domain is the documented degrade: the prompt
              // fires for the session's current agent. A failed switch is
              // not a degrade; it propagates and the command fails named,
              // instead of running its template as the wrong agent.
              await ctx.session.switchAgent({
                sessionID: invocation.sessionID,
                agent: command.agent,
              });
            }
            await ctx.session.prompt({
              sessionID: invocation.sessionID,
              // The function replacement form: a string replacement honors
              // the $$ and $& patterns, and an argument carrying them
              // would reach the director rewritten.
              text: command.template.replaceAll("$ARGUMENTS", () => arguments_),
              ...(invocation.delivery === undefined
                ? {}
                : { delivery: invocation.delivery }),
            });
          },
        });
        debug("command.registered", { name: command.name });
      }
    });
  } catch (error) {
    console.error(`[director] command registration skipped: ${error}`);
  }

  // PRJ-469: the permission re-assert. A plugin-registered agent's own
  // rules land before the config-level rules, because the host replays
  // agent transforms in registration order and the config agent plugin
  // (post-internal, packages/core/src/plugin/internal.ts) registers after
  // every external plugin — so on the merged array a config-level
  // wildcard deny is the last matching rule and tool.ts whollyDisabled()
  // strips the tools from the director agent's catalog, on every opencode
  // version (byte-identical v2.2.5 through dev). A markdown-file agent
  // gets its own rules appended after the config ones and wins; the
  // director agent, registered by this plugin, does not.
  //
  // The correction re-asserts the parity the file agent gets. The
  // session.prompt hook fires inside the prompt request — awaited, before
  // admission and wake, so before the runner builds the first tool
  // snapshot (packages/core/src/session/prompt.ts; the runner's drain
  // starts one tick after wake) — and inside it this activation registers
  // a NEW agent transform. Transforms replay in registration order on
  // every agent-state rebuild, so one registered after the config
  // plugin's appends the definition's rules last on every rebuild,
  // forever: the definition's allows become the last matching rule and
  // the tools survive the strip check. The registration is one-time per
  // activation: the handler flips the flag synchronously, before the
  // awaited transform, and resets it in the catch, so the check-and-set
  // runs in the handler fiber across no await — two concurrent first
  // prompts cannot both register. A failed transform retries on the next
  // prompt when prompts don't overlap; a prompt firing while a failing
  // transform is still in flight sees the flag set and skips, so its
  // retry lands on the prompt after next. A plugin reload brings a fresh
  // activation whose own first prompt registers its own transform —
  // duplicate rules are harmless under last-match-wins. A host without
  // the prompt hook logs the error below once at registration and skips
  // the re-assert; a host with the hook but no agent domain to transform
  // returns silently per prompt, where a per-prompt log would spam. The
  // strip stands as before this fix either way.
  let reasserted = false;
  let hookRegistration: { dispose: () => Promise<void> } | undefined;
  try {
    if (!ctx.session?.hook) {
      console.error(
        `[director] permission re-assert unavailable: the host session domain doesn't have a prompt hook, so the re-assert can't register — the config floor's deny keeps stripping the write-half tools from the director agent`,
      );
    }
    hookRegistration =
      (await ctx.session?.hook?.("prompt", async () => {
        if (!ctx.agent || reasserted || directorPermissions.length === 0)
          return;
        // The flag flips before the await: the check-and-set is
        // synchronous in this fiber, so a concurrent prompt sees it set.
        reasserted = true;
        try {
          await ctx.agent.transform((editor) => {
            editor.update("director", (agent: any) => {
              agent.permissions.push(...directorPermissions);
            });
          });
          debug("agent.permissions.reasserted", {});
        } catch (error) {
          reasserted = false;
          // Not flagged as reasserted: the next prompt retries. A
          // persistent failure logs once per prompt, which is the
          // visible shape of a broken re-assert.
          console.error(`[director] permission re-assert failed: ${error}`);
        }
      })) ?? undefined;
  } catch (error) {
    console.error(
      `[director] permission re-assert registration skipped: ${error}`,
    );
  }

  // The per-turn delegation reminder (PRJ-519), inline so the entry stays a
  // single self-contained file: the mail-watcher package materializes this
  // module verbatim and alone, so nothing the entry imports may live outside
  // its own bytes. Same degrade as the other registrations.
  //
  // The reconcile leg: the context hook re-checks the window per model
  // call and splices what it lost, the way plan.ts's reconcile does. What
  // it splices it persists with resume:false, so the reminder survives the
  // next window too. Both the reminder and the leave line ride as
  // user-role messages in the LLM transcript's {role, content} form —
  // content as a parts array, the form the request builder consumes. No
  // id on the spliced message: the host's own splice sets none and
  // nothing downstream reads ours — the dedupe is by exact text.
  let reminderRegistration: { dispose: () => Promise<void> } | undefined;
  try {
    reminderRegistration =
      (await ctx.session?.hook?.("context", async (context) => {
        try {
          const reminder = lastReminder(context.messages);
          const missing = context.agent === "director" && reminder !== REMINDER;
          const stale = context.agent !== "director" && reminder === REMINDER;
          const text = missing ? REMINDER : stale ? LEAVE : undefined;
          if (!text) return;

          // plan.ts's position rule: before the user's prompt when the
          // window ends in one, else appended at the window's end (a
          // continuation step after tool results). The splice shape is the
          // LLM transcript's {role, content} form — content as a parts
          // array, the form toLLMMessages emits and the request builder
          // consumes.
          const at =
            context.messages.at(-1)?.role === "user"
              ? context.messages.length - 1
              : context.messages.length;
          context.messages.splice(at, 0, {
            role: "user",
            content: [{ type: "text", text }],
          });

          // Persist what was spliced, resume:false — the transcript
          // carries it into the next window without a wake (the host
          // gates the wake on resume !== false). Its own catch: the
          // splice already landed in this window; a failed store must
          // not turn the reconciled window into a failed request.
          try {
            await ctx.session?.synthetic?.({
              sessionID: context.sessionID,
              text,
              resume: false,
            });
          } catch (error) {
            console.error(
              `[director] reminder persistence for ${context.sessionID} failed: ${error}. This window keeps the spliced copy.`,
            );
          }
        } catch (error) {
          // The hook runs awaited inside the host's request preparation, so
          // a throw escaping the callback fails the preparation and the
          // director's turn dies — the reminder's whole contract is to be
          // ignorable. Same shape as the old send guard's catch: the
          // request proceeds reminder-less, the failure named once.
          console.error(
            `[director] reminder to ${context.sessionID} failed: ${error}. The turn proceeds without it.`,
          );
        }
      })) ?? undefined;
  } catch (error) {
    console.error(`[director] reminder registration skipped: ${error}`);
  }

  // The persistence leg: the enter reminder (and the leave line on a
  // switch off the director) stored as a synthetic with resume:false the
  // moment the lane changes, so the transcript carries the reminder into
  // every window before any hook must fire. plan.ts subscribes the same
  // two event types; the promise adapter hands the subscription over as
  // an AsyncIterable, with the types filter applied host-side. A
  // degradation, like every registration here: without the event surface
  // the reconcile leg alone stands, and the load does not fail. The
  // stream ends on the cleanup's abort (and the adapter closes its async
  // iterators on the plugin scope at unload regardless), so the loop
  // needs no other teardown; its whole lifetime is this setup's.
  let reminderController: AbortController | undefined;
  if (typeof ctx.event?.subscribe === "function") {
    reminderController = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe!({
        signal: reminderController!.signal,
        types: ["session.created", "session.agent.selected"],
      })) {
        const text = switchReminder(event);
        if (!text) continue;
        const sessionID = event.data?.sessionID;
        if (!sessionID) continue;
        // Per-event isolation, the pump's rule: one session's failed
        // store must not end the loop — later switches would ride
        // reminder-less forever.
        try {
          await ctx.session?.synthetic?.({
            sessionID,
            text,
            resume: false,
          });
        } catch (error) {
          console.error(
            `[director] reminder persistence for ${sessionID} failed: ${error}.`,
          );
        }
      }
    })().catch((error: unknown) => {
      console.error(`[director] reminder persistence stream failed: ${error}`);
    });
  }

  // Children this activation delivers for, and the text buffered toward the
  // next mail. Only workers whose session lives in this activation's
  // location are tracked; `foreign` remembers sessions already checked and
  // found unstamped or elsewhere, so the check costs one session.get per
  // session per turn.
  const track = new Map<string, WorkerEntry>();
  const buffers = new Map<string, Array<{ text: string }>>();
  const foreign = new Set<string>();
  const here = ctx.location?.directory;
  // PRJ-525: the usage stream's state, bounded like track — one sample
  // and one model ref per watched session, pruned by forget(). The
  // spentFallbacks set carries the restart fallback's budget: one
  // transcript read per session, spent on the first read that finds no
  // sample, whatever it finds.
  const usageSamples = new Map<string, UsageSample>();
  const stepModels = new Map<string, { providerID: string; id: string }>();
  const spentFallbacks = new Set<string>();
  // PRJ-499: the step evidence the truncation verdict reads. `stepStates`
  // tracks one open step's text sighting between its start and its end;
  // `finalSteps` holds the turn's newest ended step — its finish, its
  // output-token count, and whether the step produced any text. A step
  // whose start was never seen (a mid-turn join) records nothing, so the
  // verdict stays "report": no evidence, no verdict.
  const stepStates = new Map<string, { textSeen: boolean; open: boolean }>();
  const finalSteps = new Map<
    string,
    { finish: string; output: number; hadText: boolean }
  >();

  // Lazy adoption from the dispatch stamp. The session's directory must
  // equal this activation's exactly; a subagent child carries its parent's
  // stamp and location but is part of the parent's turn, not a worker.
  const adopted = async (
    sessionID: string,
    { onText = false }: { onText?: boolean } = {},
  ): Promise<WorkerEntry | undefined> => {
    if (!sessionID) return undefined;
    const known = track.get(sessionID);
    if (known) return known;
    if (foreign.has(sessionID)) return undefined;
    let info;
    try {
      info = await ctx.session.get({ sessionID });
    } catch {
      foreign.add(sessionID);
      return undefined;
    }
    const director = stampOf(info?.metadata);
    if (
      !director ||
      info.parentID ||
      !here ||
      info.location?.directory !== here
    ) {
      foreign.add(sessionID);
      return undefined;
    }
    const entry = {
      director,
      title: info.title || info.metadata[STAMP]?.slice || "worker",
      directory: info.location.directory,
      agent: info.agent || "worker",
      // The model pin rides the stamp, nothing recomputed.
      model: info.metadata[STAMP]?.model,
      // A fresh adoption's next terminal settles one turn: either the one
      // already in flight (adopted mid-turn, buffered blocks are partial)
      // or the next one. Either way, a duplicate terminal after it is
      // dropped by the settled rule in deliver().
      pendingTurn: true,
      // Adopted on a text block: this activation missed the turn's start,
      // so text before that block is missing. Adopted at the start or at a
      // terminal, it missed no text it could have held.
      midTurn: onText,
    };
    track.set(sessionID, entry);
    debug("worker.adopted", { session: sessionID, director });
    return entry;
  };

  const forget = (sessionID: string): void => {
    track.delete(sessionID);
    buffers.delete(sessionID);
    foreign.delete(sessionID);
    usageSamples.delete(sessionID);
    stepModels.delete(sessionID);
    spentFallbacks.delete(sessionID);
    stepStates.delete(sessionID);
    finalSteps.delete(sessionID);
  };

  // The read the callers use (PRJ-525): the recorded sample first, the
  // transcript exactly once when the pump holds none for the session —
  // the shape a host restart leaves. The attempt is spent whether or
  // not it finds an anchor, because a dead transcript must never become
  // a per-wake cost again; the stream re-arms the map on the worker's
  // next turn either way.
  const contextUsage = async (
    sessionID: string,
  ): Promise<ContextUsage | undefined> => {
    const sample = usageSamples.get(sessionID);
    if (sample) return measureUsage(ctx, sample, sessionID);
    if (spentFallbacks.has(sessionID)) return undefined;
    spentFallbacks.add(sessionID);
    const read = await transcriptSample(ctx, sessionID);
    if (!read) return undefined;
    usageSamples.set(sessionID, read);
    return measureUsage(ctx, read, sessionID);
  };

  // At most one stored report and one wake notice per turn end. Any
  // terminal with a turn marker behind it (or buffered text not flushed
  // yet) files once and clears both; a terminal with neither is a
  // duplicate terminal for a turn already settled and is dropped.
  // `kind` picks the pulled body's wording; `reason` carries a failure's,
  // an interrupt's, or a truncation's recorded why.
  const deliver = async (
    event: HostEvent,
    kind: string,
    reason: string | null,
  ): Promise<void> => {
    const sessionID = event.data?.sessionID;
    const entry = await adopted(sessionID);
    if (!entry) return;
    const blocks = buffers.get(sessionID) || [];
    if (!entry.pendingTurn && blocks.length === 0) return;
    entry.pendingTurn = false;
    buffers.delete(sessionID);
    const midTurn = entry.midTurn;
    entry.midTurn = false;
    // The delivery key is the worker session plus the terminal event's id.
    // Overlapping activations can hold different buffers for one turn, but
    // the event id is the same in every one of them. With no id, only the
    // in-process guard above applies.
    const key = event.id ? `${sessionID}:${event.id}` : null;
    if (key && !claimDelivery(key)) {
      debug("report.duplicate", { session: sessionID, key });
      return;
    }
    const text = blocks
      .map((block) => block.text)
      .join("\n\n")
      .trim();
    try {
      await storeReport(
        ctx,
        entry.director,
        sessionID,
        event.id,
        kind,
        {
          ...entry,
          reason,
          midTurn,
        },
        text,
      );
    } catch (error) {
      // No row, no notice: a notice without a pullable report would lie.
      // The claim is given back so a sibling activation can try, and the
      // export pointer says where the turn's text lives either way.
      if (key) releaseDelivery(key);
      console.error(
        `[director] report store failed for ${sessionID} (${event.type}); the director was not woken. Full text: opencode session export ${sessionID}. Error: ${error}`,
      );
      return;
    }
    let unread = 1;
    try {
      const scan = await unreadReports(ctx, entry.director);
      // The row for this terminal event was just stored, so the count
      // cannot honestly be zero — but a report_read running between the
      // store and this scan can drain it. The notice never says zero
      // while the report it names is stored.
      unread = Math.max(1, scan.unread.length);
      if (scan.truncated)
        console.error(
          `[director] unread scan hit its page cap; the notice's count is a floor, not the total`,
        );
    } catch (error) {
      console.error(
        `[director] unread count failed (the notice understates it): ${error}`,
      );
    }
    // PRJ-522: the worker's context share rides the notice while it is
    // at or past half the window (the gate is
    // `share >= CONTEXT_WARN_SHARE` — the report_read description's
    // "at or past half" wording states this gate's inclusive shape) — a
    // state made visible on every wake while it holds, so growth past
    // the threshold stays seen until the director starts the worker's
    // next slice fresh. A failed read stays quiet: the report is
    // stored either way, and the wake's job is the report's.
    let warnShare: number | undefined;
    try {
      const usage = await contextUsage(sessionID);
      if (usage && usage.share >= CONTEXT_WARN_SHARE) warnShare = usage.share;
    } catch (error) {
      console.error(
        `[director] context usage read for ${sessionID} failed: ${error}`,
      );
    }
    try {
      await ctx.session.synthetic({
        sessionID: entry.director,
        text: noticeText(sessionID, unread, warnShare),
        description: NOTICE_DESCRIPTION,
        metadata: { source: NOTICE_SOURCE },
      });
      debug("notice.delivered", {
        session: sessionID,
        director: entry.director,
        unread,
        type: event.type,
      });
    } catch (error) {
      // The row is stored, so the report is safe — the next terminal
      // event's notice counts it, and report_read drains it. The claim is
      // kept: releasing it would let a sibling activation re-notice the
      // same terminal event, and overwrite the row with its own buffer's
      // text.
      console.error(
        `[director] wake notice to ${entry.director} failed for ${sessionID}: ${error}. The report is stored and stays unread until the next wake. Full text: opencode session export ${sessionID}.`,
      );
    }
  };

  const dispatchTool: ToolDefinition = {
    name: "director_dispatch",
    description: `Dispatch a worker session: create a new session in \`directory\` running \`agent\` (default "build"), stamp this session as its coordinator, deliver \`brief\` as a waking prompt, pinning \`model\` ("provider/model") to the session first when given, and return immediately with the session id. The worker also gets an unattended permission policy at creation (every action allowed for that session) so its tool calls never wait on a permission ask no headless session could answer; config-level deny rules are overridden for the worker too. Never spawns a subprocess and never streams stdout; each turn end files a report for this session and wakes it with a fixed notice naming the worker session and the unread count — call report_read to read the bodies. Worker text never rides the notice; a long body is cut to its head — to its tail when the text carries no STATUS line — with its last STATUS line, any BLOCKED paragraph, and a pointer to the full text kept. One stored report and at most one notice per turn end (none if the send fails): overlapping plugin activations that see the same turn end are deduped by its event id. A subagent's turns are part of its parent's and never report on their own. A turn interrupted with no recorded reason (a host shutdown) files an interrupted report and wakes you the same way: the host may resume that turn after a restart, and if resumed it reports when it ends. A turn whose final step ended with no text and no tool call — a provider cut mid-execution — files as a truncated report with the same wake. A worker that stays busy across a restart may never report, so check its session (director_worker_status) before re-dispatching or steering it. When \`base\` is given, the target worktree is validated before anything is created: a directory that is not a readable git worktree, a detached HEAD, or a HEAD not exactly at that commit refuses the dispatch at the call with the mismatch named, and the result carries the worktree it validated (path, branch, head, base).`,
    input: dispatchSchema,
    output: REPLY_OUTPUT,
    execute: async (raw, context) => {
      const input = raw || {};
      const director = context?.sessionID;
      if (!director)
        throw new Error(
          "director_dispatch: tool context carried no session id",
        );
      const directory = String(input.directory || "").trim();
      if (!directory)
        throw new Error("director_dispatch: directory is required");
      const brief = String(input.brief || "");
      if (!brief.trim())
        throw new Error("director_dispatch: brief is required");
      const agent = String(input.agent || "build").trim() || "build";
      const title = String(input.title || "") || deriveTitle(brief);
      const modelPin = parseModelPin(input.model);
      if (modelPin === undefined)
        throw new Error(
          `director_dispatch: model "${String(input.model).trim()}" must be an opencode model reference: "provider/model" or "provider/model#variant", the model id may carry slashes and colons (e.g. "example-proxy/auto/example-model", "kilo/baidu/ernie-5.5-preview:free")`,
        );

      // from @sysread/thatch (src/opencode/v2.ts ~784-848, MIT): the failure-narration
      // pattern — a completed-steps log, and a catch that names what completed and
      // any stranded session.
      const steps: string[] = [];
      let sessionID: string | undefined;
      let pinResolved = false;
      let validated:
        | { head: string; branch: string; baseCommit: string }
        | undefined;
      // PRJ-444: the branch-vs-worktree validation runs before anything
      // is created, so a stale or detached worktree refuses at the call
      // with the mismatch named — no session exists to strand. The
      // refusal is bare-named like the other pre-flight checks.
      const base =
        input.base === undefined || input.base === null
          ? undefined
          : String(input.base).trim();
      if (base !== undefined) {
        if (!base)
          throw new Error(
            "director_dispatch: base, when given, must be a ref or a sha",
          );
        validated = await validateDispatchBase(directory, base);
        steps.push(
          `validated worktree ${directory} HEAD ${validated.head} (branch ${validated.branch}) at ${base}`,
        );
      }
      try {
        const created = await ctx.session.create({
          title,
          agent,
          // The unattended policy rides the create call, so it is in place
          // before the waking prompt is admitted: first-turn tools are
          // covered, and no reload can lose it — the host projects the
          // stamp onto the durable session row.
          permissions: UNATTENDED_POLICY,
          // from @sysread/thatch (src/opencode/v2.ts ~788, MIT): the coordinator-stamp
          // pattern — a namespaced metadata record carries the coordinating session id.
          // The origin record rides the same create call (ADR
          // 20261124-session-origin-signal): the dispatch is a programmatic
          // spawn and declares it, so the memory client registers the
          // worker's lineage from the declaration at create time and no
          // post-hoc read ever has to recover it.
          metadata: {
            [STAMP]: {
              [DIRECTOR_STAMP]: director,
              slice: title,
              dispatchedAt: new Date().toISOString(),
              ...(modelPin ? { model: modelPin.text } : {}),
            },
            [ORIGIN_STAMP]: originRecord(director),
          },
          location: { directory },
        });
        sessionID = created?.id;
        if (!sessionID) {
          // from @sysread/thatch (src/opencode/v2.ts ~934-938, MIT): the session.create no-id guard.
          throw new Error(
            `session.create returned no id: ${JSON.stringify(created)?.slice(0, 200)}`,
          );
        }
        steps.push(
          `created session ${sessionID} in ${directory} (agent ${agent}) with the unattended permission policy`,
        );
        // The worker's own location activation adopts it from the stamp
        // and delivers its turn ends; the dispatching activation tracks
        // nothing, so it cannot become a second deliverer.
        steps.push(`${sessionID} reports to this director`);
        // A pin that cannot resolve is a dispatch error, not a silent
        // default: switch before the waking prompt, so an unresolved pin
        // never runs the brief on the catalog default.
        if (modelPin) {
          await ctx.session.switchModel({
            sessionID,
            model: {
              providerID: modelPin.providerID,
              id: modelPin.id,
              ...(modelPin.variant ? { variant: modelPin.variant } : {}),
            },
          });
          pinResolved = true;
          steps.push(`${sessionID} pinned to model ${modelPin.text}`);
        }
        await ctx.session.prompt({ sessionID, text: brief });
        steps.push("brief admitted as waking prompt");
        // The dispatch record carries the worktree it validated: the
        // tracking row gains the worker session (and the worktree itself,
        // when the module had no row for it yet), so the store answers
        // "which sessions own which worktrees" for dispatch-adopted
        // worktrees too. A failed record never undoes a delivered brief —
        // the mail lane does not depend on the row — it is said in the log.
        if (validated) {
          try {
            await trackWorktree({
              path: directory,
              repo: await mainRepoOf(directory),
              branch: validated.branch,
              head: validated.head,
              base: base ?? null,
              baseCommit: validated.baseCommit,
              owner: director,
              session: sessionID,
            });
          } catch (error) {
            console.error(
              `[director] dispatch worktree record failed for ${sessionID} at ${directory}: ${error}`,
            );
          }
        }
        debug("dispatch", { session: sessionID, director, directory, agent });
        const reply = {
          ok: true,
          sessionID,
          agent,
          directory,
          title,
          ...(validated
            ? {
                worktree: {
                  path: directory,
                  branch: validated.branch,
                  head: validated.head,
                  base,
                  baseCommit: validated.baseCommit,
                },
              }
            : {}),
          ...(modelPin ? { model: modelPin.text } : {}),
          delivery:
            "waking prompt queued; the turn end files a report and wakes this session — call report_read",
        };
        return { content: JSON.stringify(reply), output: reply };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // A pin that failed leaves the session watched, unpinned, and
        // briefless; the narration must say so, because steering or
        // re-dispatching into that state is the caller's recovery.
        const strandedPin =
          modelPin && sessionID && !pinResolved
            ? ` The model pin "${modelPin.text}" did not resolve; the waking prompt was not delivered.`
            : "";
        throw new Error(
          `director_dispatch failed: ${reason}. Completed steps: ${steps.length ? steps.join("; ") : "none"}.` +
            (sessionID
              ? ` The session ${sessionID} exists and is watched — name it in director_steer or director_worker_status.${strandedPin}`
              : " No session was created; the directory is the usual suspect (it must already exist)."),
        );
      }
    },
  };

  const steerTool: ToolDefinition = {
    name: "director_steer",
    description: `Deliver \`instruction\` to an existing session as a waking prompt and return immediately. Turn-end reports flow for dispatched workers; the result names whether this session reports back. Each turn end files one stored report and sends at most one wake notice (none if the send fails), deduped by its event id across overlapping plugin activations; report_read returns the bodies.`,
    input: steerSchema,
    output: REPLY_OUTPUT,
    execute: async (raw, context) => {
      const input = raw || {};
      const sessionID = String(input.sessionID || "").trim();
      const instruction = String(input.instruction || "");
      if (!sessionID) throw new Error("director_steer: sessionID is required");
      if (!instruction.trim())
        throw new Error("director_steer: instruction is required");
      let info;
      try {
        info = await ctx.session.get({ sessionID });
      } catch {
        // from @sysread/thatch (src/opencode/v2.ts ~877, MIT): the dead-target refusal's
        // opening clause ("No live session with id ..."); the rest is ours.
        throw new Error(
          `No live session with id ${sessionID}. It may have been deleted or lives on another host — ` +
            "director_worker_status with a known-dispatched id to recover a handle.",
        );
      }
      // A stamped session steers fine from anywhere: its mail flows to the
      // director its stamp names, never to the steering director, and is
      // delivered from the worker's own location, never from here.
      const mailTo = stampOf(info?.metadata);
      await ctx.session.prompt({ sessionID, text: instruction });
      debug("steer", {
        session: sessionID,
        director: context?.sessionID,
        mailTo: mailTo ?? null,
      });
      const reply = mailTo
        ? {
            ok: true,
            sessionID,
            delivery: "waking prompt queued",
            turnMail: mailTo,
            note: "the turn end files a report for this director — read it with report_read",
          }
        : {
            ok: true,
            sessionID,
            delivery: "waking prompt queued",
            turnMail: null,
            note: "not a dispatched worker: no turn report will be filed",
          };
      return { content: JSON.stringify(reply), output: reply };
    },
  };

  const statusTool: ToolDefinition = {
    name: "director_worker_status",
    description: `Read a session's live state from the session API: busy or idle, its last completed outcome, location, dispatch stamp, how many of its reports are unread for you, and its context usage when it is readable (contextTokens measured against contextWindow, with contextShare; measured the way compaction measures it, from the worker's last completed step event — replayed from the transcript once per session when no step measurement is held, after a restart — omitted when there are no usable tokens or the model has no known window). contextWindow belongs to the model the measurement was taken under — the sample's model ref, not the session's live model field, so a session that switched models mid-flight reports the window the tokens were measured under. Convenience only — it is never authoritative over the worktree; landed work is verified in the worktree itself.`,
    input: statusSchema,
    output: REPLY_OUTPUT,
    execute: async (raw, context) => {
      const input = raw || {};
      const sessionID = String(input.sessionID || "").trim();
      if (!sessionID)
        throw new Error("director_worker_status: sessionID is required");
      let info;
      try {
        info = await ctx.session.get({ sessionID });
      } catch {
        // from @sysread/thatch (src/opencode/v2.ts ~877, MIT): the same dead-target
        // refusal phrasing director_steer carries.
        throw new Error(
          `No live session with id ${sessionID}. It may have been deleted or never created.`,
        );
      }
      const stamp = stampOf(info?.metadata);
      // Unread mail the caller has not pulled yet: from this worker, and
      // in total. A failed scan omits the fields — the status itself does
      // not depend on the store.
      let unread:
        | {
            fromThisWorker: number;
            total: number;
            truncated: boolean;
          }
        | undefined;
      const caller = context?.sessionID;
      if (caller) {
        try {
          const scan = await unreadReports(ctx, caller);
          unread = {
            fromThisWorker: scan.unread.filter(
              (item) => item.row.worker === sessionID,
            ).length,
            total: scan.unread.length,
            truncated: scan.truncated,
          };
        } catch (error) {
          console.error(
            `[director] unread count for worker_status failed: ${error}`,
          );
        }
      }
      // PRJ-522: the worker's context usage rides the status whenever it
      // is readable — the threshold gates only the notice clause, never
      // the number. An absent or failed read omits the fields. The
      // window is the model the sample was measured under: the ref
      // rides the step's start event (or the fallback's anchor), so a
      // session whose row switched models still reports the window its
      // tokens were measured against.
      const usage = await contextUsage(sessionID);
      // The pin reads as "providerID/modelID" for the caller. The host's
      // live model record wins; the pin the dispatch stamp carries is the
      // fallback when the host row reports none.
      const reply = {
        ok: true,
        sessionID,
        title: info?.title ?? null,
        agent: info?.agent ?? null,
        model: modelText(info?.model) ?? info?.metadata?.[STAMP]?.model ?? null,
        directory: info?.location?.directory ?? null,
        state: stateOf(info ?? {}),
        outcome: info?.outcome ?? null,
        watched: Boolean(stamp),
        dispatchedBy: stamp ?? null,
        ...(unread
          ? {
              unreadReportsFromWorker: unread.fromThisWorker,
              unreadReportsTotal: unread.total,
              ...(unread.truncated ? { unreadTruncated: true } : {}),
            }
          : {}),
        ...(usage
          ? {
              contextTokens: usage.tokens,
              contextWindow: usage.window,
              contextShare: usage.share,
            }
          : {}),
      };
      return { content: JSON.stringify(reply), output: reply };
    },
  };

  const readTool: ToolDefinition = {
    name: "report_read",
    description: `Read the worker reports filed for this session: each watched worker's turn end files one report for the session its stamp names — final text under the cap rules (a long text is cut to its head — to its tail when the text carries no STATUS line — with the last STATUS line and any BLOCKED paragraph kept verbatim), and failures, interrupts, and truncated final steps file as their own kinds. A fixed wake notice names the worker session and the unread count, and adds the worker's context share when it is at or past half its model's window (the gate is the inclusive \`share >= 0.5\`); this tool returns the bodies. Reading marks a report read. Unread reports return oldest first, up to \`limit\` reports and \`maxChars\` body characters, with the count still unread stated; call again for the rest. Reports address only the session they were filed for — this session's unread reports and no others. When a turn's text is needed beyond what a report kept, opencode session export <worker session> holds the full text.`,
    input: readSchema,
    output: REPLY_OUTPUT,
    execute: async (raw, context) => {
      const caller = context?.sessionID;
      if (!caller)
        throw new Error("report_read: tool context carried no session id");
      const limit = clampNumber(raw?.limit, 1, 20, 5);
      const maxChars = clampNumber(raw?.maxChars, 200, 100000, 4000);
      const { unread, truncated } = await unreadReports(ctx, caller);
      // Oldest first, within both budgets. The first unread report is
      // always taken, so a budget below one body still makes progress;
      // what a call does not return stays unread and is counted.
      const taken: Array<{
        key: string;
        row: ReportRow;
        body: string;
      }> = [];
      let chars = 0;
      for (const { key, row } of unread) {
        if (taken.length >= limit) break;
        const body = renderReportBody(row);
        if (taken.length > 0 && chars + body.length > maxChars) break;
        taken.push({ key, row, body });
        chars += body.length;
      }
      const reports = taken.map(({ row, body }) => ({
        worker: row.worker,
        kind: row.kind,
        title: row.title,
        directory: row.directory,
        agent: row.agent,
        reason: row.reason,
        partial: row.partial,
        createdAt: new Date(row.created).toISOString(),
        body,
      }));
      // Deliver first, mark after: a failed mark must never strand a row
      // as read-but-never-delivered. The bodies above go out even when
      // the marking below fails, and a failed mark leaves the row
      // unread, so the next call returns it again.
      let marked = 0;
      for (const { key, row } of taken) {
        try {
          await ctx.storage.set(key, {
            ...row,
            read: true,
            readAt: Date.now(),
          });
          marked += 1;
        } catch (error) {
          console.error(`[director] mark-read failed for ${key}: ${error}`);
        }
      }
      const remaining = unread.length - marked;
      const notes = [];
      if (remaining > 0 || marked < taken.length)
        notes.push("more reports are unread; call report_read again");
      if (truncated)
        notes.push("the report scan hit its page cap; counts are a floor");
      const reply = {
        ok: true,
        returned: reports.length,
        unreadRemaining: remaining,
        ...(marked < taken.length ? { unmarked: taken.length - marked } : {}),
        ...(truncated ? { truncated } : {}),
        ...(notes.length ? { note: notes.join(" ") } : {}),
        reports,
      };
      return { content: JSON.stringify(reply), output: reply };
    },
  };

  // PRJ-342: the enumeration answer to "poll each director". The truth
  // source is the session API alone, no second state store.
  const sessionsSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };

  const sessionsTool: ToolDefinition = {
    name: "director_sessions",
    description: `Enumerate the sessions the host's session API knows, so a coordinator can poll or steer lanes whose ids it does not already hold: per session, its id, workspace directory, agent, state (busy or idle, read from the session's time record exactly as director_worker_status reads it), and the epoch-millis timestamp of the session's last turn end (null for a session that has never ended one — the host omits time.idle until a turn has ended). Sorted most-recent-turn first; a session with no turn yet sorts last. The walk reads at most ${SESSION_PAGE_CAP} pages of the host's list, dedupes the rows by session id, and when a cursor is still pending after that cap the result carries truncated: true, holding only what the walk reached. Posture: the tool surfaces every session the host's session API knows; filtering is by lane/workspace at the caller's side. Read-only: this tool performs no writes, reads no message contents, and returns no session metadata — only the five fields above. It requires the client surface's session.list; when that surface lacks the method, this tool fails with a named error and tries no fallback.`,
    input: sessionsSchema,
    output: REPLY_OUTPUT,
    execute: async () => {
      if (typeof ctx.session?.list !== "function") {
        throw new Error(
          "director_sessions: the client surface lacks session.list — no enumeration surface exists on this host (no fallback is attempted)",
        );
      }
      let cursor: string | undefined;
      const rows: any[] = [];
      for (let page = 0; page < SESSION_PAGE_CAP; page += 1) {
        const listed = await ctx.session.list(cursor ? { cursor } : undefined);
        const pageRows = Array.isArray(listed) ? listed : (listed?.data ?? []);
        rows.push(...pageRows);
        cursor = Array.isArray(listed) ? undefined : listed?.cursor?.next;
        if (!cursor) break;
      }
      const truncated = Boolean(cursor);
      const sessions: Array<{
        sessionID: string;
        directory: string | null;
        agent: string | null;
        state: string;
        lastTurnEnd: number | null;
      }> = [];
      const seenIDs = new Set<string>();
      let skipped = 0;
      for (const [index, row] of rows.entries()) {
        const skip = (reason: string): void => {
          skipped += 1;
          console.error(
            `[director] director_sessions: skipped session row ${index + 1} of ${rows.length}: ${reason}`,
          );
        };
        try {
          const id = typeof row?.id === "string" ? row.id.trim() : "";
          if (!id) {
            skip(
              row === null || typeof row !== "object"
                ? "not a session object"
                : "no usable id",
            );
            continue;
          }
          // A session id the page walk listed twice enumerates once, and
          // the first sighting stands.
          if (seenIDs.has(id)) {
            console.error(
              `[director] director_sessions: session ${id} was listed again on the page walk; enumerated once`,
            );
            continue;
          }
          seenIDs.add(id);
          sessions.push({
            sessionID: id,
            directory:
              typeof row.location?.directory === "string"
                ? row.location.directory
                : null,
            agent:
              typeof row.agent === "string" && row.agent ? row.agent : null,
            state: stateOf(row),
            // While an execution runs, time.idle holds the previous turn's
            // end — which is what "last turn end" means in either state.
            // The host emits no time.idle at all for a session that has
            // never ended a turn, so absence means "never ended a turn":
            // null, never an invented epoch zero.
            lastTurnEnd: epoch(row?.time?.idle) ?? null,
          });
        } catch (error) {
          skip(`row could not be read: ${error}`);
        }
      }
      // Most recent turn first; a session with no turn end (yet) sorts
      // after every session that has one.
      sessions.sort(
        (a, b) =>
          (b.lastTurnEnd ?? Number.NEGATIVE_INFINITY) -
          (a.lastTurnEnd ?? Number.NEGATIVE_INFINITY),
      );
      if (truncated) {
        console.error(
          `[director] director_sessions: stopped at the ${SESSION_PAGE_CAP}-page cap with a cursor pending; the result is truncated`,
        );
      }
      const reply = {
        ok: true,
        sessions,
        skipped,
        ...(truncated ? { truncated } : {}),
      };
      return { content: JSON.stringify(reply), output: reply };
    },
  };

  // PRJ-393: the manifest surface — facts stored as rows, read as a
  // rendered view. A hand-edited manifest or plan file rots once it grows:
  // exact-match edits miss on reflowed tables, one repair clobbers a row
  // header, and the maintenance path degrades into grep -n / sed
  // line-number surgery. The module's answer is the shape the report ledger
  // already uses: rows in ctx.storage under manifest/<owner-session-id>/,
  // each row written whole (upsert by its storage key, never diff-patched),
  // and a view composed from storage at every read. No in-memory state can
  // go stale; two activations share the view through the kv the way they
  // share the report ledger; and no new background loop exists — nothing
  // delivers on its own, the surface is read-when-read.
  //
  // A row: { id, key, fact, owner, at, supersedes? }. `key` is a stable
  // label for the slice or subject the fact tracks, `fact` is one sentence
  // of what is true now, `owner` is the calling session, and `supersedes`
  // names a stored row id whose fact must then never render as current —
  // the fold is honored wherever the named row lives, so a wrong fact can
  // be retired across namespaces without anyone editing a file. Storage
  // keys are manifest/<owner>/<encoded key>/<row id>, one owner's prefix
  // scan is exactly its namespace, and drops stay inside the caller's own
  // prefix.
  //
  // A read consumes nothing, so the read reaches everything: the view
  // renders whole in one call, and the manifest's scans walk to
  // exhaustion — the page cap bounds the loop (raised to 10,000 pages,
  // five million rows, far past real usage), it never stops one, and a
  // host that keeps serving cursors past the bound fails the call with a
  // named error rather than acting on a partial row set (PRJ-393 review
  // 225: a truncated read would drop superseding rows beyond the cursor
  // and republish the facts they retired; and since manifest rows are
  // never pruned, the report walk's 20-page cap was a destination, not a
  // safety valve). Drops that
  // remove a superseding row preserve its link first: the link is
  // rewritten as a tombstone row (an empty-fact row under the caller's
  // namespace, same key) before the removal, because removing the link
  // alone would republish the retired fact — possibly one another session
  // retired precisely because it was wrong — as current in the shared
  // view. The view folds from every row's link the same way, so a
  // tombstone needs no special treatment there; and tombstone-first
  // ordering means any failure past the rewrite leaves the retired fact
  // still retired.
  //
  // A fact is one sentence on one line, and so is a key: an interior
  // newline is refused at validation, because the view renders one line
  // per fact and a newline inside a fact or key would forge lines —
  // attribution and all.
  const MANIFEST_PREFIX = "manifest/";
  const MANIFEST_KEY_MAX = 200;
  const MANIFEST_FACT_MAX = 500;

  // A row id is unique per write. The base36 time prefix keeps ids sorted
  // roughly chronologically; rows minted within the same millisecond
  // carry a process-wide monotonic sequence, zero-padded so the view's
  // same-`at` tie-break (id comparison) orders them by true write order
  // instead of by a random suffix. The sequence rides Symbol.for like the
  // delivery claims: every plugin activation runs in the host's one JS
  // realm, re-imports included, so re-evaluating this module does not
  // reset it. A host restart can only reuse a prefix it has already
  // moved past, and the random suffix keeps even that collision-free in
  // practice.
  const MANIFEST_SEQ = Symbol.for("chancery.director.manifest-seq");
  const manifestRowID = (): string => {
    const host = globalThis as Record<symbol, number | undefined>;
    const seq = (host[MANIFEST_SEQ] = (host[MANIFEST_SEQ] ?? 0) + 1);
    return `man-${Date.now().toString(36)}-${String(seq).padStart(10, "0")}-${Math.random().toString(36).slice(2, 8)}`;
  };

  function decodeManifestRow(entry: { value: unknown }): ManifestRow | null {
    const row = entry.value;
    if (typeof row !== "object" || row === null) return null;
    const record = row as Record<string, unknown>;
    return typeof record.id === "string" &&
      typeof record.key === "string" &&
      typeof record.fact === "string" &&
      typeof record.owner === "string" &&
      typeof record.at === "number"
      ? (record as ManifestRow)
      : null;
  }

  // The composed view: tombstones never render and never hold a key slot
  // (they carry no fact — only manifest_drop writes an empty-fact row, a
  // write refuses one); their supersedes link joins the fold set like any
  // other. Superseded rows fold next — a row named by any supersedes never
  // renders, however new it is — then the newest surviving fact per key
  // wins, and rows render newest first. Ties on `at` fall to the greater
  // row id, whose monotonic middle segment orders same-millisecond writes
  // by write order.
  function composeManifest(rows: ManifestRow[]): {
    rendered: ManifestRow[];
    folded: number;
  } {
    const superseded = new Set<string>();
    for (const row of rows) if (row.supersedes) superseded.add(row.supersedes);
    const factRows = rows.filter((row) => row.fact !== "");
    const current = factRows.filter((row) => !superseded.has(row.id));
    const newestByKey = new Map();
    for (const row of current) {
      const held = newestByKey.get(row.key);
      if (
        !held ||
        row.at > held.at ||
        (row.at === held.at && row.id > held.id)
      ) {
        newestByKey.set(row.key, row);
      }
    }
    const rendered = [...newestByKey.values()].sort(
      (a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    return { rendered, folded: factRows.length - current.length };
  }

  const manifestWriteSchema = {
    type: "object",
    properties: {
      key: {
        type: "string",
        description:
          "Stable label for the slice or subject this fact tracks (e.g. the slice name). Writing again under the same key is how a fact is updated: the view renders only the newest row per key.",
      },
      fact: {
        type: "string",
        description:
          "One sentence of fact — what is true now, never a change narrative or a diff note. Written whole; never patched later.",
      },
      supersedes: {
        type: "string",
        description:
          "Optional row id this fact replaces. The named row must already be stored, and its fact then never renders as current.",
      },
    },
    required: ["key", "fact"],
    additionalProperties: false,
  };

  const manifestWriteTool: ToolDefinition = {
    name: "manifest_write",
    description: `Write one fact into the manifest surface: a row {id, key, fact, owner, at, supersedes?} stored whole under this session's own namespace. \`key\` is a stable label for the slice or subject the fact tracks; \`fact\` is one sentence of what is true now. Writing again under the same key updates it — the view renders only the newest row per key — and \`supersedes\` (a stored row id) retires an older fact explicitly, wherever its row lives. Use this for state that keeps needing line math in a file: facts live here, and files are exports of manifest_read's view, never the source of truth. Nothing delivers on its own; the surface is read-when-read.`,
    input: manifestWriteSchema,
    output: REPLY_OUTPUT,
    execute: async (raw, context) => {
      const owner = context?.sessionID;
      if (!owner)
        throw new Error("manifest_write: tool context carried no session id");
      const input = raw || {};
      const key = String(input.key ?? "").trim();
      if (!key) throw new Error("manifest_write: key is required");
      if (/\r|\n/.test(key))
        throw new Error(
          "manifest_write: key must be a single line — an interior newline would forge lines in the rendered view",
        );
      if (key.length > MANIFEST_KEY_MAX)
        throw new Error(
          `manifest_write: key is ${key.length} characters, over the ${MANIFEST_KEY_MAX} cap — use a short stable label`,
        );
      const fact = String(input.fact ?? "").trim();
      if (!fact) throw new Error("manifest_write: fact is required");
      if (/\r|\n/.test(fact))
        throw new Error(
          "manifest_write: fact must be a single line — an interior newline would forge lines in the rendered view, so rewrite the fact into one line",
        );
      if (fact.length > MANIFEST_FACT_MAX)
        throw new Error(
          `manifest_write: fact is ${fact.length} characters, over the ${MANIFEST_FACT_MAX} cap — a fact is one sentence`,
        );
      const supersedes =
        input.supersedes === undefined || input.supersedes === null
          ? undefined
          : String(input.supersedes).trim();
      if (supersedes !== undefined) {
        if (!supersedes)
          throw new Error(
            "manifest_write: supersedes, when given, must be a row id",
          );
        // The named row must exist before it can be superseded: a typo'd
        // reference would otherwise leave both rows rendering as current.
        // The fold is honored across namespaces, so the lookup is too —
        // and it must see every row (PRJ-393 review 225): a lookup past a
        // truncation stop would refuse a valid supersedes.
        const scan = await scanEveryRow(ctx.storage, MANIFEST_PREFIX);
        const known = scan.some(
          (entry) => decodeManifestRow(entry)?.id === supersedes,
        );
        if (!known)
          throw new Error(
            `manifest_write: supersedes names no stored row "${supersedes}"`,
          );
      }
      const row = {
        id: manifestRowID(),
        key,
        fact,
        owner,
        at: Date.now(),
        ...(supersedes !== undefined ? { supersedes } : {}),
      };
      // Whole-row upsert: the row is stored complete under its own key and
      // is never diff-patched afterwards.
      await ctx.storage.set(
        `${MANIFEST_PREFIX}${owner}/${encodeURIComponent(key)}/${row.id}`,
        row,
      );
      debug("manifest.written", { row: row.id, owner, key });
      const reply = {
        ok: true,
        id: row.id,
        key,
        owner,
        at: new Date(row.at).toISOString(),
        ...(supersedes !== undefined ? { supersedes } : {}),
      };
      return { content: JSON.stringify(reply), output: reply };
    },
  };

  // PRJ-393 review 211: a read consumes nothing, so the read reaches
  // everything. manifest_read takes no arguments and renders the whole
  // composed view — the current-fact count is the number of keys agents
  // created, small by construction, and any cap here would be a hard
  // ceiling the header's "call again" advice could not lift. Review 225
  // completes the invariant: the scan behind the composition walks every
  // stored row, so a retirement is never lost to a truncation stop.
  const manifestReadSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };

  const manifestReadTool: ToolDefinition = {
    name: "manifest_read",
    description: `Read the composed manifest view: every current fact — the newest per key, with superseded rows folded out (a count line states how many) — composed from storage at call time. No cached view exists, two sessions or two activations of one host see the same view through the shared store, and the view renders whole in one call: a read consumes nothing, so nothing is unreachable and there is nothing to page. The scan walks every stored row before composing, so a retirement is never lost to a truncation stop; a scan that cannot exhaust fails the read with a named error instead of composing from a partial set.`,
    input: manifestReadSchema,
    output: REPLY_OUTPUT,
    execute: async (raw, context) => {
      const caller = context?.sessionID;
      if (!caller)
        throw new Error("manifest_read: tool context carried no session id");
      if (
        raw !== undefined &&
        raw !== null &&
        typeof raw === "object" &&
        ("limit" in raw || "maxChars" in raw)
      )
        throw new Error(
          "manifest_read: takes no arguments — the view renders whole, there is nothing to cap or page",
        );
      // Compose from storage every time, and from every row (PRJ-393
      // review 225): the fold set is computed over all rows that exist,
      // every time — a truncated scan would silently resurrect a retired
      // fact whose superseding row sits beyond the cursor.
      const scan = await scanEveryRow(ctx.storage, MANIFEST_PREFIX);
      const rows: ManifestRow[] = [];
      for (const entry of scan) {
        const row = decodeManifestRow(entry);
        if (row) rows.push(row);
      }
      const { rendered, folded } = composeManifest(rows);
      const header =
        `manifest: ${rendered.length} fact${rendered.length === 1 ? "" : "s"}` +
        ` (${folded} superseded row${folded === 1 ? "" : "s"} folded)`;
      const view = [
        header,
        ...rendered.map(
          (row) =>
            `${row.key}: ${row.fact} (owner ${row.owner}, ${new Date(row.at).toISOString()}, row ${row.id}${row.supersedes ? `, supersedes ${row.supersedes}` : ""})`,
        ),
      ].join("\n");
      const reply = {
        ok: true,
        view,
        facts: rendered.length,
        folded,
      };
      return { content: JSON.stringify(reply), output: reply };
    },
  };

  const manifestDropSchema = {
    type: "object",
    properties: {
      key: {
        type: "string",
        description:
          "Drop every row under this key in your own manifest namespace — the current fact and its history.",
      },
      id: {
        type: "string",
        description:
          "Drop the one row with this row id in your own manifest namespace.",
      },
    },
    additionalProperties: false,
  };

  const manifestDropTool: ToolDefinition = {
    name: "manifest_drop",
    description: `Drop rows from your own manifest namespace only, by \`key\` (every row tracking that label, history included) or by \`id\` (one row) — exactly one of the two. Rows under other sessions' namespaces are invisible to this tool and stay untouched; a drop that matches nothing reports dropped: 0. A dropped row that carried a supersedes link is not lost with it: before the removal, the link is rewritten as a tombstone row (an empty-fact row under your namespace carrying the link), so the fact that link retired never republishes itself as current — the result names what happened to it (keptFolded). Prefer \`manifest_write\` with \`supersedes\` to retire a fact anyone can still see: a drop only clears your own namespace.`,
    input: manifestDropSchema,
    output: REPLY_OUTPUT,
    execute: async (raw, context) => {
      const owner = context?.sessionID;
      if (!owner)
        throw new Error("manifest_drop: tool context carried no session id");
      const input = raw || {};
      const key =
        input.key === undefined ? undefined : String(input.key).trim();
      const id = input.id === undefined ? undefined : String(input.id).trim();
      if ((key === undefined) === (id === undefined))
        throw new Error("manifest_drop: give exactly one of key or id");
      if (key !== undefined && !key)
        throw new Error("manifest_drop: key, when given, must be non-empty");
      if (id !== undefined && !id)
        throw new Error("manifest_drop: id, when given, must be non-empty");
      // One owner's prefix scan is exactly one namespace: rows under other
      // sessions' prefixes are never seen, let alone removed. The walk
      // must exhaust (PRJ-393 review 225): a truncated drop would leave
      // rows silently behind and understate what it dropped.
      const scan = await scanEveryRow(
        ctx.storage,
        `${MANIFEST_PREFIX}${owner}/`,
      );
      const matches = [];
      for (const entry of scan) {
        const row = decodeManifestRow(entry);
        if (row && (key !== undefined ? row.key === key : row.id === id))
          matches.push({ key: entry.key, row });
      }
      // Tombstones before removals: a superseding row carries the link
      // that keeps its retired victim out of the view, so removing the
      // row alone would republish the victim — possibly a fact another
      // session retired precisely because it was wrong. Each removed
      // row's link is rewritten first as a tombstone (an empty-fact row
      // under this caller's namespace, same key, so a later drop of that
      // key finds and rewrites it in turn); any failure past this point
      // leaves the retired fact still retired, never resurrected. The
      // view folds from every row's link the same way, so a tombstone
      // needs no special treatment there.
      const tombstones: ManifestRow[] = [];
      for (const { row } of matches) {
        if (!row.supersedes) continue;
        const marker = {
          id: manifestRowID(),
          key: row.key,
          fact: "",
          owner,
          at: Date.now(),
          supersedes: row.supersedes,
        };
        await ctx.storage.set(
          `${MANIFEST_PREFIX}${owner}/${encodeURIComponent(marker.key)}/${marker.id}`,
          marker,
        );
        tombstones.push(marker);
      }
      for (const { key: storageKey } of matches)
        await ctx.storage.remove(storageKey);
      const keptFolded = [...new Set(tombstones.map((t) => t.supersedes))];
      debug("manifest.dropped", {
        owner,
        dropped: matches.length,
        tombstones: tombstones.length,
      });
      const reply = {
        ok: true,
        dropped: matches.length,
        ...(tombstones.length
          ? {
              tombstones: tombstones.length,
              keptFolded,
              note: `${tombstones.length} supersedes link${tombstones.length === 1 ? "" : "s"} preserved as tombstone rows; the fact${keptFolded.length === 1 ? "" : "s"} they retired ${keptFolded.length === 1 ? "stays" : "stay"} out of the view`,
            }
          : {}),
        ...(matches.length === 0
          ? {
              note: `nothing under that ${
                key !== undefined ? "key" : "id"
              } in your manifest namespace`,
            }
          : {}),
      };
      return { content: JSON.stringify(reply), output: reply };
    },
  };

  // PRJ-444: worktree lifecycle. The director module runs `git worktree` itself.
  // opencode's own worktree tooling cannot serve the director case: its
  // worktree_create has detached worktrees at a stale snapshot (2026-11-15:
  // two dispatches landed one commit behind the work the brief named, and
  // the workers found it out mid-turn), and its worktree_remove hardcodes
  // an edit assertion a headless session cannot answer (verified live; PR
  // #40 reverted the config carve-out as the wrong price). Three tools own
  // the lifecycle here: add creates a worktree on a branch, remove takes
  // one down claims-safe, list reads the tracked set with its live git
  // state. The tracking store rides ctx.storage beside the report ledger
  // and the manifest — one row per worktree path, keyed
  // worktree/<encoded path>, whole-row upserts like the manifest's rows:
  //
  //   { path, repo, branch, head, base, baseCommit, owner, session,
  //     createdAt }
  //
  // `owner` is the session that added the worktree or last dispatched
  // into it; `session` is the worker session living there, when a
  // validated dispatch named one; `base`/`baseCommit` record what the
  // head was checked against when the row was written, and list-time
  // checks re-resolve the base ref against the live tree, so "merged"
  // and "stale" are answers about now, not about add time. Nothing
  // delivers on its own: the surface is read-when-read, like the rest.
  const WORKTREE_PREFIX = "worktree/";

  function decodeWorktreeRow(entry: { value: unknown }): WorktreeRow | null {
    const row = entry.value;
    if (typeof row !== "object" || row === null) return null;
    const record = row as Record<string, unknown>;
    return typeof record.path === "string" &&
      typeof record.repo === "string" &&
      typeof record.head === "string" &&
      typeof record.owner === "string" &&
      typeof record.createdAt === "number"
      ? (record as WorktreeRow)
      : null;
  }

  // Whole-row upsert keyed on the path, like the manifest's rows: a
  // re-add or a validated dispatch overwrites the row whole, keeping the
  // row's createdAt (when the module first tracked the worktree).
  async function trackWorktree(
    record: Omit<WorktreeRow, "createdAt">,
  ): Promise<WorktreeRow> {
    const key = `${WORKTREE_PREFIX}${encodeURIComponent(record.path)}`;
    const prior = (await ctx.storage.get(key)) as
      | WorktreeRow
      | null
      | undefined;
    const row: WorktreeRow = {
      ...record,
      createdAt:
        prior && typeof prior.createdAt === "number"
          ? prior.createdAt
          : Date.now(),
    };
    await ctx.storage.set(key, row);
    return row;
  }

  // The dispatch contract's branch-vs-worktree validation: the directory
  // must be a readable git worktree sitting on a branch, and its HEAD
  // must be exactly at the named base. Every refusal names both sides of
  // the mismatch, so the director can fix the worktree (rebase, recreate,
  // or name the base it is really at) without opening a session to find
  // out.
  async function validateDispatchBase(
    directory: string,
    base: string,
  ): Promise<{ head: string; branch: string; baseCommit: string }> {
    let state: { head: string; branch: string | null; dirty: boolean };
    try {
      state = await worktreeState(directory);
    } catch (error: any) {
      throw new Error(
        `director_dispatch: cannot validate the worktree at ${directory} against base ${base}: ${error.message}`,
      );
    }
    if (!state.branch)
      throw new Error(
        `director_dispatch: worktree ${directory} has a detached HEAD at ${state.head}; dispatches land on a branch — recreate or switch the worktree to ${base} first`,
      );
    let baseCommit;
    try {
      baseCommit = await gitRun(directory, [
        "rev-parse",
        "--verify",
        `${base}^{commit}`,
      ]);
    } catch (error: any) {
      throw new Error(
        `director_dispatch: base ${base} does not resolve in ${directory}: ${error.message}`,
      );
    }
    if (state.head !== baseCommit)
      throw new Error(
        `director_dispatch: worktree ${directory} (branch ${state.branch}) HEAD ${state.head} is not at ${base} (${baseCommit}) — rebase or recreate the worktree, or dispatch without base if its position is intentional`,
      );
    return { head: state.head, branch: state.branch, baseCommit };
  }

  // Removal is claims-safe. Before a worktree goes, every session the
  // host knows that lives in the path must be neither busy nor waiting
  // on a first turn — a session that has never ended a turn may still be
  // about to run its waking prompt (the host emits no time.idle until a
  // turn has ended, so absence there is the "maybe about to run" case,
  // the same reading director_sessions uses for lastTurnEnd). When the
  // client surface lacks session.list, the check falls back to the
  // tracked sessions the row names, read one by one; the mode rides the
  // result either way, so a caller knows how much the check saw.
  async function liveSessionsIn(
    directory: string,
    row?: WorktreeRow | null,
  ): Promise<{
    sessions: Array<{
      sessionID: string;
      state: string;
      lastTurnEnd: number | null;
    }>;
    mode: "list" | "tracked";
  }> {
    const blocking = (info: any): boolean =>
      stateOf(info) === "busy" || epoch(info?.time?.idle) === undefined;
    if (typeof ctx.session?.list === "function") {
      // Walk to exhaustion (PRJ-472): the cap bounds the loop, it never
      // stops it — a live session in an unseen page is the exact danger
      // the check exists for. A host that keeps serving cursors past the
      // bound fails the call named, like scanEveryRow. Each page is
      // filtered as it arrives (zenigata review 579): the walk's
      // footprint stays at the sessions actually in this tree instead of
      // scaling with the host's whole list.
      let cursor: string | undefined;
      const found: Array<{
        sessionID: string;
        state: string;
        lastTurnEnd: number | null;
      }> = [];
      // What the walk found, deduped by session id — after the blocking
      // test, never the sightings (zenigata review 579): an
      // already-ended sighting marks nothing seen on the check's behalf,
      // so a live sighting later is still refused, and a live session
      // the host listed twice renders once in the refusal.
      const foundIDs = new Set<string>();
      for (let page = 0; page < LIVE_SESSION_PAGE_CAP; page += 1) {
        const listed = await ctx.session.list(cursor ? { cursor } : undefined);
        const pageRows = Array.isArray(listed) ? listed : (listed?.data ?? []);
        cursor = Array.isArray(listed) ? undefined : listed?.cursor?.next;
        for (const candidate of pageRows) {
          if (candidate?.location?.directory !== directory) continue;
          if (typeof candidate?.id !== "string" || !candidate.id) continue;
          if (!blocking(candidate)) continue;
          if (foundIDs.has(candidate.id)) continue;
          foundIDs.add(candidate.id);
          found.push({
            sessionID: candidate.id,
            state: stateOf(candidate),
            lastTurnEnd: epoch(candidate?.time?.idle) ?? null,
          });
        }
        if (!cursor) break;
      }
      if (cursor)
        throw new Error(
          `the live-session walk did not exhaust within the ${LIVE_SESSION_PAGE_CAP}-page cap; refusing to act on a partial session list`,
        );
      return { sessions: found, mode: "list" };
    }
    const found: Array<{
      sessionID: string;
      state: string;
      lastTurnEnd: number | null;
    }> = [];
    for (const sessionID of [row?.session].filter(Boolean) as string[]) {
      let info: any;
      try {
        info = await ctx.session.get({ sessionID });
      } catch {
        continue; // the session is gone; nothing live to block on
      }
      if (blocking(info))
        found.push({
          sessionID,
          state: stateOf(info),
          lastTurnEnd: epoch(info?.time?.idle) ?? null,
        });
    }
    return { sessions: found, mode: "tracked" };
  }

  const worktreeAddSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path of the worktree to create.",
      },
      branch: {
        type: "string",
        description:
          "Branch to create at `base` and check out in the new worktree. When a local branch of this name already exists, it is checked out instead, and `base`, when also given, must then be exactly its tip.",
      },
      base: {
        type: "string",
        description:
          'Commit the new branch starts from — a ref ("origin/main", a branch name) or a sha. Omitted: the repository\'s current HEAD.',
      },
      repo: {
        type: "string",
        description:
          "Repository to add the worktree to (any directory inside it works). Omitted: this session's own directory.",
      },
    },
    required: ["path", "branch"],
    additionalProperties: false,
  };

  const worktreeAddTool: ToolDefinition = {
    name: "worktree_add",
    description: `Create a git worktree on a branch and track it. Runs \`git worktree add\` in \`repo\` (this session's directory when omitted): a new branch \`branch\` starting at \`base\` (the repo's HEAD when omitted) is created and checked out at \`path\`; when a local branch named \`branch\` already exists it is checked out instead, and a given \`base\` must then be exactly its tip. The tracking row (worktree_list's source) records the path, branch, head, base, and this session as owner. Fails named — never silently — when git refuses: a path that already exists, a branch already checked out in another worktree, a base that does not resolve.`,
    input: worktreeAddSchema,
    output: REPLY_OUTPUT,
    execute: async (raw, context) => {
      const owner = context?.sessionID;
      if (!owner)
        throw new Error("worktree_add: tool context carried no session id");
      const input = raw || {};
      const path = String(input.path || "").trim();
      if (!path) throw new Error("worktree_add: path is required");
      if (!path.startsWith("/"))
        throw new Error(`worktree_add: path must be absolute, got "${path}"`);
      const branch = String(input.branch || "").trim();
      if (!branch) throw new Error("worktree_add: branch is required");
      const base =
        input.base === undefined || input.base === null
          ? undefined
          : String(input.base).trim();
      if (base !== undefined && !base)
        throw new Error(
          "worktree_add: base, when given, must be a ref or a sha",
        );
      const repo = String(input.repo || "").trim() || ctx.location?.directory;
      if (!repo)
        throw new Error(
          "worktree_add: no repo to add to — pass repo, or run from a session with a directory",
        );
      const steps: string[] = [];
      try {
        // The repo resolves first, so a path that is no repository at
        // all refuses before the branch logic runs — a show-ref failure
        // there would otherwise read as "branch does not exist".
        await gitRun(repo, ["rev-parse", "--git-dir"]);
        steps.push(`resolved the repository at ${repo}`);
        // A given base resolves once, before anything runs: the
        // branch-exists tip check and the row's baseCommit read the same
        // resolution.
        const baseCommit =
          base !== undefined
            ? await gitRun(repo, ["rev-parse", "--verify", `${base}^{commit}`])
            : null;
        const exists = await gitRun(repo, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ]).then(
          () => true,
          () => false,
        );
        if (exists) {
          steps.push(`branch ${branch} exists; checking it out`);
          if (baseCommit !== null) {
            const tip = await gitRun(repo, [
              "rev-parse",
              "--verify",
              `refs/heads/${branch}^{commit}`,
            ]);
            if (tip !== baseCommit)
              throw new Error(
                `branch ${branch} is at ${tip}, not at ${base} (${baseCommit}) — name the base it is really at, or rebase the branch`,
              );
            steps.push(`branch ${branch} is at ${base} (${baseCommit})`);
          }
          await gitRun(repo, ["worktree", "add", path, branch]);
          steps.push(`created worktree ${path} on ${branch}`);
        } else {
          const args = ["worktree", "add", "-b", branch, path];
          if (baseCommit !== null) args.push(base!);
          await gitRun(repo, args);
          steps.push(
            baseCommit !== null
              ? `created worktree ${path} on new branch ${branch} at ${base} (${baseCommit})`
              : `created worktree ${path} on new branch ${branch} at the repo HEAD`,
          );
        }
        const state = await worktreeState(path);
        const mainRepo = await mainRepoOf(path);
        await trackWorktree({
          path,
          repo: mainRepo,
          branch: state.branch ?? branch,
          head: state.head,
          base: base ?? null,
          baseCommit,
          owner,
          session: null,
        });
        steps.push(`tracked the worktree for this session`);
        debug("worktree.added", { path, branch, owner });
        const reply = {
          ok: true,
          path,
          branch: state.branch ?? branch,
          head: state.head,
          base: base ?? null,
          repo: mainRepo,
        };
        return { content: JSON.stringify(reply), output: reply };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `worktree_add failed: ${reason}. Completed steps: ${
            steps.length ? steps.join("; ") : "none"
          }.`,
        );
      }
    },
  };

  const worktreeRemoveSchema = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path of the worktree to remove. It must be tracked by the director module (worktree_add, or a dispatch that validated it) — the claims that make removal safe live in its row.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  };

  const worktreeRemoveTool: ToolDefinition = {
    name: "worktree_remove",
    description: `Remove a tracked git worktree, claims-safe. Before \`git worktree remove\` runs, the tool checks the claims and refuses with the reason named, never force-dropping silently: uncommitted work in the tree (tracked changes and untracked files both count — commit, stash, or discard first), and any live session in the path (busy, or waiting on a first turn — steer or wait them out first). A path the module does not track is refused: the claims that make removal safe live in the tracking row. The branch survives removal — only the worktree directory goes — and the tracking row is dropped with the worktree. A tracked path whose worktree is already gone from its repo prunes the stale row instead (the result says pruned, not removed).`,
    input: worktreeRemoveSchema,
    output: REPLY_OUTPUT,
    execute: async (raw, context) => {
      const caller = context?.sessionID;
      if (!caller)
        throw new Error("worktree_remove: tool context carried no session id");
      const input = raw || {};
      const path = String(input.path || "").trim();
      if (!path) throw new Error("worktree_remove: path is required");
      if (!path.startsWith("/"))
        throw new Error(
          `worktree_remove: path must be absolute, got "${path}"`,
        );
      const key = `${WORKTREE_PREFIX}${encodeURIComponent(path)}`;
      const stored = await ctx.storage.get(key);
      const row = (
        stored && typeof stored === "object" ? stored : null
      ) as WorktreeRow | null;
      if (!row || typeof row.path !== "string" || typeof row.repo !== "string")
        throw new Error(
          `worktree_remove: no tracked worktree at ${path} — the module removes only what it tracks (worktree_add, or a dispatch that validated the worktree), because the claims that make removal safe live in its row`,
        );
      const steps: string[] = [];
      try {
        const live = await liveSessionsIn(path, row);
        if (live.sessions.length) {
          const named = live.sessions
            .map(
              (session) =>
                `${session.sessionID} (${session.state}${
                  session.lastTurnEnd === null ? ", never ended a turn" : ""
                })`,
            )
            .join(", ");
          throw new Error(
            `${live.sessions.length} live session${
              live.sessions.length === 1 ? "" : "s"
            } in ${path}: ${named} — steer or wait out the session first; removal never drops a worktree out from under a live session`,
          );
        }
        const listing = parseWorktreeList(
          await gitRun(row.repo, ["worktree", "list", "--porcelain"]),
        );
        const liveTree = listing.find((tree) =>
          sameWorktreePath(tree.path, path),
        );
        if (!liveTree) {
          await ctx.storage.remove(key);
          steps.push(`the worktree was already gone from ${row.repo}`);
          debug("worktree.pruned", { path, caller });
          const prunedReply = {
            ok: true,
            pruned: path,
            liveSessionCheck: live.mode,
            note: "no worktree existed at the path; the stale tracking row was dropped",
          };
          return { content: JSON.stringify(prunedReply), output: prunedReply };
        }
        const status = await gitRun(path, ["status", "--porcelain"]);
        if (status !== "") {
          const count = status.split("\n").length;
          throw new Error(
            `${path} carries uncommitted work — ${count} ${
              count === 1 ? "entry" : "entries"
            } in git status (tracked changes and untracked files both count). Commit, stash, or discard first; removal never discards silently`,
          );
        }
        await gitRun(row.repo, ["worktree", "remove", path]);
        steps.push(`removed the worktree at ${path}`);
        await ctx.storage.remove(key);
        steps.push("dropped the tracking row");
        debug("worktree.removed", { path, caller });
        const reply = {
          ok: true,
          removed: path,
          branch: liveTree.branch,
          head: liveTree.head,
          liveSessionCheck: live.mode,
        };
        return { content: JSON.stringify(reply), output: reply };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `worktree_remove failed: ${reason}. Completed steps: ${
            steps.length ? steps.join("; ") : "none"
          }.`,
        );
      }
    },
  };

  const worktreeListSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };

  const worktreeListTool: ToolDefinition = {
    name: "worktree_list",
    description: `Read the tracked worktrees with their live git state, whole in one call: per worktree, its path, repo, branch and head as they are now, the base it was checked against and that base's recorded commit, the owning session, the worker session living in it (when a validated dispatch named one), and the checks that answer the lifecycle questions — dirty (uncommitted work in the tree), upToDate (head is exactly at the base ref's current tip), merged (the branch, or a detached head, is an ancestor of that tip), stale (the head sits strictly behind that tip). A worktree no longer present in its repo reads state "missing" with the git-derived checks null and an error naming why. Worktrees added without a base carry null for the base checks: the checks answer only what a base can ground. Sorted newest-tracked first; a scan that cannot exhaust fails named instead of composing from a partial set.`,
    input: worktreeListSchema,
    output: REPLY_OUTPUT,
    execute: async (raw, context) => {
      const caller = context?.sessionID;
      if (!caller)
        throw new Error("worktree_list: tool context carried no session id");
      if (
        raw !== undefined &&
        raw !== null &&
        typeof raw === "object" &&
        Object.keys(raw).length > 0
      )
        throw new Error(
          "worktree_list: takes no arguments — the tracked set renders whole",
        );
      const scan = await scanEveryRow(ctx.storage, WORKTREE_PREFIX);
      const rows: WorktreeRow[] = [];
      for (const entry of scan) {
        const row = decodeWorktreeRow(entry);
        if (row) rows.push(row);
        else
          console.error(
            `[director] worktree_list: skipping unreadable row ${entry.key}`,
          );
      }
      rows.sort((a, b) => b.createdAt - a.createdAt);
      // One git call per question per repo, memoized across the rows of
      // this one read: the listing per repo, a base ref's tip per
      // (repo, base).
      const listings = new Map<
        string,
        Array<{ path: string; head: string | null; branch: string | null }>
      >();
      const baseTips = new Map<string, string | null>();
      const worktrees: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        const live: {
          state: string;
          branch: string | null;
          head: string | null;
          dirty: boolean | null;
          upToDate: boolean | null;
          merged: boolean | null;
          stale: boolean | null;
        } = {
          state: "missing",
          branch: null,
          head: null,
          dirty: null,
          upToDate: null,
          merged: null,
          stale: null,
        };
        let error: string | undefined;
        try {
          if (!listings.has(row.repo))
            listings.set(
              row.repo,
              parseWorktreeList(
                await gitRun(row.repo, ["worktree", "list", "--porcelain"]),
              ),
            );
          const tree = listings
            .get(row.repo)!
            .find((found) => found.path === row.path);
          if (!tree) {
            error = `no worktree at ${row.path} in ${row.repo} anymore`;
          } else {
            live.state = "live";
            live.branch = tree.branch;
            live.head = tree.head;
            try {
              live.dirty =
                (await gitRun(row.path, ["status", "--porcelain"])) !== "";
            } catch (statusError: any) {
              error = statusError.message;
            }
            if (row.base) {
              const tipKey = `${row.repo}\u0000${row.base}`;
              if (!baseTips.has(tipKey))
                baseTips.set(
                  tipKey,
                  await gitRun(row.repo, [
                    "rev-parse",
                    "--verify",
                    `${row.base}^{commit}`,
                  ]).catch(() => null),
                );
              const tip = baseTips.get(tipKey);
              if (tip) {
                live.upToDate = tree.head === tip;
                const subject = (tree.branch ?? tree.head)!;
                live.merged = await gitRun(row.repo, [
                  "merge-base",
                  "--is-ancestor",
                  subject,
                  tip,
                ]).then(
                  () => true,
                  () => false,
                );
                live.stale =
                  !live.upToDate &&
                  (await gitRun(row.repo, [
                    "merge-base",
                    "--is-ancestor",
                    tree.head!,
                    tip,
                  ]).then(
                    () => true,
                    () => false,
                  ));
              } else {
                error =
                  error ??
                  `base ${row.base} does not resolve in ${row.repo} anymore`;
              }
            }
          }
        } catch (liveError: any) {
          error = liveError.message;
        }
        worktrees.push({
          path: row.path,
          repo: row.repo,
          branch: live.branch,
          head: live.head,
          base: row.base ?? null,
          baseCommit: row.baseCommit ?? null,
          owner: row.owner,
          session: row.session ?? null,
          createdAt: new Date(row.createdAt).toISOString(),
          state: live.state,
          dirty: live.dirty,
          upToDate: live.upToDate,
          merged: live.merged,
          stale: live.stale,
          ...(error ? { error } : {}),
        });
      }
      debug("worktree.listed", { caller, worktrees: worktrees.length });
      const reply = {
        ok: true,
        worktrees,
        count: worktrees.length,
      };
      return { content: JSON.stringify(reply), output: reply };
    },
  };

  // The strictness here is deliberate: `input` is a plain JSON Schema object
  // flow, which the host's converter passes through untouched, and strict
  // objects surface argument mistakes as tool errors instead of crashes on
  // undefined fields later.
  // from @sysread/thatch (src/opencode/v2.ts ~186-204, MIT): the plain-JSON-schema-over-zod rationale.
  const registration = await ctx.tool.transform((editor) => {
    editor.add(dispatchTool);
    editor.add(steerTool);
    editor.add(statusTool);
    editor.add(readTool);
    editor.add(sessionsTool);
    editor.add(manifestWriteTool);
    editor.add(manifestReadTool);
    editor.add(manifestDropTool);
    editor.add(worktreeAddTool);
    editor.add(worktreeRemoveTool);
    editor.add(worktreeListTool);
  });

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        // Per-event isolation: a throw inside one handler must not end the
        // loop — a dead pump means no mail ever arrives again, and the miss
        // would be silent. Each event is handled with its own blast radius:
        // the failure is said, and the loop continues.
        // from @sysread/thatch (src/opencode/v2.ts ~472-476, MIT): the same
        // per-event try/catch shape around the pump's event body.
        try {
          const data = event.data || {};
          switch (event.type) {
            // The next terminal is a new turn's, not a repeat of the last
            // one, and this activation sees the turn from its start: text
            // left over from a turn that never mailed is dropped. A new
            // turn also re-checks a session found foreign before.
            //
            // A turn the host resumes after a restart starts again here
            // like any other turn; its mail cannot tell that text from
            // before the restart is missing, because the started event
            // carries nothing that marks a resume.
            case "session.execution.started": {
              foreign.delete(data.sessionID);
              buffers.delete(data.sessionID);
              const entry = await adopted(data.sessionID);
              if (entry) {
                entry.pendingTurn = true;
                entry.midTurn = false;
                // PRJ-499: the new turn's step evidence starts empty —
                // the truncation verdict reads only this turn's final
                // step, never the previous turn's.
                stepStates.set(data.sessionID, {
                  textSeen: false,
                  open: false,
                });
                finalSteps.delete(data.sessionID);
              }
              break;
            }
            // The full value of one assistant text block; streaming deltas
            // beside it are live-only fragments.
            case "session.text.ended": {
              const entry = await adopted(data.sessionID, { onText: true });
              if (!entry) break;
              const buffer = buffers.get(data.sessionID) || [];
              buffer.push({ text: data.text || "" });
              buffers.set(data.sessionID, buffer);
              // PRJ-499: text arrived during an open step — the step
              // produced its own text.
              const stepState = stepStates.get(data.sessionID);
              if (stepState?.open) stepState.textSeen = true;
              break;
            }
            // The usage stream (PRJ-525): a step's start carries the model
            // ref its usage is measured under, so the ref is remembered
            // per session and paired with the tokens the step's end
            // carries. The start adopts the worker like an execution
            // start — it is the turn's beginning, and a just-dispatched
            // worker's first turn records its usage this way.
            case "session.step.started": {
              const entry = await adopted(data.sessionID);
              if (entry) {
                // PRJ-499: the open step's text sighting resets here, and
                // any earlier step's record stops being the turn's newest.
                stepStates.set(data.sessionID, { textSeen: false, open: true });
                finalSteps.delete(data.sessionID);
              }
              const ref = data.model;
              if (
                entry &&
                ref &&
                typeof ref.providerID === "string" &&
                typeof ref.id === "string"
              )
                stepModels.set(data.sessionID, {
                  providerID: ref.providerID,
                  id: ref.id,
                });
              break;
            }
            // A step's end carries the step's full TokenUsage.Info. It is
            // recorded only for already-tracked workers — adopting here
            // could mislabel a mid-turn activation, since a start-less end
            // means this activation came in mid-turn — and only when the
            // tokens pass the anchor's own usability test, so a
            // zero-token step never overwrites a good sample. A failed
            // step's partial tokens (session.step.failed) are never
            // recorded: the turn's last completed step is the anchor
            // equivalent, not its failure.
            case "session.step.ended": {
              if (foreign.has(data.sessionID) || !track.has(data.sessionID))
                break;
              // PRJ-499: the step's shape rides its end — the finish
              // reason and the output-token count, with whether the step
              // produced any text. A step whose start was never seen here
              // records nothing.
              const stepState = stepStates.get(data.sessionID);
              if (stepState?.open) {
                finalSteps.set(data.sessionID, {
                  finish: typeof data.finish === "string" ? data.finish : "",
                  output: Number(data.tokens?.output ?? 0),
                  hadText: stepState.textSeen,
                });
                stepState.open = false;
              }
              const model = stepModels.get(data.sessionID);
              const tokens = data.tokens;
              if (
                !model ||
                !tokens ||
                typeof tokens !== "object" ||
                typeof tokens.input !== "number"
              )
                break;
              if (!(promptTokensOf(tokens) > 0)) break;
              usageSamples.set(data.sessionID, { tokens, model });
              break;
            }
            case "session.execution.succeeded": {
              // PRJ-499: a turn whose final step ended (provider finish
              // "stop") without producing one text block is a degenerate
              // completion — the model cut out mid-execution, and the
              // host's drain reads it as a normal end. It files as its own
              // kind, the way a failure or an interrupt does. No recorded
              // step (a mid-turn join, a restart) keeps kind "report":
              // no evidence, no verdict.
              const finalStep = finalSteps.get(data.sessionID);
              const truncated =
                finalStep !== undefined &&
                finalStep.finish === "stop" &&
                !finalStep.hadText;
              await deliver(
                event,
                truncated ? "truncated" : "report",
                truncated
                  ? `the turn's final step ended with no text and no tool call (provider finish=stop, ${finalStep.output} output tokens)`
                  : null,
              );
              break;
            }
            case "session.execution.failed": {
              const error = data.error || {};
              const reason =
                [error.type, error.message].filter(Boolean).join(": ") ||
                "the turn failed without a recorded reason";
              await deliver(event, "failed", reason);
              break;
            }
            // "shutdown" is the host's reason for any interrupt that names
            // none. The host may resume that turn, but its resumed end is
            // not guaranteed to reach here, so it gets its own report.
            case "session.execution.interrupted":
              if (data.reason === "shutdown") {
                await deliver(event, "interrupted", null);
                break;
              }
              await deliver(
                event,
                "failed",
                `the turn was interrupted before it completed${data.reason ? ` (${data.reason})` : ""}`,
              );
              break;
            // A moved session is re-checked against its new location; a
            // deleted one stays ignored.
            case "session.moved":
              forget(data.sessionID);
              break;
            case "session.deleted":
              forget(data.sessionID);
              foreign.add(data.sessionID);
              break;
          }
        } catch (handlerError) {
          console.error(
            `[director] event handler failed (${event.type}): ${handlerError}`,
          );
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error(`[director] event subscription failed: ${error}`);
      }
    }
  })();

  return () => {
    controller.abort();
    reminderController?.abort();
    void Promise.resolve(registration?.dispose?.());
    void Promise.resolve(hookRegistration?.dispose?.());
    void Promise.resolve(reminderRegistration?.dispose?.());
  };
};

export default {
  id: "director",
  setup,
};

// The dispatch stamp's pin and a host-reported model ref render as the
// "providerID/modelID" string the dispatch tool takes — variant appended
// only when present.
function modelText(model: any): string | null {
  if (!model || typeof model !== "object") return null;
  const providerID =
    typeof model.providerID === "string" ? model.providerID : "";
  const id = typeof model.id === "string" ? model.id : "";
  if (!providerID || !id) return null;
  const variant = typeof model.variant === "string" ? model.variant : "";
  return `${providerID}/${id}${variant ? `#${variant}` : ""}`;
}

// The tool's whole model knob, parsed the way opencode's Model.Ref.parse
// (packages/schema/src/model.ts) parses references: a required provider id
// before the first "/", the model id after it — which may carry its own
// slashes and colons — up to an optional "#variant". The grammar mirrors
// the schema; it does not police beyond it. Returns null when absent and
// undefined when present but malformed.
function parseModelPin(value: unknown):
  | null
  | undefined
  | {
      providerID: string;
      id: string;
      variant?: string;
      text: string;
    } {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  const providerEnd = text.indexOf("/");
  if (providerEnd <= 0) return undefined;
  const providerID = text.slice(0, providerEnd);
  const variantStart = text.indexOf("#", providerEnd + 1);
  const id = text.slice(
    providerEnd + 1,
    variantStart === -1 ? undefined : variantStart,
  );
  const variant =
    variantStart === -1 ? undefined : text.slice(variantStart + 1);
  if (
    !id ||
    providerID.includes("#") ||
    (variant !== undefined && (!variant || variant.includes("#")))
  ) {
    return undefined;
  }
  return {
    providerID,
    id,
    ...(variant ? { variant } : {}),
    text: `${providerID}/${id}${variant ? `#${variant}` : ""}`,
  };
}

// Numbers out of a JSON-schema-typed tool input: absent or malformed
// falls to the default, everything is clamped into range.
function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const numeric =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : NaN;
  return Number.isNaN(numeric)
    ? fallback
    : Math.min(Math.max(numeric, min), max);
}

function deriveTitle(brief: string): string {
  const line = brief.split("\n").find((candidate) => candidate.trim());
  const title = line ? line.trim().slice(0, 48) : "";
  return title || "director worker";
}

// PRJ-444 helpers: the module runs `git worktree` itself (node:child_process
// execFile, no shell — every argument is passed verbatim), and the refusal
// texts these tools make or surface carry the command and stderr verbatim,
// so a director can re-run the failing command by hand.
function gitRun(
  cwd: string,
  args: string[],
  timeoutMs = 30000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || "").trim() || error.message;
          reject(new Error(`git ${args.join(" ")} in ${cwd}: ${detail}`));
          return;
        }
        resolve(String(stdout).trim());
      },
    );
  });
}

// The main repo a worktree belongs to: the common dir minus its trailing
// .git, or the common dir itself when the repo is bare. Removal and
// list-time git calls run there or in the worktree — never from inside
// the worktree being removed.
// The paths one worktree, as spelled by different writers: git
// normalizes symlinked path components (/tmp → /private/tmp on darwin),
// so a tracking row's path and the listing's can disagree in spelling
// and still name the same tree — a raw string compare would read a live
// worktree as already gone and prune its row over the directory. The
// strict compare first — the common case — then the filesystem's own
// answer, when both paths still exist.
function sameWorktreePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

async function mainRepoOf(directory: string): Promise<string> {
  const common = await gitRun(directory, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const stripped = common.replace(/\/\.git$/, "");
  return stripped === "" ? common : stripped;
}

// `git worktree list --porcelain`, parsed: one {path, head, branch} block
// per worktree, in the order git listed them. A detached worktree carries
// branch null (the porcelain says `detached`, the branch line is absent);
// a bare main repo row carries both null and matches by path like any
// other block.
function parseWorktreeList(text: string): Array<{
  path: string;
  head: string | null;
  branch: string | null;
}> {
  const worktrees: Array<{
    path: string;
    head: string | null;
    branch: string | null;
  }> = [];
  let current:
    | { path: string; head: string | null; branch: string | null }
    | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = {
        path: line.slice("worktree ".length),
        head: null,
        branch: null,
      };
      worktrees.push(current);
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .replace(/^refs\/heads\//, "");
    }
  }
  return worktrees;
}

// The live git state of one worktree: HEAD sha, checked-out branch (null
// when detached), and whether uncommitted changes sit in the tree —
// tracked modifications and untracked files both count. Any leg failing
// (no repository, no commits yet) rejects with the command and stderr
// named, which the callers turn into the refusal's wording.
async function worktreeState(directory: string): Promise<{
  head: string;
  branch: string | null;
  dirty: boolean;
}> {
  const head = await gitRun(directory, ["rev-parse", "--verify", "HEAD"]);
  const ref = await gitRun(directory, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = await gitRun(directory, ["status", "--porcelain"]);
  return {
    head,
    branch: ref === "HEAD" ? null : ref,
    dirty: status !== "",
  };
}
