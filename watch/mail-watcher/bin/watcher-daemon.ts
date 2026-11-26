#!/usr/bin/env node
// The watcher daemon's bin (PRJ-540): the standalone watcher process.
// The systemd unit's ExecStart wraps this with the pinned nodejs, the
// same way the forgejo-adapter's bin is wrapped. Arguments:
// --config <path> (the watcher block as JSON) and --port <n> (the local
// route); the environment carries the secrets and the host server
// endpoint (daemon/daemon.ts names each variable).

import { main } from "../daemon/daemon.ts";

await main(process.argv.slice(2));
