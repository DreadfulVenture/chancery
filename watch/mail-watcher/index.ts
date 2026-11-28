// The Forgejo watcher (PRJ-244), split PRJ-540: the family's first
// source adapter on the watcher kernel (kernel.ts). This file is the plugin entry
// only — the credential-free half that runs inside opencode sessions.
// Since the split, the forge reads (and every source's reads) leave the
// opencode process entirely, per the operator's ruling: the tokens live
// in the standalone watcher daemon's own secrets file, the daemon does
// all the polling, and the tools here proxy to it over a local route
// that carries no forge credentials. The seams:
//
// - daemon/composition.ts — the composition the daemon runs: the config
//   read, the REST client and the reads built over it, the forge source
//   (forgejo-source.ts) beside the slack and github sources, the
//   projection's wiring (projection-sync.ts), and the kernel
//   (kernel.ts) with the legacy legs (pagerduty.ts, linear.ts);
// - daemon/daemon.ts + bin/watcher-daemon.ts — the standalone process:
//   its own config file, its own secrets in the environment, its own
//   route (daemon/route.ts) on loopback, and the host leg
//   (daemon/host-client.ts) that reads and writes session stamps and
//   delivers mail through the host's session API — the session mail
//   path, unchanged;
// - composer.ts — this half's glue: the route read, the route client
//   (route-client.ts), and the tool registration;
// - tools.ts — the family's tool surface: watcher_register/list/forget
//   and the projection's forge_state, schemas and result strings
//   byte-identical to the pre-split tools, execute handlers proxying to
//   the route.
//
// The watch contract is unchanged: the watch kinds, the at-most-once
// delivery, the baseline-on-register, the self-dissolving pr watches —
// all kernel behavior, moved, not rewritten.
//
// The watcher ships as a directory plugin (`packages.mail-watcher`,
// entry at lib/mail-watcher/index.ts, with the director module
// materialized from the coordinate/director package at
// coordinate/director/director.ts beside lib/) that the deployment
// names in its config's `plugins` as lib/mail-watcher. The deployment's
// options.watcher no longer carries credentials — the route address
// (daemonUrl) is this side's only knob, and the secrets file feeds the
// daemon's unit; it must not also sit in a scanned plugins directory,
// or it loads twice.

import { compose } from "./composer.ts";

export default {
  id: "forgejo-watcher",
  setup: compose,
};

// The stamp machinery, exposed for the tests that compose sources
// directly against it (the pagerduty and linear leg-budget tests) — the
// kernel owns it; the host reads only the default export.
export { patchStamps, readStamps } from "./kernel.ts";
