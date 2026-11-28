// The watcher daemon's main (PRJ-540). The product runs standalone: it
// holds the forge and source tokens in its own environment (the
// deployment's secrets file), reads its watcher block from its own
// config file, talks to the host opencode server over its session API,
// and serves the credential-free local route the session-side tools
// proxy to. Nothing here ever runs inside an opencode process — that is
// the operator's ruling: forge reads leave the opencode environment.
//
// Config surface, in the daemon's own names:
//
// - WATCHER_CONFIG (or --config <path>): the watcher block as JSON —
//   the same shape the plugin's options.watcher carried before the
//   split (forgeUrl, pollSeconds, dbPath, the slack/github/pagerduty/
//   linear blocks). The secrets are NOT this file's job: every source
//   reads its token from the environment first (FORGEJO_TOKEN,
//   SLACK_TOKEN, GITHUB_TOKEN, PAGERDUTY_TOKEN, the linear token), so
//   the deployment's secrets file feeds the unit and the config file
//   stays free of credentials.
// - WATCHER_ROUTE_PORT (or --port <n>): the local route's port
//   (default 8473; the route binds 127.0.0.1 only).
// - WATCHER_WEBHOOK_PORT (or --webhook-port <n>) and
//   WATCHER_WEBHOOK_BIND (or --webhook-bind <addr>): the webhook
//   receiver's (PRJ-542) port (default 8474) and bind address (default
//   127.0.0.1 — the adopter-first shape; a reachable deployment names
//   its own bind, a tunnel front or an LAN allow-list, and registers
//   its hooks against the url that reachability choice produces).
// - WATCHER_WEBHOOK_SECRET: the webhook receiver's shared secret, read
//   from the environment alone — the secrets file feeds it, never the
//   rendered settings (the module refuses a webhook secret in
//   settings). Empty or absent fails closed: the receiver answers
//   every delivery 403 and says so, rather than serving an unverified
//   one.
// - WATCHER_OPENCODE_URL / WATCHER_OPENCODE_PASSWORD (or the host's
//   registration file, host-client.ts): the opencode server the
//   daemon's stamps, mail, and event stream ride.
//
// A config the composition cannot serve exits named and non-zero: the
// unit restarts and the failure is loud in systemd — the plugin's old
// init-throw, moved to where the credentials now live.

import { readFileSync } from "node:fs";
import { resolveHost, hostContext } from "./host-client.ts";
import { composeWatcher } from "./composition.ts";
import { startRoute } from "./route.ts";
import {
  startHookDiagnosis,
  startWebhookReceiver,
} from "./webhook-receiver.ts";
import { readStamps } from "../kernel.ts";

const ROUTE_PORT_DEFAULT = 8473;
const WEBHOOK_PORT_DEFAULT = 8474;
const WEBHOOK_BIND_DEFAULT = "127.0.0.1";

const argOf = (argv: string[], flag: string): string | undefined => {
  const exact = argv.indexOf(flag);
  if (exact >= 0) return argv[exact + 1];
  const prefix = `${flag}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : undefined;
};

// The daemon's assembly, without the process plumbing: the host leg,
// the composition, and the route, wired together. Throws named on a
// host endpoint the daemon cannot resolve and on a config the watcher
// cannot serve. Returns everything a test (or main's signal handling)
// needs to stop it.
export const startDaemon = async ({
  watcherBlock = {},
  port,
  webhookPort = WEBHOOK_PORT_DEFAULT,
  webhookBind = WEBHOOK_BIND_DEFAULT,
  webhookSecret = "",
}: {
  watcherBlock?: Record<string, unknown>;
  port: number;
  webhookPort?: number;
  webhookBind?: string;
  webhookSecret?: string;
}) => {
  const resolved = resolveHost();
  if (!resolved.ok) throw new Error(resolved.reason);
  const host = hostContext(resolved);
  const ctx = {
    options: { watcher: watcherBlock },
    session: host.session,
    event: host.event,
  };

  const composition = await composeWatcher({ ctx });

  // The webhook receiver (PRJ-542): the daemon's second server, the
  // forge's deliveries in, the verified payloads pushed into the
  // composition's ingest queue. Fail closed on an empty secret — the
  // receiver still serves, and every delivery answers the named 403,
  // so a deployment that forgot WATCHER_WEBHOOK_SECRET sees the reason
  // in the forge's delivery history instead of silence.
  const receiver = await startWebhookReceiver({
    host: webhookBind,
    port: webhookPort,
    secret: webhookSecret,
    ingest: composition.ingest,
    debug: composition.debug,
  });

  // The missing-hook self-diagnosis (PRJ-542): watched forge repos
  // whose hooks read names no active hook at this receiver's url are
  // said on their line — the hand registration the deployment owns.
  // The stated webhookUrl (a non-secret knob in the watcher block)
  // names the url a tunnel-fronted or LAN-reachable deployment
  // registered its hooks under; without one, the receiver's own origin.
  const statedHookUrl =
    typeof watcherBlock.webhookUrl === "string" &&
    watcherBlock.webhookUrl.trim() !== ""
      ? watcherBlock.webhookUrl.trim()
      : null;
  const hookDiagnosis = startHookDiagnosis({
    watches: () => composition.kernel.watches(),
    hooksOf: composition.hooksOf,
    expectedUrl: () => statedHookUrl ?? receiver.url,
    debug: composition.debug,
  });

  const route = await startRoute({
    port,
    register: (req, caller) => composition.kernel.register(req, caller),
    forget: (id, caller) => composition.kernel.forget(id, caller),
    stampsOf: (sessionID) => readStamps(ctx, composition.debug, sessionID),
    stateOf: async (repo) => {
      // The projection's board read: a database that cannot open is the
      // tool's ok:false answer today, not a thrown tool error — the
      // unavailable marker keeps that shape through the route.
      try {
        const db = composition.projectionSync.projectionDb();
        return db.board(repo);
      } catch (error) {
        return {
          unavailable: `the pr-state projection is unavailable: ${(error as Error)?.message ?? error}`,
        };
      }
    },
  });
  return {
    route,
    receiver,
    composition,
    stop: async () => {
      await receiver.close();
      hookDiagnosis.stop();
      await route.close();
      await composition.cleanup();
    },
  };
};

export const main = async (argv: string[] = []) => {
  const configPath = argOf(argv, "--config") ?? process.env.WATCHER_CONFIG;
  let watcherBlock: Record<string, unknown> = {};
  if (configPath) {
    let text: string;
    try {
      text = readFileSync(configPath, "utf8");
    } catch (error) {
      console.error(
        `[watcher-daemon] the config file at ${configPath} is unreadable: ${(error as Error)?.message ?? error}`,
      );
      process.exit(1);
    }
    try {
      const parsed = JSON.parse(text);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new Error("the config file is not a JSON record");
      }
      watcherBlock = parsed as Record<string, unknown>;
    } catch (error) {
      console.error(
        `[watcher-daemon] the config file at ${configPath} is not a usable watcher block: ${(error as Error)?.message ?? error}`,
      );
      process.exit(1);
    }
  }

  const port = Number(
    argOf(argv, "--port") ??
      process.env.WATCHER_ROUTE_PORT ??
      ROUTE_PORT_DEFAULT,
  );
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.error(
      `[watcher-daemon] the route port must be 1-65535 (got ${port})`,
    );
    process.exit(1);
  }

  const webhookPort = Number(
    argOf(argv, "--webhook-port") ??
      process.env.WATCHER_WEBHOOK_PORT ??
      WEBHOOK_PORT_DEFAULT,
  );
  if (
    !Number.isFinite(webhookPort) ||
    webhookPort <= 0 ||
    webhookPort > 65535
  ) {
    console.error(
      `[watcher-daemon] the webhook receiver's port must be 1-65535 (got ${webhookPort})`,
    );
    process.exit(1);
  }
  const webhookBind =
    argOf(argv, "--webhook-bind") ??
    process.env.WATCHER_WEBHOOK_BIND ??
    WEBHOOK_BIND_DEFAULT;
  // The secret rides the environment alone (the secrets file feeds the
  // unit's EnvironmentFile); there is no flag for it, and a
  // config-file placement is what the module's assertion refuses.
  const webhookSecret = process.env.WATCHER_WEBHOOK_SECRET ?? "";

  let daemon;
  try {
    daemon = await startDaemon({
      watcherBlock,
      port,
      webhookPort,
      webhookBind,
      webhookSecret,
    });
  } catch (error) {
    console.error(
      `[watcher-daemon] ${error instanceof Error ? error.message : error}`,
    );
    process.exit(1);
  }
  console.error(
    `[watcher-daemon] the route answers at ${daemon.route.url} (register/list/forget/state); polling every ${Math.round(1000 * Number(watcherBlock.pollSeconds ?? 30))}ms`,
  );
  console.error(
    `[watcher-daemon] the webhook receiver answers at ${daemon.receiver.url} (X-Forgejo-Signature verified deliveries; the secret rides WATCHER_WEBHOOK_SECRET${webhookSecret ? "" : " — unset, so every delivery is refused"})`,
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await daemon.stop();
    } catch (error) {
      console.error(`[watcher-daemon] the shutdown failed: ${error}`);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  // The composition's poll timer and subscriptions keep the loop alive;
  // the explicit hold makes the intent plain and keeps the daemon up
  // even if a later refactor leaves no live timer.
  await new Promise(() => {});
};
