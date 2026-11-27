/**
 * The zenigata runtime compatibility check (PRJ-479): the session driver
 * runs its contract against the PACKAGED opencode serve, and the delegated
 * pass's settle barrier is the critical assertion. The contract is
 * behavior, not version equality: the @opencode/client pin floats freely
 * through Renovate, and an upgrade that breaks the driver lands red here
 * naming the semantic break — on 2.3.x that is the always-background
 * subagent tool, where the driver's prompt settles while the child is
 * still working.
 *
 * PRJ-496 adds the reviewer-grant proofs: the packaged agent definition
 * ships its working grants in frontmatter, so the check runs the reviewer
 * session's real shell command and a webfetch against the harness's local
 * docs fake — both proving the file-defined reviewer's own grants won over
 * the config floor's deny-all. The round-trip probe doubles as the boot
 * canary: if the definition's frontmatter failed decode, this harness
 * fails immediately with the agent the driver selects unresolved.
 *
 * Run by the flake check (not the vitest suite): the harness boots the
 * packaged serve plus the scripted OpenAI-compatible mock
 * (test/fixtures/zt-openai-mock.ts) and invokes this file with node's type
 * stripping. Environment:
 *
 *   ZT_RUNTIME_SERVE_URL   — the packaged serve's base URL (required to run)
 *   ZT_RUNTIME_SERVE_KEY   — the serve's password (HTTP Basic, user `opencode`)
 *   ZT_RUNTIME_MOCK_EVENTS — the mock's GET /events endpoint (required)
 *   ZT_RUNTIME_DIST        — the packaged zenigata dist directory carrying
 *                            the built driver and the @opencode/client pin
 *
 * With the environment unset the file exits 0 without running, so an
 * accidental ordinary `npm test` pickup does nothing; the flake check
 * detects a no-op run by parsing the output for the "compat ok" line.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serveUrl = process.env.ZT_RUNTIME_SERVE_URL;
const serveKey = process.env.ZT_RUNTIME_SERVE_KEY;
const mockEvents = process.env.ZT_RUNTIME_MOCK_EVENTS;
const distPath = process.env.ZT_RUNTIME_DIST;

if (!serveUrl || !serveKey || !mockEvents || !distPath) {
  console.log(
    "zt runtime-compat: skipped (ZT_RUNTIME_SERVE_URL / ZT_RUNTIME_SERVE_KEY / ZT_RUNTIME_MOCK_EVENTS / ZT_RUNTIME_DIST unset)",
  );
  process.exit(0);
}

// A runaway turn must fail the check, not hang the derivation.
const watchdog = setTimeout(() => {
  console.error("zt runtime-compat: timed out after 240s");
  process.exit(1);
}, 240_000);
watchdog.unref?.();

const { opencodeSessionDriver } = await import(
  join(distPath, "adapters/opencode.js")
);

const driver = opencodeSessionDriver({
  baseUrl: serveUrl,
  apiKey: serveKey,
  turnPollSeconds: 0.5,
  turnBudgetSeconds: 120,
});

const workDir = mkdtempSync(join(tmpdir(), "zt-compat-"));

// --- One real prompt round-trip through the packaged serve ---------------

const roundtrip = await driver.createSession(workDir, "zenigata-reviewer");
await driver.prompt(
  roundtrip,
  "Round-trip probe: reply with the scripted text.",
);
const roundtripOutput = await driver.readOutput(roundtrip);
assert.match(
  roundtripOutput,
  /runtime compat round-trip/,
  `the round-trip turn produced unexpected output: ${JSON.stringify(roundtripOutput)}`,
);
await driver.dispose(roundtrip);

// --- The delegated-pass settle barrier -----------------------------------
//
// The delegator model calls the subagent tool; the worker model (the child)
// takes 2s to answer. On a serve whose subagent tool blocks the parent
// turn, the driver's prompt settles only after the child's report landed,
// and readOutput carries the parent's final text. On an always-background
// subagent tool the prompt settles during the child's 2s wait and the
// output is not the final text — both asserts fail red, naming the break.

const delegated = await driver.createSession(workDir, "zenigata-reviewer");
await driver.prompt(delegated, "Delegate to the worker now.");
const settledAt = Date.now();

const events = await (await fetch(mockEvents)).json();
const child = events.filter(
  (event) => event.kind === "chat-done" && event.model === "worker",
);
if (child.length === 0) {
  // The failure diagnostic: the mock's event tail says whether the
  // delegator made its subagent call at all and which model the child
  // rode — an unresolved agent file and a misrouted model read
  // differently here.
  console.error(
    "zt runtime-compat: mock event tail:",
    JSON.stringify(events.slice(-12)),
  );
}
assert.ok(
  child.length > 0,
  "the delegated pass never ran a child turn through the mock",
);
const childDone = child.at(-1).at;
assert.ok(
  childDone <= settledAt,
  `the turn settled at ${settledAt} while the child's report landed at ${childDone}: the serve settles delegated passes before the subagent work completes (the always-background subagent semantics this runtime cannot drive)`,
);
// The child-grant evidence: the worker's scripted `read` tool call must
// have returned the marker file's content, so the file-defined child's
// own grants won over the config floor's deny-all carve-out.
const read = events.filter((event) => event.kind === "worker-read");
assert.ok(read.length > 0, "the child never made its scripted read tool call");
assert.ok(
  read.at(-1).succeeded === true,
  "the child's read tool call did not return the marker file's content: the file-defined agent's own grants did not win over the config floor",
);
const delegatedOutput = await driver.readOutput(delegated);
assert.match(
  delegatedOutput,
  /parent final after the subagent report/,
  `the delegated pass settled without the subagent's report; output was ${JSON.stringify(delegatedOutput)}`,
);
await driver.dispose(delegated);

// --- The reviewer's own grants (PRJ-496) ---------------------------------
//
// The packaged definition ships its working grants in frontmatter; a
// file-defined agent's rules land after the config floor and win. Two
// probes exercise them on the reviewer session itself: a real shell
// command (the bash tool's action is `shell`) and a webfetch against the
// local docs fake — never a live docs site. Each probe runs in its own
// session, and the mock's parent-tool row records whether the tool result
// carried the expected marker. The events feed is re-fetched after each
// probe: the snapshot the delegated section read predates both, and the
// rows must be read after their probe's rows exist.

const shellSession = await driver.createSession(workDir, "zenigata-reviewer");
await driver.prompt(
  shellSession,
  "Shell probe: run the shell command the script gives you.",
);
const shellOutput = await driver.readOutput(shellSession);
assert.match(
  shellOutput,
  /compat shell ran/,
  `the shell probe's final turn did not report the command's output: ${JSON.stringify(shellOutput)}`,
);
await driver.dispose(shellSession);

const shellOk = (await (await fetch(mockEvents)).json()).filter(
  (event: { kind: string; tool?: string }) =>
    event.kind === "parent-tool" && event.tool === "shell",
);
assert.ok(
  shellOk.length > 0,
  "the reviewer never made its scripted shell tool call",
);
assert.ok(
  shellOk.at(-1).succeeded === true,
  "the shell tool call did not return the marker's echo: the reviewer's own grants did not win over the config floor",
);

const docsSession = await driver.createSession(workDir, "zenigata-reviewer");
await driver.prompt(
  docsSession,
  "Docs probe: fetch the docs page the script names.",
);
const docsOutput = await driver.readOutput(docsSession);
assert.match(
  docsOutput,
  /compat docs/,
  `the docs probe's final turn did not report the fetched page: ${JSON.stringify(docsOutput)}`,
);
await driver.dispose(docsSession);

const docsOk = (await (await fetch(mockEvents)).json()).filter(
  (event: { kind: string; tool?: string }) =>
    event.kind === "parent-tool" && event.tool === "webfetch",
);
assert.ok(
  docsOk.length > 0,
  "the reviewer never made its scripted webfetch tool call",
);
assert.ok(
  docsOk.at(-1).succeeded === true,
  "the webfetch tool call did not return the docs fake's page: the web-lookup grant did not win over the config floor",
);

// --- The shipped skills tree reaches the reviewer session (PRJ-539) -------
//
// The runtime package ships the opencode assets tree at
// share/skills.opencode, the harness composes it into the config home the
// way the deployment documentation names, and the reviewer session's skill
// guidance must list the skill — the delivery the deployed runtime lacked.

const skillListed = (await (await fetch(mockEvents)).json()).filter(
  (event: { kind: string; skillListed?: boolean }) =>
    event.kind === "chat" && event.skillListed === true,
);
assert.ok(
  skillListed.length > 0,
  "no reviewer request carried the skills list naming review-pr: the skills tree the runtime package ships never reached the session through the composed config home",
);

// --- The packaged serve's shell and PATH (PRJ-539) ------------------------
//
// Two layers, both load-bearing under the runner's stripped spawn env (the
// runner sets a coreutils-only PATH and points $SHELL at a stub that
// refuses like the deployed account's nologin): the config's `shell` key
// is what the session shell runs through at all — without it the serve
// inherits the account's login shell and dies at spawn, below PATH — and
// the wrapper's PATH suffix is where node and git come from. The probe
// runs the two version checks through the same shell grant the shell
// probe used, and the mock's toolchain row records what came back.

const toolchainSession = await driver.createSession(
  workDir,
  "zenigata-reviewer",
);
await driver.prompt(
  toolchainSession,
  "Toolchain probe: run the version checks the script gives you.",
);
const toolchainOutput = await driver.readOutput(toolchainSession);
assert.match(
  toolchainOutput,
  /compat toolchain ran/,
  `the toolchain probe's final turn did not report the versions: ${JSON.stringify(toolchainOutput)}`,
);
await driver.dispose(toolchainSession);

const toolchainOk = (await (await fetch(mockEvents)).json()).filter(
  (event: { kind: string }) => event.kind === "toolchain",
);
assert.ok(
  toolchainOk.length > 0,
  "the reviewer never made its scripted toolchain shell call",
);
assert.ok(
  toolchainOk.at(-1).succeeded === true,
  "the session shell failed or came back without the versions: with the runner's coreutils-only PATH and the nologin stub as $SHELL, this is red when the config's `shell` key stops winning the spawn layer (the serve inherits the account's login shell and dies below PATH, the deployed failure) or when the wrapper's --suffix PATH stops carrying node and git",
);

console.log("zt runtime-compat: compat ok");
process.exit(0);
