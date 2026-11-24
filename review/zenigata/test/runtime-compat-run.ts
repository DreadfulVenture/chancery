/**
 * The zenigata runtime compatibility check's runner (PRJ-479): it boots the
 * PACKAGED serve from a built runtime package and runs the driver's
 * integration tests (review/zenigata/test/runtime-compat.ts) against it.
 * This is the file the flake's zenigata-runtime-compat check invokes in one
 * line; the Makefile's test-runtime-compat target invokes the same thing,
 * so the check runs with or without nix.
 *
 * Usage:
 *   node runtime-compat-run.ts --runtime <runtime-package-path>
 *        [--test-dir <review/zenigata/test>] [--keep]
 *
 * The harness lives here end to end: its own XDG-pinned workspace (the
 * serve touches nothing of the invoking user's opencode state), the
 * scripted OpenAI-compatible mock (fixtures/zt-openai-mock.ts) serving
 * both the chat turns and the model catalog, the composed deployment-
 * shaped config home, the serve boot with a dead proxy so no external
 * fetch can hang the run, and a readiness poll that waits for the model
 * wiring rather than a bound port. Exit 0 only when the tests ran and
 * passed; a skip or a partial run is a failure.
 *
 * Exit codes: 0 pass, 1 failure, 2 usage.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVE_PASSWORD = "ztcompat";
const READY_TIMEOUT_MS = 240_000;
const CATALOG = {
  openai: {
    id: "openai",
    name: "ZT Compat Catalog",
    env: [] as string[],
    models: {},
  },
};

interface RunnerArgs {
  runtime: string;
  testDir: string | null;
  keep: boolean;
}

function usage(message: string): never {
  console.error(`zt runtime-compat: ${message}`);
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

const scriptDir = dirname(fileURLToPath(import.meta.url));

const args = parseArgs(process.argv.slice(2));
const testDir = resolve(args.testDir ?? scriptDir);
const runtime = resolve(args.runtime);
const compatTest = join(testDir, "runtime-compat.ts");
const mockScript = join(testDir, "fixtures", "zt-openai-mock.ts");
const composeScript = join(testDir, "fixtures", "zt-compose-config.ts");
for (const path of [compatTest, mockScript, composeScript]) {
  if (!existsSync(path)) usage(`missing harness file ${path}`);
}

const workspace = mkdtempSync(join(tmpdir(), "zt-compat-"));
const dirs = {
  home: join(workspace, "h"),
  config: join(workspace, "cfg"),
  data: join(workspace, "data"),
  state: join(workspace, "state"),
  cache: join(workspace, "cache"),
  proj: join(workspace, "proj"),
};

console.log(`zt runtime-compat: workspace ${workspace}`);

let mock: ReturnType<typeof spawn> | null = null;
let serve: ReturnType<typeof spawn> | null = null;
let exitCode = 1;

process.on("exit", () => {
  for (const child of [mock, serve]) {
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
    "zt-compat-worker-read-ok: the tool-using child read this file\n",
  );

  const mockPort = await freePort();
  mock = spawn(process.execPath, [mockScript], {
    env: {
      ...process.env,
      ZT_MOCK_PORT: String(mockPort),
      ZT_MOCK_PORT_FILE: join(workspace, "mock-port"),
      ZT_MOCK_CATALOG_FILE: catalogPath,
      ZT_MOCK_READ_TARGET: readTarget,
      ZT_MOCK_READ_MARKER: "zt-compat-worker-read-ok",
    },
    cwd: dirs.proj,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const mockPortFile = join(workspace, "mock-port");
  let bound: string | null = null;
  for (let i = 0; i < 100 && bound === null; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (existsSync(mockPortFile)) {
      bound = readFileSync(mockPortFile, "utf8").trim();
    }
  }
  if (!bound) throw new Error("the mock never bound a port");
  const mockEvents = `http://127.0.0.1:${bound}/events`;

  const composed = spawnSync(
    process.execPath,
    [
      composeScript,
      join(runtime, "share/zenigata/opencode/config.json"),
      join(runtime, "share/zenigata/agent/reviewer.md"),
      `http://127.0.0.1:${bound}/v1`,
      dirs.config,
    ],
    { stdio: "inherit" },
  );
  if (composed.status !== 0) {
    throw new Error(`config composition failed (${composed.status})`);
  }

  const servePort = await freePort();
  serve = spawn(
    join(runtime, "bin/opencode"),
    ["serve", "--port", String(servePort), "--hostname", "127.0.0.1"],
    {
      env: {
        ...process.env,
        HOME: dirs.home,
        XDG_CONFIG_HOME: dirs.config,
        XDG_DATA_HOME: dirs.data,
        XDG_STATE_HOME: dirs.state,
        XDG_CACHE_HOME: dirs.cache,
        OPENCODE_SERVER_PASSWORD: SERVE_PASSWORD,
        OPENCODE_MODELS_PATH: catalogPath,
        OPENCODE_MODELS_URL: `http://127.0.0.1:${bound}`,
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_LOG_LEVEL: "DEBUG",
        http_proxy: "http://127.0.0.1:9",
        https_proxy: "http://127.0.0.1:9",
        no_proxy: "127.0.0.1,localhost",
      },
      cwd: dirs.proj,
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  // Readiness is not a bound port: the config plugins finish loading after
  // the listener comes up, so the poll waits until the provider route
  // answers — the moment the model wiring the tests depend on is live.
  const serveUrl = `http://127.0.0.1:${servePort}`;
  const startedAt = Date.now();
  let ready = false;
  for (let i = 0; i * 500 < READY_TIMEOUT_MS; i++) {
    if (serve.exitCode !== null) {
      throw new Error("the serve exited before readiness");
    }
    const auth = Buffer.from(`opencode:${SERVE_PASSWORD}`).toString("base64");
    const ok = await fetch(`${serveUrl}/api/provider/openai`, {
      headers: { Authorization: `Basic ${auth}` },
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
    `zt runtime-compat: serve ready after ${Math.round((Date.now() - startedAt) / 100) / 10}s`,
  );

  const testEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: dirs.cache,
    ZT_RUNTIME_SERVE_URL: serveUrl,
    ZT_RUNTIME_SERVE_KEY: SERVE_PASSWORD,
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
  exitCode = 0;
} catch (error) {
  console.error(`zt runtime-compat: ${String(error)}`);
  exitCode = 1;
}

process.exit(exitCode);
