// The plugin side of the split (PRJ-540): the composition glue the
// opencode host runs — the route read, the route client, and the tool
// registration. Everything that needed a credential moved to the
// daemon: the forge client and its reads, the sources, the kernel, the
// projection, and the legacy legs live in daemon/ (the composition is
// daemon/composition.ts, the main daemon/daemon.ts), and this side
// holds only the registration surface — the four tools proxy to the
// daemon's local route, carrying the caller's session id and never a
// credential. A daemon that is down or unconfigured surfaces as a named
// error on the tool call, not a failed plugin load: the daemon may
// start after opencode, and the tools stay registered either way.
//
// The route the tools proxy to rides the plugin's options
// (options.watcher.daemonUrl) or the host's environment
// (WATCHER_DAEMON_URL), defaulting to the daemon's loopback port — see
// route-client.ts.

import { routeClient, routeConfig } from "./route-client.ts";
import { createTools } from "./tools.ts";

export const compose = async (ctx) => {
  const route = routeClient(routeConfig(ctx));
  const { registerTool, listTool, forgetTool, stateTool } = createTools({
    route,
  });
  // Strict plain-JSON-schema objects pass through the host's tool
  // converter untouched, so argument mistakes surface as tool errors
  // instead of crashes on undefined fields later.
  const registration = await ctx.tool.transform((editor) => {
    editor.add(registerTool);
    editor.add(listTool);
    editor.add(forgetTool);
    editor.add(stateTool);
  });

  // OpenCode awaits the returned cleanup (packages/plugin/src/promise/
  // adapter.ts, v2.0.29). The plugin holds one thing to tear down: the
  // tool registration. (The test harness runs the daemon's composition
  // beside this compose, and its cleanup carries the same step name so
  // the log reads as it did.)
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (error) {
      console.error(`[forgejo-watcher] cleanup: ${name} failed: ${error}`);
    }
  };
  return async () => {
    await step("tool registration", () => registration?.dispose?.());
  };
};
