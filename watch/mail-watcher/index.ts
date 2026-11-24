// The Forgejo watcher (PRJ-244): the family's first source adapter on
// the watcher kernel (kernel.ts, docs/adr/20261119-watcher-family.md).
// This file is the plugin entry only — the
// seams it used to hold are their own modules beside it:
//
// - source.ts — the source-contract base class: the machinery the
//   adapters share (the ready gate, the register plumbing's common
//   half, the baseline template, the delivered-map read) — the kernel
//   keeps the pass machinery, and its WatchSource interface stays the
//   contract's typing;
// - forgejo-source.ts — the Forgejo source, and slack.ts and github.ts
//   the Slack and GitHub sources: each a WatchSource subclass carrying
//   its own poll reads per watch kind, the zod boundaries, the verdict
//   renders, the event views, and the register validation;
// - forge-client.ts — the forge REST client, one GET per read against
//   the forge's /api/v1;
// - config.ts — the config surface (the watcher options block plus the
//   adapter's environment), the ready verdict, and the debug factory;
// - tools.ts — the family's tool surface: watcher_register/list/forget
//   and the projection's forge_state, schemas and execute handlers;
// - projection-sync.ts — the projection wiring: the pr-state database
//   holder, the open-PR walk, the per-repo sync, and the afterPass
//   stage;
// - composer.ts — the composition: the config read, the REST client and
//   the reads built over it, the source, the projection, the kernel
//   with the legacy legs (pagerduty.ts, linear.ts), the tool
//   registration, and the cleanup.
//
// In-process only — one poller interval on the host process; no daemon,
// no subprocess, no model calls, and nothing ever writes to a forge:
// the poller only reads the Forgejo REST API and delivers mail.
//
// The watcher ships as a directory plugin (`packages.mail-watcher`,
// entry at lib/mail-watcher/index.ts, with the director module materialized
// from the coordinate/director package at coordinate/director/director.ts
// beside lib/) that the deployment names in its config's `plugins` as
// lib/mail-watcher, not lib, because only a configured entry carries
// options; it must not also sit in a scanned plugins directory, or it
// loads twice.

import { compose } from "./composer.ts";

export default {
  id: "forgejo-watcher",
  setup: compose,
};

// The stamp machinery, exposed for the test that composes a source
// directly against it (the pagerduty leg-budget test) — the kernel owns
// it; the host reads only the default export.
export { patchStamps, readStamps } from "./kernel.ts";
