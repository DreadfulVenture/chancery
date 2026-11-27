/**
 * The zenigata runtime acceptance harness (PRJ-548): it stands the whole
 * PACKAGED runtime up through the exact service-shaped invocation — one
 * env file sourced into the package's launcher (the bin a unit's
 * ExecStart runs), plus the deployment's own opencode.jsonc placed in the
 * config directory the launcher points the serve at — and runs the
 * review-shaped pass against it. This is the file the flake's
 * zenigata-runtime-compat check invokes in one line; the Makefile's
 * test-runtime-compat target invokes the same thing, so the check runs
 * with or without nix.
 *
 * Nothing between the env file and a reviewable stack: the launcher
 * starts the packaged serve inside the config directory — the package's
 * floor as opencode.json and, when the deployment ships one, its
 * opencode.jsonc beside it, the v2.3.0 serve reading both and layering
 * the jsonc over the json — and execs the bot beside it. The deployment's
 * file carries the fixture's model route and forge MCP — the
 * deployment-injected
 * credential-bearing surfaces (PRJ-501) — and layers over the package
 * floor through the serve's own precedence.
 *
 * The harness lives here end to end: its own XDG-pinned workspace, the
 * scripted OpenAI-compatible mock (fixtures/zt-openai-mock.ts) serving
 * the chat turns and the model catalog, the local fakes
 * (fixtures/zt-accept-fakes.ts) carrying the forge adapter and the MCP
 * forge surface, the fixture bare repository the review pipeline clones,
 * and a readiness poll that waits for the model wiring rather than a
 * bound port. The driver probes (runtime-compat.ts) run against the
 * stack's serve; the review pass posts one review event through the
 * bot's intake and asserts the landed review on the fake forge.
 *
 * Exit 0 only when the probes and the pass ran and passed; a skip or a
 * partial run is a failure.
 *
 * Exit codes: 0 pass, 1 failure, 2 usage.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVE_KEY = "zt-accept-key";
const READY_TIMEOUT_MS = 240_000;
const RUN_TIMEOUT_MS = 240_000;
const CATALOG = {
  openai: {
    id: "openai",
    name: "ZT Accept Catalog",
    env: [] as string[],
    models: {},
  },
};
const REPO = "zt-accept/widgets";
const PR = 7;

interface RunnerArgs {
  runtime: string;
  testDir: string | null;
  keep: boolean;
}

function usage(message: string): never {
  console.error(`zt accept: ${message}`);
  console.error(
    "usage: node runtime-compat-run.ts --runtime <path> [--test-dir <dir>] [--keep]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): RunnerArgs {
  const args: RunnerArgs = {
    runtime: null as never,
    testDir: null,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--keep") {
      args.keep = true;
      continue;
    }
    const value = argv[i + 1];
    if (flag === "--runtime") {
      args.runtime = value;
      i++;
    } else if (flag === "--test-dir") {
      args.testDir = value;
      i++;
    } else {
      usage(`unknown argument ${flag}`);
    }
  }
  if (!args.runtime || !existsSync(args.runtime)) {
    usage("--runtime must name a built zenigata-runtime package path");
  }
  return args;
}

/** One free loopback port, released immediately for the caller to bind. */
function freePort(): Promise<number> {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server: Server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address()?.port;
      if (port === undefined) {
        rejectPort(new Error("no port"));
        return;
      }
      server.close(() => resolvePort(port));
    });
    server.on("error", rejectPort);
  });
}

/** Coreutils only, resolved from the host: a profile `bin` can carry more
 * than coreutils (the build host's own node or git among it), so `ls` is
 * resolved to its real store path and the session shell's base PATH stays
 * free of the toolchain the wrapper's suffix must alone supply. */
function coreutilsPath(): string {
  const which = spawnSync("which", ["ls"], { encoding: "utf8" });
  const dir = which.status === 0 ? dirname(which.stdout.trim()) : "/usr/bin";
  const real = spawnSync("readlink", ["-f", join(dir, "ls")], {
    encoding: "utf8",
  });
  const resolved = real.status === 0 ? real.stdout.trim() : "";
  if (resolved.startsWith("/nix/store/")) return dirname(resolved);
  return dir;
}

/** Run git in the fixture scratch tree; a failure throws named. */
function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? ""}`);
  }
  return result.stdout;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));

const args = parseArgs(process.argv.slice(2));
const testDir = resolve(args.testDir ?? scriptDir);
const runtime = resolve(args.runtime);
const compatTest = join(testDir, "runtime-compat.ts");
const mockScript = join(testDir, "fixtures", "zt-openai-mock.ts");
const fakesScript = join(testDir, "fixtures", "zt-accept-fakes.ts");
for (const path of [compatTest, mockScript, fakesScript]) {
  if (!existsSync(path)) usage(`missing harness file ${path}`);
}

const workspace = mkdtempSync(join(tmpdir(), "zt-accept-"));
const dirs = {
  home: join(workspace, "h"),
  data: join(workspace, "data"),
  state: join(workspace, "state"),
  cache: join(workspace, "cache"),
  proj: join(workspace, "proj"),
  botState: join(workspace, "bot-state"),
};

console.log(`zt accept: workspace ${workspace}`);

let mock: ReturnType<typeof spawn> | null = null;
let fakes: ReturnType<typeof spawn> | null = null;
let stack: ReturnType<typeof spawn> | null = null;
let exitCode = 1;
/** The fakes' bound ports, readable by the failure diagnostics. */
let mockBound: string | null = null;
let fakeBound: string | null = null;

process.on("exit", () => {
  for (const child of [mock, fakes, stack]) {
    if (child && child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
  if (!args.keep && workspace.startsWith(tmpdir())) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

try {
  for (const dir of Object.values(dirs)) {
    if (dir === dirs.proj) continue;
    mkdirSync(dir, { recursive: true });
  }

  // The serve's cwd is a git repo in the workspace: the project-directory
  // shape a deployment's cwd has.
  spawnSync("git", ["init", "-q", dirs.proj], { stdio: "ignore" });
  if (!existsSync(join(dirs.proj, ".git"))) {
    throw new Error("git init failed; the serve's project directory needs it");
  }

  // The fixture repository the review pipeline clones (file:// scheme,
  // allowed by the pipeline's clone allowlist): two branches, base and
  // main, one commit apart.
  const scratch = join(workspace, "scratch");
  git(workspace, ["init", "-q", "-b", "main", scratch]);
  git(scratch, ["config", "user.email", "zt-accept@example.invalid"]);
  git(scratch, ["config", "user.name", "ZT Accept"]);
  writeFileSync(join(scratch, "README.md"), "base line\n");
  git(scratch, ["add", "README.md"]);
  git(scratch, ["commit", "-q", "-m", "base"]);
  git(scratch, ["branch", "base"]);
  writeFileSync(join(scratch, "README.md"), "base line\nchanged line\n");
  git(scratch, ["add", "README.md"]);
  git(scratch, ["commit", "-q", "-m", "the fixture change"]);
  git(workspace, [
    "clone",
    "-q",
    "--bare",
    scratch,
    join(workspace, "fixture.git"),
  ]);
  const headSha = git(scratch, ["rev-parse", "main"]).trim();
  const baseSha = git(scratch, ["rev-parse", "base"]).trim();
  const cloneUrl = `file://${join(workspace, "fixture.git")}`;

  // The serve's model catalog comes from the check itself: the minimal
  // fixture as the boot-time floor (MODELS_PATH) and the mock as the
  // refresh source (MODELS_URL), so the catalog populates over loopback
  // with no network.
  const catalogPath = join(workspace, "catalog.json");
  writeFileSync(catalogPath, JSON.stringify(CATALOG, null, 2));

  // The worker child's read target: a marker file in the project
  // directory, whose content the child's read tool call must return for
  // the check to count the call as succeeded under the config floor.
  const readTarget = join(dirs.proj, "zt-worker-read.txt");
  writeFileSync(
    readTarget,
    "zt-accept-worker-read-ok: the tool-using child read this file\n",
  );

  const mockPort = await freePort();
  mock = spawn(process.execPath, [mockScript], {
    env: {
      ...process.env,
      ZT_MOCK_PORT: String(mockPort),
      ZT_MOCK_PORT_FILE: join(workspace, "mock-port"),
      ZT_MOCK_CATALOG_FILE: catalogPath,
      ZT_MOCK_READ_TARGET: readTarget,
      ZT_MOCK_READ_MARKER: "zt-accept-worker-read-ok",
      // The review flow's post args: the fake forge's identity.
      ZT_MOCK_REPO: REPO,
      ZT_MOCK_PR: String(PR),
      ZT_MOCK_HEAD_SHA: headSha,
    },
    cwd: dirs.proj,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const mockPortFile = join(workspace, "mock-port");
  for (let i = 0; i < 100 && mockBound === null; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (existsSync(mockPortFile)) {
      mockBound = readFileSync(mockPortFile, "utf8").trim();
    }
  }
  if (!mockBound) throw new Error("the mock never bound a port");
  const mockEvents = `http://127.0.0.1:${mockBound}/events`;

  const fakePort = await freePort();
  fakes = spawn(process.execPath, [fakesScript], {
    env: {
      ...process.env,
      ZT_FAKE_PORT: String(fakePort),
      ZT_FAKE_PORT_FILE: join(workspace, "fake-port"),
      ZT_FAKE_HEAD_SHA: headSha,
      ZT_FAKE_BASE_SHA: baseSha,
      ZT_FAKE_CLONE_URL: cloneUrl,
      ZT_FAKE_REPO: REPO,
      ZT_FAKE_PR: String(PR),
    },
    cwd: dirs.proj,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const fakePortFile = join(workspace, "fake-port");
  for (let i = 0; i < 100 && fakeBound === null; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (existsSync(fakePortFile)) {
      fakeBound = readFileSync(fakePortFile, "utf8").trim();
    }
  }
  if (!fakeBound) throw new Error("the fakes never bound a port");
  const fakeBase = `http://127.0.0.1:${fakeBound}`;

  const servePort = await freePort();
  const botPort = await freePort();

  // The deployment's config, as the deployment ships it: one
  // opencode.jsonc placed beside the package floor's opencode.json in the
  // config directory, the two-file shape the v2.3.0 serve's own
  // precedence layers (both files load from one directory, jsonc wins for
  // settings). The fixture's file carries the model route and the forge
  // MCP the reviewer posts through — the credential-bearing surfaces the
  // deployment injects (PRJ-501), here pointing at the local fakes — and
  // its permission rows land after the floor's, so the worker child's
  // read allows and the reviewer's forge-tool row are what beat the
  // floor's deny-all.
  const configHome = join(workspace, "config-home");
  mkdirSync(configHome, { recursive: true });
  symlinkSync(
    join(runtime, "share/zenigata/opencode-home/opencode.json"),
    join(configHome, "opencode.json"),
  );
  symlinkSync(
    join(runtime, "share/zenigata/opencode-home/agent"),
    join(configHome, "agent"),
  );
  symlinkSync(
    join(runtime, "share/zenigata/opencode-home/skills"),
    join(configHome, "skills"),
  );
  const overridePath = join(configHome, "opencode.jsonc");
  writeFileSync(
    overridePath,
    JSON.stringify(
      {
        model: "openai/reviewer",
        agents: {
          "zenigata-reviewer": { model: "openai/reviewer" },
          "zt-worker": { mode: "subagent", model: "openai/worker" },
        },
        providers: {
          openai: {
            package: "@opencode/ai/providers/openai/chat",
            name: "ZT Mock via OpenAI",
            settings: {
              baseURL: `http://127.0.0.1:${mockBound}/v1`,
              apiKey: "zt-accept-dummy",
            },
            models: {
              reviewer: { name: "Reviewer" },
              worker: { name: "Worker" },
            },
          },
        },
        mcp: {
          ztforge: {
            type: "remote",
            url: `${fakeBase}/mcp`,
            enabled: true,
          },
        },
        // The permission rows named for the surfaces the override wires
        // (the action format the v2.3.0 source composes): the worker's
        // read — whose target sits outside the session's own directory,
        // so the path action rides beside it — and the reviewer's forge
        // tool.
        permissions: [
          { action: "read", resource: "*", effect: "allow" },
          { action: "external_directory", resource: "*", effect: "allow" },
          { action: "ztforge_create_review", resource: "*", effect: "allow" },
        ],
      },
      null,
      2,
    ),
  );

  // The fixture env file — the EnvironmentFile a unit declares, sourced
  // with `set -a` exactly as the operator's invocation does. Every secret
  // and endpoint the stack needs rides here; nothing is assembled.
  const envFile = join(workspace, "zenigata.env");
  const envLines = [
    `ZENIGATA_STATE_DIR=${dirs.botState}`,
    `ZENIGATA_ALLOWED_LOGINS=example-user`,
    `ZENIGATA_LISTEN_PORT=${botPort}`,
    `OPENCODE_SERVE_PORT=${servePort}`,
    // The deployment's config placement: the composed directory holding
    // the package floor and the deployment's opencode.jsonc — the
    // launcher's config-home default yields when a deployment ships no
    // file.
    `OPENCODE_CONFIG_DIR=${configHome}`,
    `ZENIGATA_OPENCODE_KEY=${SERVE_KEY}`,
    `ZENIGATA_ADAPTER_URL=${fakeBase}`,
    `ZENIGATA_ADAPTER_TOKEN=adapter-secret`,
    `ZENIGATA_EVENT_TOKEN=event-secret`,
    `ZENIGATA_FORGE_URL=https://forge.example.invalid`,
    // Recall is advisory by the pipeline's own contract: the dead port
    // proves a memory outage costs the run nothing. The value is quoted
    // because the file is a shell file too — the operator's invocation
    // sources it — and an unquoted `&` splits the assignment.
    `ZENIGATA_MEMORY_URL='http://127.0.0.1:9/mcp?app=zenigata&initiator=agent'`,
    `OPENCODE_DISABLE_MODELS_FETCH=1`,
    `OPENCODE_MODELS_PATH=${catalogPath}`,
    `OPENCODE_MODELS_URL=http://127.0.0.1:${mockBound}`,
    `http_proxy=http://127.0.0.1:9`,
    `https_proxy=http://127.0.0.1:9`,
    `no_proxy=127.0.0.1,localhost`,
    `HOME=${dirs.home}`,
    `XDG_CONFIG_HOME=${join(workspace, "xdg-config")}`,
    `XDG_DATA_HOME=${dirs.data}`,
    `XDG_STATE_HOME=${dirs.state}`,
    `XDG_CACHE_HOME=${dirs.cache}`,
  ];
  writeFileSync(envFile, `${envLines.join("\n")}\n`);
  mkdirSync(join(workspace, "xdg-config"), { recursive: true });

  // The spawned shell replica: the deployed failure mode (PRJ-539) is a
  // service account whose login shell is nologin — systemd delivers that
  // shell as $SHELL, and the serve's shell-select resolves the session
  // shell from process.env.SHELL alone. The stub prints nologin's message
  // and exits 1 for any command, so a session shell the config's `shell`
  // key does not override dies exactly the deployed way. With it in $SHELL,
  // the runtime config's shell key is the session shell's only working
  // source — a regression there lands the shell probes red.
  const stubShell = join(workspace, "nologin-shell");
  writeFileSync(
    stubShell,
    "#!/bin/sh\necho 'This account is currently not available.'\nexit 1\n",
  );
  chmodSync(stubShell, 0o755);

  // THE INVOCATION (PRJ-548's definition of done): the env file sourced,
  // the package's launcher started — the deployment's config rides no env
  // var; it is the file the config home directory places beside the
  // floor. One process pair, zero manual assembly — this is the whole
  // story between the env file and a running, reviewable stack.
  const launcher = join(runtime, "bin", "zenigata-stack");
  stack = spawn(
    "/bin/sh",
    ["-c", `set -a; . '${envFile}'; set +a; exec '${launcher}'`],
    {
      env: {
        ...process.env,
        // Coreutils only: the wrapper's --suffix PATH must be the session
        // shell's only source of node and git, so the base PATH here may
        // carry neither — the toolchain probe is otherwise green with the
        // wrapper deleted and guards nothing.
        PATH: coreutilsPath(),
        SHELL: stubShell,
      },
      cwd: dirs.proj,
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  // Readiness is not a bound port: the config plugins finish loading after
  // the listener comes up, so the poll waits until the provider route
  // answers — the moment the model wiring the tests depend on is live.
  // Each attempt carries its own timeout, so a serve that accepts and
  // never answers fails the attempt and the wall-clock bound reaches the
  // named failure instead of hanging past every bound.
  const serveUrl = `http://127.0.0.1:${servePort}`;
  const startedAt = Date.now();
  let ready = false;
  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    if (stack.exitCode !== null) {
      throw new Error("the stack exited before readiness");
    }
    const auth = Buffer.from(`opencode:${SERVE_KEY}`).toString("base64");
    const ok = await fetch(`${serveUrl}/api/provider/openai`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15_000),
    })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    throw new Error(
      `the serve's model wiring never came up within ${READY_TIMEOUT_MS / 1000}s`,
    );
  }
  console.log(
    `zt accept: stack ready after ${Math.round((Date.now() - startedAt) / 100) / 10}s`,
  );

  const testEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dirs.home,
    XDG_CONFIG_HOME: join(workspace, "xdg-config"),
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: dirs.cache,
    ZT_RUNTIME_SERVE_URL: serveUrl,
    ZT_RUNTIME_SERVE_KEY: SERVE_KEY,
    ZT_RUNTIME_MOCK_EVENTS: mockEvents,
    ZT_RUNTIME_DIST: join(runtime, "dist"),
  };
  const test = spawnSync(process.execPath, [compatTest], {
    env: testEnv,
    cwd: dirs.proj,
    encoding: "utf8",
  });
  process.stdout.write(test.stdout ?? "");
  process.stderr.write(test.stderr ?? "");
  if (test.status !== 0) {
    throw new Error(`the compat tests failed (${test.status})`);
  }
  if (!/^.*compat ok/m.test(test.stdout ?? "")) {
    // A skip is a failure: the environment above always provides the
    // variables, so the run must have run.
    throw new Error("the compat tests did not run to completion");
  }

  // --- The review-shaped pass ---------------------------------------------
  //
  // One review event through the bot's intake: the pipeline guards, the
  // per-PR worktree from the fixture repo, the reviewer session running
  // its own skill flow (the review-pr load the package's own tree
  // serves), the post through the deployment's forge MCP, and the
  // bookkeeping lookup — the run's outcome reads back through the same
  // adapter fake the post landed on.

  const event = {
    kind: "review_requested",
    eventId: "zt-accept-event-1",
    repo: REPO,
    pr: PR,
    requesterLogin: "example-user",
    commentId: "zt-accept-comment-1",
    text: "please review",
  };
  const accepted = await fetch(
    `${serveUrl.replace(`:${servePort}`, `:${botPort}`)}/v1/events`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer event-secret`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (accepted.status !== 202) {
    throw new Error(
      `the intake refused the review event with ${accepted.status}: ${await accepted.text()}`,
    );
  }

  const botStatus = `http://127.0.0.1:${botPort}/status`;
  const runDeadline = Date.now() + RUN_TIMEOUT_MS;
  let settled: {
    outcome: string;
    failure?: { stage: string; message: string };
  } | null = null;
  while (Date.now() < runDeadline) {
    if (stack.exitCode !== null) {
      throw new Error("the stack exited while the review run was in flight");
    }
    const status = (await fetch(botStatus, {
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.json())
      .catch(() => null)) as {
      runs?: Array<{
        repo: string;
        pr: number;
        outcome: string;
        failure?: { stage: string; message: string };
      }>;
    } | null;
    const row = status?.runs?.find((r) => r.repo === REPO && r.pr === PR);
    if (row && row.outcome !== "queued") {
      settled = row;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!settled) {
    throw new Error(
      `the review run never settled within ${RUN_TIMEOUT_MS / 1000}s`,
    );
  }
  if (settled.outcome !== "posted") {
    throw new Error(
      `the review run settled ${settled.outcome}: ${JSON.stringify(settled.failure ?? {})}`,
    );
  }

  // The landed review's evidence: the fake forge recorded one post (via
  // the reviewer session's MCP tool), against the head the event named,
  // and the skill load row says the package's own tree served review-pr
  // into the session.
  const fakeEvents = (await fetch(`${fakeBase}/events`).then((r) =>
    r.json(),
  )) as {
    events: Array<{ kind: string; at: number; detail?: unknown }>;
    posts: Array<{ via: string; expectedHeadSha: string; body: string }>;
  };
  const post = fakeEvents.posts.at(-1);
  if (!post) {
    throw new Error(
      "the fake forge recorded no review post: the session never landed the review",
    );
  }
  if (post.via !== "mcp") {
    throw new Error(
      `the review landed via ${post.via}, not the deployment's forge MCP`,
    );
  }
  if (post.expectedHeadSha !== headSha) {
    throw new Error(
      `the review landed against ${post.expectedHeadSha}, not the requested head ${headSha}`,
    );
  }
  const skillRow = (await (await fetch(mockEvents)).json())
    .filter(
      (e: { kind: string; stage?: string; succeeded?: boolean }) =>
        e.kind === "review-flow" && e.stage === "skill-loaded",
    )
    .at(-1) as { succeeded?: boolean } | undefined;
  if (!skillRow?.succeeded) {
    throw new Error(
      "the reviewer session's skill load did not return the review-pr content: the package's skills tree never reached the session",
    );
  }
  console.log("zt accept: the review-shaped pass landed a posted review");

  exitCode = 0;
} catch (error) {
  console.error(`zt accept: ${String(error)}`);
  // The failure diagnostics: the mock's worker-read rows carry the read
  // result text (the denial or path error), the fake forge's events name
  // the surfaces that were and were not reached — the runner prints what
  // a manual probe would read before its children go down with it.
  if (mockBound !== null) {
    await fetch(`http://127.0.0.1:${mockBound}/events`)
      .then((r) => r.json())
      .then((events: Array<{ kind: string; [k: string]: unknown }>) => {
        for (const row of events.filter((e) =>
          ["worker-read", "parent-tool", "review-flow"].includes(e.kind),
        )) {
          console.error("zt accept: mock row:", JSON.stringify(row));
        }
      })
      .catch(() => undefined);
  }
  if (fakeBound !== null) {
    await fetch(`http://127.0.0.1:${fakeBound}/events`)
      .then((r) => r.json())
      .then((data: { events: Array<{ kind: string }> }) => {
        console.error(
          "zt accept: fake forge events:",
          JSON.stringify(data.events.map((e) => e.kind)),
        );
      })
      .catch(() => undefined);
  }
  exitCode = 1;
}

process.exit(exitCode);
