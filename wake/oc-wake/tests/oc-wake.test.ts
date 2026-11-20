import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The oc-wake bin with its only trigger: --on-exit. The bin arms a detached
// watcher that polls the watched process and posts the host's schedule route
// with a one-shot `when: { in: "1 second" }`, so the fake host here answers
// that route and records what arrived. The watcher's fire semantics key on
// the stat STATE field (PRJ-383 review 179): a zombie or a vanished proc
// entry is "exited" — the orphan of a backgrounded command included — and
// the wake posts; an entry that exists but carries another starttime is the
// recycled-slug case: the watcher stops without a post. The scheduler, the
// tick loop, persistence, and delivery live in the host's own schedule
// service — upstream opencode code and its suite carry them — so these
// tests cover the wrapper's own surface. The /proc tree, the ticker, and
// the trace files are environment seams (OC_WAKE_PROC_ROOT,
// OC_WAKE_TICK_MS, OC_WAKE_STATE_FILE, OC_WAKE_LOG_FILE) so the recycled
// cases are deterministic; no live service or real state dir is touched,
// and the fake host listens on 127.0.0.1 with an ephemeral port. Watchers
// a test leaves armed (a fake proc tree never vanishes on its own) are
// killed through the pid the CLI prints — the same cancel the docs name.

const BIN = fileURLToPath(new URL("../bin/oc-wake", import.meta.url));
const TICK = "60";
const SEAM = { OC_WAKE_TICK_MS: TICK };

type Recorded = {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
};

type FakeHostOptions = {
  respond?: (recorded: Recorded[]) => {
    status: number;
    body?: unknown;
    contentType?: string;
  };
};

export function spawnWatcher(
  env: Record<string, string | undefined>,
): ChildProcess {
  // The env map is the options.env member, never the options object itself:
  // a flat map as options drops the env back to inherited, and the child
  // runs the wrong mode.
  return spawn(process.execPath, [BIN], { env });
}

function fakeHost(options: FakeHostOptions = {}) {
  let scheduleSeq = 0;
  const recorded: Recorded[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      recorded.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
      });
      const scripted = options.respond?.(recorded) ?? {
        status: 200,
        body: {
          data: {
            id: `sch_test${scheduleSeq}`,
            status: "active",
            nextDueAt: "soon",
          },
        },
      };
      response.writeHead(scripted.status, {
        "content-type": scripted.contentType ?? "application/json",
      });
      response.end(
        typeof scripted.body === "string"
          ? scripted.body
          : JSON.stringify(scripted.body ?? {}),
      );
    });
    request.on("error", () => {});
  });
  return new Promise<{
    url: string;
    recorded: () => Recorded[];
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(
        address && typeof address === "object",
        "the fake host bound a port",
      );
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        recorded: () => recorded,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function killWatcher(pid: number): void {
  // A capture can now precede the assertions that validate stdout, so a
  // failed arm can hand over 0 (kill would signal the process group) or
  // NaN; only a real pid is signalled.
  if (!(pid > 0)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone: the watcher finished its one job.
  }
}

// The stat row the bin parses: the filler covers state..itrealvalue, the
// starttime is field 22 (the twentieth token after the comm), the state
// character leads.
function statRow(
  pid: string,
  starttime: string,
  comm = "node -e setTimeout (() => {}, 800)",
  state = "S",
): string {
  return `${pid} (${comm}) ${state} 1 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${starttime} 9999999 100 0 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`;
}

type ProcEntry = {
  /** The starttime token (field 22) the stat file advertises. */
  starttime: string;
  /** The state character; defaults to S (running, not a zombie). */
  state?: string;
  comm?: string;
};

type ProcTree = { root: string; entry: (pid: string) => ProcEntry | undefined };

// A fake /proc tree: only the files the bin reads exist.
function makeProcRoot(
  entries: Record<string, ProcEntry | undefined>,
): ProcTree {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-wake-proc-"));
  for (const [pid, entry] of Object.entries(entries)) {
    if (entry === undefined) continue;
    writeEntry(root, pid, entry);
  }
  return { root, entry: (pid) => entries[pid] };
}

function writeEntry(root: string, pid: string, entry: ProcEntry): void {
  fs.mkdirSync(path.join(root, pid), { recursive: true });
  fs.writeFileSync(
    path.join(root, pid, "stat"),
    statRow(pid, entry.starttime, entry.comm, entry.state),
  );
  fs.writeFileSync(path.join(root, pid, "cmdline"), "long-check\0--flag=1");
}

function registrationFile(url: string, password?: string): string {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "oc-wake-test-")),
    "service.json",
  );
  fs.writeFileSync(
    file,
    JSON.stringify({
      id: "svc_test",
      version: "2.2.5",
      url,
      pid: 1,
      ...(password ? { password } : {}),
    }),
  );
  return file;
}

// Per-test trace paths: the outcome records and the watcher's stderr trail
// under a scratch dir, so no test touches the user's real state dir.
function tracePaths(): { state: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-wake-trace-"));
  return {
    state: path.join(dir, "oc-wake.jsonl"),
    log: path.join(dir, "oc-wake.log"),
  };
}

type RunResult = { exit: number | null; stdout: string; stderr: string };

async function run(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
  input: string | undefined = undefined,
): Promise<RunResult> {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { ...cleanEnv(), ...env },
  });
  return await collect(child, input);
}

// One collected child run: stdout, stderr, and its exit, resolved together.
// The watcher's stderr is invisible in production with no trace override
// (it rides the chancery stderr file); direct runs collect it so the
// anomalous-path lines stay testable.
async function collect(
  child: ChildProcess,
  input?: string,
): Promise<RunResult> {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("close", (code, signal) =>
      resolve({ exit: code ?? signal ?? -1, stdout, stderr }),
    );
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// The test process's own env can carry OPENCODE_* and OC_WAKE_* values (a
// tool shell's env reaches its children); every test states the whole env it
// wants, so both families are stripped and the overrides re-applied.
function cleanEnv(): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    clean[key] =
      key.startsWith("OPENCODE_") || key.startsWith("OC_WAKE_")
        ? undefined
        : value;
  }
  return clean;
}

// The watcher's env, complete: what the CLI parent assembles, stated in
// full for direct runs. `extra` adds discovery inputs and per-test message
// and trace-path tweaks.
function watcherEnv(
  proc: ProcTree,
  pid: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const entry = proc.entry(pid);
  assert.ok(
    entry,
    `the fake proc root must hold pid ${pid} for the watcher env`,
  );
  return {
    OC_WAKE_WATCHER: "1",
    OC_WAKE_PID: pid,
    OC_WAKE_STARTTIME: entry.starttime,
    OC_WAKE_MESSAGE: "wake me",
    OC_WAKE_NAME: `oc-wake on-exit ${pid}`,
    OC_WAKE_SESSION: "ses_target",
    OC_WAKE_PROC_ROOT: proc.root,
    ...SEAM,
    ...extra,
  };
}

type Outcome = {
  at?: string;
  watcher?: number;
  pid?: string;
  sessionID?: string;
  status?: string;
  scheduleId?: string;
  why?: string;
};

function outcomeLines(stateFile: string): Outcome[] {
  let text = "";
  try {
    text = fs.readFileSync(stateFile, "utf8");
  } catch {
    return [];
  }
  return text
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Outcome);
}

async function waitFor(probe: () => boolean, limit = 600): Promise<void> {
  for (let i = 0; i < limit && !probe(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!probe()) throw new Error("waitFor: condition never held");
}

const settle = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

test(
  "--on-exit arms a detached watcher that posts the envelope once at exit",
  async () => {
    const host = await fakeHost();
    // A fake proc entry, not a real child: the arm-vs-exit race a real
    // 300ms process runs (the CLI's node boot on a loaded machine can
    // lose to the process's exit and fail the arm) has no place here —
    // the entry exists until the test flips it to a zombie, and the
    // watcher's own loop does the rest.
    const proc = makeProcRoot({ "411": { starttime: "999000" } });
    const traces = tracePaths();
    let watcherPid: number | undefined;
    try {
      const armed = await run(
        [
          "--on-exit",
          "411",
          "--message",
          "check finished",
          "--url",
          host.url,
          "--session",
          "ses_target",
        ],
        {
          ...SEAM,
          OC_WAKE_PROC_ROOT: proc.root,
          OC_WAKE_STATE_FILE: traces.state,
          OC_WAKE_LOG_FILE: traces.log,
        },
      );
      // The pid is captured before anything can throw, so a failing
      // assertion still leaves the finally a watcher to cancel.
      const printed = JSON.parse(armed.stdout);
      watcherPid = printed.watcher;
      assert.equal(armed.exit, 0, armed.stderr);
      assert.equal(printed.ok, true);
      assert.equal(printed.watching, 411);
      assert.ok(printed.watcher > 0);
      assert.equal(printed.sessionID, "ses_target");
      assert.match(printed.note, /kill the watcher pid to cancel/);
      writeEntry(proc.root, "411", { starttime: "999000", state: "Z" });
      await waitFor(() => host.recorded().length === 1);
      const [only] = host.recorded();
      assert.equal(only.method, "POST");
      assert.equal(only.path, "/api/experimental/schedule");
      assert.deepEqual(only.body, {
        sessionID: "ses_target",
        name: "oc-wake on-exit 411",
        when: { in: "1 second" },
        prompt: "Scheduled wake (oc-wake): check finished",
      });
      // One schedule out of one exit: later tick windows do not produce more.
      await settle(250);
      assert.equal(host.recorded().length, 1);
      // The posted outcome is on record, and the happy path left the
      // watchdog's stderr file empty (only anomalies write there).
      const lines = outcomeLines(traces.state);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].status, "posted");
      assert.equal(lines[0].sessionID, "ses_target");
      assert.equal(lines[0].scheduleId, "sch_test0");
      assert.match(lines[0].why ?? "", /exit detected/);
      assert.ok(
        !fs.existsSync(traces.log) ||
          fs.readFileSync(traces.log, "utf8") === "",
        "happy stderr is silent",
      );
    } finally {
      if (watcherPid !== undefined) killWatcher(watcherPid);
      await host.close();
    }
  },
  { timeout: 15_000 },
);

test(
  "a pipe-carried message rides the envelope; --quiet prints only the watcher pid",
  async () => {
    const host = await fakeHost();
    // The vanished-entry exit semantics this time: the fake entry exists
    // at arm, and the watched process's disappearance is the test
    // deleting it — no real child, no race.
    const proc = makeProcRoot({ "412": { starttime: "999000" } });
    const traces = tracePaths();
    let watcherPid: number | undefined;
    try {
      const armed = await run(
        ["--on-exit", "412", "--message", "-", "--url", host.url, "--quiet"],
        {
          ...SEAM,
          OC_WAKE_PROC_ROOT: proc.root,
          OPENCODE_SESSION_ID: "ses_own",
          OC_WAKE_STATE_FILE: traces.state,
          OC_WAKE_LOG_FILE: traces.log,
        },
        "done running the long task\n",
      );
      // Same capture-before-assert order as the detached-watcher test: a
      // failed match must not leave the armed watcher unkilled.
      watcherPid = Number(armed.stdout.trim());
      assert.equal(armed.exit, 0, armed.stderr);
      assert.match(
        armed.stdout,
        /^\d+\n$/,
        "--quiet prints only the watcher pid",
      );
      fs.rmSync(path.join(proc.root, "412"), { recursive: true, force: true });
      await waitFor(() => host.recorded().length === 1);
      const [only] = host.recorded();
      assert.deepEqual(only.body, {
        sessionID: "ses_own",
        name: "oc-wake on-exit 412",
        when: { in: "1 second" },
        prompt: "Scheduled wake (oc-wake): done running the long task",
      });
    } finally {
      if (watcherPid !== undefined) killWatcher(watcherPid);
      await host.close();
    }
  },
  { timeout: 15_000 },
);

test(
  "a watched process that keeps running posts nothing and records nothing",
  async () => {
    const host = await fakeHost();
    const proc = makeProcRoot({ "71": { starttime: "999000" } });
    const traces = tracePaths();
    const watcher = spawnWatcher(
      watcherEnv(proc, "71", {
        OC_WAKE_URL: host.url,
        OC_WAKE_STATE_FILE: traces.state,
        OC_WAKE_LOG_FILE: traces.log,
      }),
    );
    try {
      await settle(350);
      assert.equal(
        host.recorded().length,
        0,
        "a live process must not produce a wake",
      );
      assert.deepEqual(
        outcomeLines(traces.state),
        [],
        "no decision, no outcome record",
      );
    } finally {
      watcher.kill("SIGKILL");
      await settle(50);
      await host.close();
    }
  },
  { timeout: 15_000 },
);

test(
  "a recycled pid (the slot returns with another starttime) stops the watcher with a trace and no post",
  async () => {
    const host = await fakeHost();
    const proc = makeProcRoot({ "42": { starttime: "1000" } });
    const traces = tracePaths();
    const watcher = spawnWatcher(
      watcherEnv(proc, "42", {
        OC_WAKE_URL: host.url,
        OC_WAKE_STATE_FILE: traces.state,
        OC_WAKE_LOG_FILE: traces.log,
      }),
    );
    try {
      // Between the watcher's reads the slot carries a stranger, so no vanish
      // is observed — the recycle swallowed the pid inside one tick window.
      await settle(120);
      writeEntry(proc.root, "42", {
        starttime: "2000",
        comm: "thief",
        state: "R",
      });
      const result = await collect(watcher);
      assert.equal(result.exit, 3);
      assert.equal(host.recorded().length, 0);
      // A lost wake leaves a trace: the anomalous path named, the outcome
      // recorded.
      assert.match(
        result.stderr,
        /recycled slug: pid 42 now carries starttime 2000, not the captured 1000/,
      );
      const lines = outcomeLines(traces.state);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].status, "recycled-slug");
      assert.equal(lines[0].pid, "42");
      assert.equal(lines[0].sessionID, "ses_target");
      assert.match(lines[0].why ?? "", /2000/);
    } finally {
      await host.close();
    }
  },
  { timeout: 15_000 },
);

test(
  "a recycled stranger that exits unreaped (state Z, foreign starttime) posts nothing",
  async () => {
    // Review id 200's combination: the watched pid is reaped and recycled
    // into a stranger's unreaped process, so the entry reads zombie with a
    // foreign starttime. Identity is checked before state, so this is a
    // recycled slug — the watcher leaves silently with a trace, and no wake
    // is posted for a process the caller never named.
    const host = await fakeHost();
    const proc = makeProcRoot({ "54": { starttime: "1000" } });
    const traces = tracePaths();
    const watcher = spawnWatcher(
      watcherEnv(proc, "54", {
        OC_WAKE_URL: host.url,
        OC_WAKE_STATE_FILE: traces.state,
        OC_WAKE_LOG_FILE: traces.log,
      }),
    );
    try {
      await settle(120);
      writeEntry(proc.root, "54", {
        starttime: "2000",
        comm: "thief",
        state: "Z",
      });
      const result = await collect(watcher);
      assert.equal(result.exit, 3);
      await settle(250);
      assert.equal(host.recorded().length, 0);
      assert.match(
        result.stderr,
        /recycled slug: pid 54 now carries starttime 2000/,
      );
      const lines = outcomeLines(traces.state);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].status, "recycled-slug");
    } finally {
      await host.close();
    }
  },
  { timeout: 15_000 },
);

test(
  "a vanished pid fires — the orphan of a backgrounded command included",
  async () => {
    const host = await fakeHost();
    const proc = makeProcRoot({ "43": { starttime: "1000" } });
    const traces = tracePaths();
    const watcher = spawnWatcher(
      watcherEnv(proc, "43", {
        OC_WAKE_URL: host.url,
        OC_WAKE_STATE_FILE: traces.state,
        OC_WAKE_LOG_FILE: traces.log,
      }),
    );
    try {
      await settle(120);
      fs.rmSync(path.join(proc.root, "43/stat"), { force: true });
      const result = await collect(watcher);
      assert.equal(result.exit, 0, result.stderr);
      await waitFor(() => host.recorded().length === 1);
      const lines = outcomeLines(traces.state);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].status, "posted");
      assert.match(lines[0].why ?? "", /stat vanished/);
      await settle(250);
      assert.equal(host.recorded().length, 1, "one vanish, one wake");
    } finally {
      await host.close();
    }
  },
  { timeout: 15_000 },
);

test(
  "a zombie fires: state Z means exited, reaped or not",
  async () => {
    const host = await fakeHost();
    const proc = makeProcRoot({ "44": { starttime: "1000" } });
    const traces = tracePaths();
    const watcher = spawnWatcher(
      watcherEnv(proc, "44", {
        OC_WAKE_URL: host.url,
        OC_WAKE_STATE_FILE: traces.state,
        OC_WAKE_LOG_FILE: traces.log,
      }),
    );
    try {
      await settle(120);
      writeEntry(proc.root, "44", {
        starttime: "1000",
        comm: "long-check",
        state: "Z",
      });
      const result = await collect(watcher);
      assert.equal(result.exit, 0, result.stderr);
      await waitFor(() => host.recorded().length === 1);
      const lines = outcomeLines(traces.state);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].status, "posted");
      assert.match(lines[0].why ?? "", /state Z/);
    } finally {
      await host.close();
    }
  },
  { timeout: 15_000 },
);

test(
  "a vanished pid whose slot returns as a stranger still fired once",
  async () => {
    const host = await fakeHost();
    const proc = makeProcRoot({ "45": { starttime: "1000" } });
    const traces = tracePaths();
    const watcher = spawnWatcher(
      watcherEnv(proc, "45", {
        OC_WAKE_URL: host.url,
        OC_WAKE_STATE_FILE: traces.state,
        OC_WAKE_LOG_FILE: traces.log,
      }),
    );
    try {
      await settle(120);
      fs.rmSync(path.join(proc.root, "45/stat"), { force: true });
      // The watcher fires on the vanish; whatever reuses the slot afterwards
      // is no part of the identity any more (pid + starttime is).
      const result = await collect(watcher);
      assert.equal(result.exit, 0, result.stderr);
      writeEntry(proc.root, "45", {
        starttime: "9000",
        comm: "thief",
        state: "R",
      });
      await settle(250);
      assert.equal(host.recorded().length, 1);
      assert.equal(outcomeLines(traces.state).length, 1);
    } finally {
      await host.close();
    }
  },
  { timeout: 15_000 },
);

test("the removed --after forms error as usage with the replacement note", async () => {
  for (const after of ["20m", "2h", "90s", "7d"]) {
    const result = await run(
      ["--after", after, "--message", "wake", "--url", "http://127.0.0.1:1"],
      SEAM,
    );
    assert.equal(result.exit, 2, after);
    assert.match(result.stderr, /--after was removed/);
  }
});

test("--password is rejected from argv in favour of the OC_WAKE_PASSWORD environment", async () => {
  const valueForm = await run(
    [
      "--on-exit",
      "1",
      "--password",
      "leaked-by-ps",
      "--message",
      "wake",
      "--url",
      "http://127.0.0.1:1",
    ],
    { OPENCODE_SESSION_ID: "s" },
  );
  assert.equal(valueForm.exit, 2);
  assert.match(valueForm.stderr, /--password was taken off the command line/);
  assert.match(valueForm.stderr, /OC_WAKE_PASSWORD/);

  const joinedForm = await run(
    [
      "--on-exit=1",
      "--password=leaked-by-ps",
      "--message",
      "wake",
      "--url",
      "http://127.0.0.1:1",
    ],
    { OPENCODE_SESSION_ID: "s" },
  );
  assert.equal(joinedForm.exit, 2);
  assert.match(joinedForm.stderr, /--password was taken off the command line/);
});

test("a NUL byte in the message is a usage error", async () => {
  const traces = tracePaths();
  const result = await run(
    ["--on-exit", "1", "--message", "-", "--url", "http://127.0.0.1:1"],
    { ...SEAM, OPENCODE_SESSION_ID: "s", OC_WAKE_LOG_FILE: traces.log },
    "part one\0part two",
  );
  assert.equal(result.exit, 2);
  assert.match(result.stderr, /NUL byte/);
});

test("arm-time validation: the pid and target shapes, an invalid --url, and a vanished target", async () => {
  const host = await fakeHost();
  const proc = makeProcRoot({ "72": { starttime: "1000" } });
  const traces = tracePaths();
  const armEnv = {
    ...SEAM,
    OC_WAKE_PROC_ROOT: proc.root,
    OC_WAKE_LOG_FILE: traces.log,
    OC_WAKE_STATE_FILE: traces.state,
  };
  try {
    const missingTrigger = await run(["--message", "wake", "--url", host.url], {
      OPENCODE_SESSION_ID: "s",
    });
    assert.equal(missingTrigger.exit, 2);
    assert.match(missingTrigger.stderr, /--on-exit <pid> is required/);

    for (const bad of ["0", "abc", "1.5"]) {
      const badPid = await run(
        ["--on-exit", bad, "--message", "wake", "--url", host.url],
        { OPENCODE_SESSION_ID: "s" },
      );
      assert.equal(badPid.exit, 2, bad);
      assert.match(badPid.stderr, /--on-exit must be a process id/);
    }
    // A dash-leading "pid" stops at the flag-eating guard first.
    const negative = await run(
      ["--on-exit", "-5", "--message", "wake", "--url", host.url],
      { OPENCODE_SESSION_ID: "s" },
    );
    assert.equal(negative.exit, 2);
    assert.match(negative.stderr, /--on-exit needs a value, not a flag/);

    const noMessage = await run(
      ["--on-exit", "1", "--message", "  ", "--url", host.url],
      { OPENCODE_SESSION_ID: "s" },
    );
    assert.equal(noMessage.exit, 2);
    assert.match(noMessage.stderr, /--message is required/);

    const noTarget = await run(
      ["--on-exit", "1", "--message", "wake", "--url", host.url],
      {},
    );
    assert.equal(noTarget.exit, 2);
    assert.match(noTarget.stderr, /no target session/);

    const unknown = await run(["--timer", "5"], {});
    assert.equal(unknown.exit, 2);
    assert.match(unknown.stderr, /unknown option: --timer/);

    const gone = await run(
      ["--on-exit", "73", "--message", "wake", "--url", "http://127.0.0.1:1"],
      { ...armEnv, OPENCODE_SESSION_ID: "s" },
    );
    assert.equal(gone.exit, 2);
    assert.match(gone.stderr, /no process with pid 73 on this machine/);

    // --url gets the arm-time guard the registration path gets: a malformed
    // or non-http(s) url fails named before the watcher detaches.
    const malformed = await run(
      ["--on-exit", "72", "--message", "wake", "--url", "not a url"],
      { ...armEnv, OPENCODE_SESSION_ID: "s" },
    );
    assert.equal(malformed.exit, 2);
    assert.match(malformed.stderr, /not a valid URL/);

    const scheme = await run(
      ["--on-exit", "72", "--message", "wake", "--url", "ftp://host/x"],
      { ...armEnv, OPENCODE_SESSION_ID: "s" },
    );
    assert.equal(scheme.exit, 2);
    assert.match(scheme.stderr, /must be http\(s\)/);

    // Without --url, the registration file is read up front; a missing one
    // names the path it looked at, and the watcher is never spawned.
    const noRegistration = await run(
      [
        "--on-exit",
        "72",
        "--message",
        "wake",
        "--service-file",
        "/no/such/opencode/service.json",
      ],
      { ...armEnv, OPENCODE_SESSION_ID: "s" },
    );
    assert.equal(noRegistration.exit, 1);
    assert.match(
      noRegistration.stderr,
      /no opencode service registration at .*\/no\/such\/opencode\/service\.json/,
    );

    // Every validation failure happens before any HTTP work: the fake host
    // saw nothing.
    assert.equal(host.recorded().length, 0);
  } finally {
    await host.close();
  }
});

test(
  "the watcher re-reads the registration at fire time and sends the host's basic credentials",
  async () => {
    const host = await fakeHost();
    const proc = makeProcRoot({ "46": { starttime: "1000" } });
    const traces = tracePaths();
    const file = registrationFile(host.url, "secret-password");
    const watcher = spawnWatcher(
      watcherEnv(proc, "46", {
        OC_WAKE_SERVICE_FILE: file,
        OC_WAKE_STATE_FILE: traces.state,
        OC_WAKE_LOG_FILE: traces.log,
      }),
    );
    try {
      fs.rmSync(path.join(proc.root, "46/stat"), { force: true });
      const result = await collect(watcher);
      assert.equal(result.exit, 0, result.stderr);
      const [only] = host.recorded();
      assert.equal(
        only.authorization,
        `Basic ${Buffer.from("opencode:secret-password").toString("base64")}`,
      );
    } finally {
      await host.close();
    }
  },
  { timeout: 15_000 },
);

test(
  "the OC_WAKE_PASSWORD environment reaches the post without touching argv",
  async () => {
    const host = await fakeHost();
    const proc = makeProcRoot({ "49": { starttime: "1000" } });
    const traces = tracePaths();
    const watcher = spawnWatcher(
      watcherEnv(proc, "49", {
        OC_WAKE_URL: host.url,
        OC_WAKE_PASSWORD: "env-password",
        OC_WAKE_STATE_FILE: traces.state,
        OC_WAKE_LOG_FILE: traces.log,
      }),
    );
    try {
      fs.rmSync(path.join(proc.root, "49/stat"), { force: true });
      const result = await collect(watcher);
      assert.equal(result.exit, 0, result.stderr);
      assert.equal(
        host.recorded()[0].authorization,
        `Basic ${Buffer.from("opencode:env-password").toString("base64")}`,
      );
    } finally {
      await host.close();
    }
  },
  { timeout: 15_000 },
);

test(
  "a host refusal surfaces as an exit-1 failure with the host's own text and a recorded why",
  async () => {
    const respond = {
      status: 403,
      body: {
        _tag: "ForbiddenError",
        message:
          "Scheduled tasks are disabled; set experimental.schedules in config",
      },
    };
    const host = await fakeHost({ respond: () => respond });
    const proc = makeProcRoot({ "48": { starttime: "1000" } });
    const traces = tracePaths();
    const watcher = spawnWatcher(
      watcherEnv(proc, "48", {
        OC_WAKE_URL: host.url,
        OC_WAKE_STATE_FILE: traces.state,
        OC_WAKE_LOG_FILE: traces.log,
      }),
    );
    try {
      fs.rmSync(path.join(proc.root, "48/stat"), { force: true });
      const result = await collect(watcher);
      assert.equal(result.exit, 1);
      assert.match(
        result.stderr,
        /the host refused the wake \(HTTP 403 ForbiddenError\)[\s\S]*Scheduled tasks are disabled/,
      );
      const lines = outcomeLines(traces.state);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].status, "failed");
      assert.match(lines[0].why ?? "", /Scheduled tasks are disabled/);
    } finally {
      await host.close();
    }
  },
  { timeout: 15_000 },
);

test(
  "a body read that dies mid-response still leaves the failed record before the error surfaces",
  async () => {
    // Review id 212's combination: the host accepts the POST, then the
    // connection dies during the body read — the fetch never throws, the
    // text() does. The watcher records the failed receipt and exits 1 with
    // the error named; a lost wake is not a lost trace.
    let arrivals = 0;
    const server = http.createServer((request, response) => {
      arrivals += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"data": {"id": "sch_cut');
      // Reset the socket before the body ends: text() rejects.
      setTimeout(() => response.socket?.destroy(), 30);
    });
    const host = await new Promise<{
      url: string;
      arrivals: () => number;
      close: () => Promise<void>;
    }>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        assert.ok(address && typeof address === "object");
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          arrivals: () => arrivals,
          close: () =>
            new Promise<void>((done) => {
              server.close(() => done());
            }),
        });
      });
    });
    const proc = makeProcRoot({ "55": { starttime: "1000" } });
    const traces = tracePaths();
    const watcher = spawnWatcher(
      watcherEnv(proc, "55", {
        OC_WAKE_URL: host.url,
        OC_WAKE_STATE_FILE: traces.state,
        OC_WAKE_LOG_FILE: traces.log,
      }),
    );
    try {
      fs.rmSync(path.join(proc.root, "55/stat"), { force: true });
      const result = await collect(watcher);
      assert.equal(result.exit, 1);
      assert.equal(host.arrivals(), 1, "the POST was accepted before the cut");
      assert.match(
        result.stderr,
        /the wake response body read failed after HTTP 200/,
      );
      const lines = outcomeLines(traces.state);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].status, "failed");
      assert.match(lines[0].why ?? "", /body read failed after HTTP 200/);
    } finally {
      await host.close();
    }
  },
  { timeout: 15_000 },
);

test(
  "session targeting: the env default, the positional, and --session outranking both",
  async () => {
    const host = await fakeHost();
    const proc = makeProcRoot({ "50": { starttime: "1" } });
    const traces = tracePaths();
    try {
      const envOnly = await run(
        ["--on-exit", "50", "--message", "wake", "--url", host.url],
        {
          ...SEAM,
          OC_WAKE_PROC_ROOT: proc.root,
          OPENCODE_SESSION_ID: "ses_env",
          OC_WAKE_LOG_FILE: traces.log,
          OC_WAKE_STATE_FILE: traces.state,
        },
      );
      assert.equal(envOnly.exit, 0, envOnly.stderr);
      killWatcher(JSON.parse(envOnly.stdout).watcher);
      assert.equal(JSON.parse(envOnly.stdout).sessionID, "ses_env");

      const positional = await run(
        [
          "ses_other",
          "--on-exit",
          "50",
          "--message",
          "wake",
          "--url",
          host.url,
        ],
        {
          ...SEAM,
          OC_WAKE_PROC_ROOT: proc.root,
          OPENCODE_SESSION_ID: "ses_env",
          OC_WAKE_LOG_FILE: traces.log,
          OC_WAKE_STATE_FILE: traces.state,
        },
      );
      assert.equal(positional.exit, 0, positional.stderr);
      killWatcher(JSON.parse(positional.stdout).watcher);
      assert.equal(JSON.parse(positional.stdout).sessionID, "ses_other");

      const flagged = await run(
        [
          "--session",
          "ses_flagged",
          "--on-exit",
          "50",
          "--message",
          "wake",
          "--url",
          host.url,
        ],
        {
          ...SEAM,
          OC_WAKE_PROC_ROOT: proc.root,
          OPENCODE_SESSION_ID: "ses_env",
          OC_WAKE_LOG_FILE: traces.log,
          OC_WAKE_STATE_FILE: traces.state,
        },
      );
      assert.equal(flagged.exit, 0, flagged.stderr);
      killWatcher(JSON.parse(flagged.stdout).watcher);
      assert.equal(JSON.parse(flagged.stdout).sessionID, "ses_flagged");

      // No armed watcher ever reached the host: every one above was killed
      // while the fake proc tree kept its pid alive and silent.
      await settle(200);
      assert.equal(host.recorded().length, 0);
    } finally {
      await host.close();
    }
  },
  { timeout: 15_000 },
);

test(
  "an inherited OC_WAKE_URL or OC_WAKE_SERVICE_FILE does not reach the watcher",
  async () => {
    // The registration file points the watcher at host A; the environment
    // smuggles host B. Scrubbed inputs mean the CLI's arguments (here: the
    // service file) are the only host the watcher can discover, so the post
    // lands on A and B records nothing.
    const hostA = await fakeHost();
    const hostB = await fakeHost();
    const proc = makeProcRoot({ "60": { starttime: "1000" } });
    const traces = tracePaths();
    const file = registrationFile(hostA.url, "secret-password");
    try {
      const armed = await run(
        [
          "--on-exit",
          "60",
          "--message",
          "wake",
          "--service-file",
          file,
          "--quiet",
        ],
        {
          ...SEAM,
          OC_WAKE_PROC_ROOT: proc.root,
          OC_WAKE_LOG_FILE: traces.log,
          OC_WAKE_STATE_FILE: traces.state,
          OPENCODE_SESSION_ID: "ses_target",
          OC_WAKE_URL: hostB.url,
          OC_WAKE_SERVICE_FILE: "/smuggled/opencode/service.json",
        },
      );
      assert.equal(armed.exit, 0, armed.stderr);
      fs.rmSync(path.join(proc.root, "60/stat"), { force: true });
      await waitFor(() => outcomeLines(traces.state).length === 1);
      const [line] = outcomeLines(traces.state);
      assert.equal(line.status, "posted");
      assert.equal(line.sessionID, "ses_target");
      assert.equal(
        hostA.recorded()[0].authorization,
        `Basic ${Buffer.from("opencode:secret-password").toString("base64")}`,
      );
      await settle(200);
      assert.equal(hostB.recorded().length, 0, "the smuggled host got nothing");
    } finally {
      await hostA.close();
      await hostB.close();
    }
  },
  { timeout: 15_000 },
);

test("the argument reader stops at a following flag instead of eating it", async () => {
  // A value-taking flag followed by another flag is a usage error naming
  // both; the stdin sentinel stays special, and the joined form keeps
  // dash-leading values reachable.
  const eatenMessage = await run(
    ["--on-exit", "1", "--message", "--quiet", "--url", "http://127.0.0.1:1"],
    SEAM,
    "",
  );
  assert.equal(eatenMessage.exit, 2);
  assert.match(eatenMessage.stderr, /--message needs a value, not a flag/);

  const eatenSession = await run(
    [
      "--on-exit",
      "1",
      "--session",
      "--url",
      "http://127.0.0.1:1",
      "--message",
      "wake",
    ],
    SEAM,
  );
  assert.equal(eatenSession.exit, 2);
  assert.match(eatenSession.stderr, /--session needs a value, not a flag/);

  const sentinel = await run(
    ["--on-exit", "1", "--message", "-", "--url", "http://127.0.0.1:1"],
    SEAM,
    "piped wake",
  );
  assert.equal(
    sentinel.exit,
    2,
    "no target session: the pipe was read as the message, the arm failed on the target",
  );
  assert.match(sentinel.stderr, /no target session/);

  const joinedDashValue = await run(
    ["--on-exit=1", "--message=-dash value", "--url", "http://127.0.0.1:1"],
    SEAM,
    "",
  );
  assert.equal(
    joinedDashValue.exit,
    2,
    "the arm failed on the target, not the message",
  );
  assert.match(joinedDashValue.stderr, /no target session/);
});

test(
  "the route joins under the registration url's own path",
  async () => {
    // A mount prefix in the base url survives; the fake host records the
    // request path so the joined shape is observable.
    let requestPath: string | undefined;
    const server = http.createServer((request, response) => {
      requestPath = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { id: "sch_prefixed" } }));
    });
    const base = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        assert.ok(address && typeof address === "object");
        resolve(`http://127.0.0.1:${address.port}/mount`);
      });
    });
    const proc = makeProcRoot({ "61": { starttime: "1000" } });
    const traces = tracePaths();
    const watcher = spawnWatcher(
      watcherEnv(proc, "61", {
        OC_WAKE_URL: base,
        OC_WAKE_STATE_FILE: traces.state,
        OC_WAKE_LOG_FILE: traces.log,
      }),
    );
    try {
      fs.rmSync(path.join(proc.root, "61/stat"), { force: true });
      const result = await collect(watcher);
      assert.equal(result.exit, 0, result.stderr);
      await waitFor(() => requestPath !== undefined);
      assert.equal(requestPath, "/mount/api/experimental/schedule");
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
  { timeout: 15_000 },
);

test(
  "a service restart between arming and exit is handled with the fresh registration value",
  async () => {
    // The bin's header claims the watcher re-reads the registration at
    // fire time, so a service restart in between is handled. The test
    // stages exactly that: the registration names host A at arm, the
    // file is rewritten to host B before the watched process exits, and
    // the post must land on B — the fresh value — with A never
    // contacted.
    const hostA = await fakeHost();
    const hostB = await fakeHost();
    const proc = makeProcRoot({ "413": { starttime: "999000" } });
    const traces = tracePaths();
    const registration = registrationFile(hostA.url, "pw-one");
    let watcherPid: number | undefined;
    try {
      const armed = await run(
        [
          "--on-exit",
          "413",
          "--message",
          "restart me",
          "--service-file",
          registration,
          "--session",
          "ses_target",
        ],
        {
          ...SEAM,
          OC_WAKE_PROC_ROOT: proc.root,
          OC_WAKE_STATE_FILE: traces.state,
          OC_WAKE_LOG_FILE: traces.log,
        },
      );
      assert.equal(armed.exit, 0, armed.stderr);
      watcherPid = Number(JSON.parse(armed.stdout).watcher);
      // The restart: the registration file now names the new host.
      fs.writeFileSync(
        registration,
        JSON.stringify({
          id: "svc_test",
          version: "2.2.5",
          url: hostB.url,
          pid: 1,
          password: "pw-two",
        }),
      );
      writeEntry(proc.root, "413", { starttime: "999000", state: "Z" });
      await waitFor(() => hostB.recorded().length === 1);
      assert.equal(
        hostA.recorded().length,
        0,
        "the stale host is never contacted",
      );
      const [only] = hostB.recorded();
      assert.equal(only.path, "/api/experimental/schedule");
      // The fresh registration's password rode the post.
      assert.equal(
        only.authorization,
        `Basic ${Buffer.from("opencode:pw-two").toString("base64")}`,
      );
      // The post's response and the outcome record's append are two
      // moments; the record waits for itself.
      await waitFor(() => outcomeLines(traces.state).length === 1);
      const lines = outcomeLines(traces.state);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].status, "posted");
    } finally {
      if (watcherPid !== undefined) killWatcher(watcherPid);
      await hostA.close();
      await hostB.close();
    }
  },
  { timeout: 15_000 },
);

test(
  "a registration without a password, with no OC_WAKE_PASSWORD, fails named at arm time",
  async () => {
    // The credential is part of the deployment the registration
    // describes; a post without it can only fail at the watcher's
    // fire-time, where the trace alone observes. The arm says so now.
    const host = await fakeHost();
    const proc = makeProcRoot({ "414": { starttime: "999000" } });
    const passwordless = registrationFile(host.url);
    try {
      const armed = await run(
        [
          "--on-exit",
          "414",
          "--message",
          "nobody is listening",
          "--service-file",
          passwordless,
          "--session",
          "ses_target",
        ],
        {
          ...SEAM,
          OC_WAKE_PROC_ROOT: proc.root,
        },
      );
      assert.equal(armed.exit, 1);
      assert.match(armed.stderr, /credential is unset or empty/);
      assert.equal(host.recorded().length, 0);
    } finally {
      await host.close();
    }
  },
  { timeout: 15_000 },
);
