import plugin from "../index.ts";
import { composeWatcher } from "../daemon/composition.ts";
import { startRoute } from "../daemon/route.ts";
import { readStamps } from "../kernel.ts";
import { debugOf } from "../config.ts";

// The test harness (PRJ-540): the split's whole shape, with fakes only
// at the boundaries. The suites drive the watcher through the real
// watcher_register/list/forget/forge_state tools exactly as before the
// split; under the tools, the chain is now the real one:
//
//   tool execute → route client → route server → kernel → fake host ctx
//
// - The daemon's composition (daemon/composition.ts) runs against the
//   suite's fake host ctx — the same ctx the pre-split plugin composed
//   against, with its fake sessions, mails, and event bus.
// - The real route server (daemon/route.ts) wires that kernel, on an
//   ephemeral loopback port.
// - The real plugin (index.ts → composer.ts) registers its tools with
//   the ctx, its route client pointed at the route — the plugin carries
//   no kernel and no credential, exactly as it ships.
//
// boot(ctx) replaces the pre-split `plugin.setup(ctx)`: it throws the
// composition's own named reasons on a config the watcher cannot serve
// (the pre-split setup's throw), and returns one cleanup that runs the
// pre-split order — the kernel's steps, the tool registration's
// dispose, the projection's close — then closes the route.

export const boot = async (ctx: any) => {
  if (!ctx || typeof ctx !== "object")
    throw new Error("boot: the fixture carried no ctx");
  if (!ctx.options || typeof ctx.options !== "object") ctx.options = {};
  if (
    !ctx.options.watcher ||
    typeof ctx.options.watcher !== "object" ||
    Array.isArray(ctx.options.watcher)
  ) {
    ctx.options.watcher = {};
  }
  // The plugin's dispose rides inside the composition's cleanup, in the
  // pre-split step order; the closure is filled in after the plugin's
  // tools register.
  let pluginCleanup: (() => unknown) | undefined;
  const debug = debugOf();
  const composition = await composeWatcher({
    ctx,
    disposeTools: () => pluginCleanup?.(),
  });
  const route = await startRoute({
    port: 0,
    register: (req, caller) => composition.kernel.register(req, caller),
    forget: (id, caller) => composition.kernel.forget(id, caller),
    stampsOf: (sessionID) => readStamps(ctx, debug, sessionID),
    stateOf: async (repo) => {
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
  try {
    ctx.options.watcher.daemonUrl = route.url;
    const cleanup = await plugin.setup(ctx);
    pluginCleanup = cleanup;
  } catch (error) {
    await composition.cleanup().catch(() => {});
    await route.close();
    throw error;
  }
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await composition.cleanup();
    await route.close();
  };
};
