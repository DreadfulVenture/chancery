# The mail-watcher: the session-side plugin AND the standalone watcher
# daemon (PRJ-540). OpenCode hands options only to a plugin its config
# names, and a configured plugin path must be a directory, so the plugin
# ships here rather than among the scanned files in memory-store-plugin.
# A deployment names "${mail-watcher}/lib/mail-watcher" (not lib) in its
# OpenCode `plugins`, with options.watcher.daemonUrl set; it must not
# also sit in a scanned plugins directory, or it loads twice.
#
# The daemon ships from the same package: the watcher product owns both
# halves. bin/watcher-daemon wraps the daemon entry
# (lib/mail-watcher/bin/watcher-daemon.ts) with the pinned nodejs, so
# ExecStart needs no PATH; the deployment's secrets file feeds the
# daemon unit's environment (the source tokens), never the plugin's.
#
# The package dir is the standard shape: the modules at the package root
# beside this file (the daemon's under daemon/), the manifests at the
# package root, the tests in tests/. Nothing here but the runtime
# modules is an input to the derivation, so the lock stays untouched and
# there is no standalone-build wrapper — the root flake's mail-watcher
# attribute calls this file directly. The runtime set is every .ts/.js
# module, taken as a set: the next source module needs no edit here (an
# explicit per-file copy list was the failure mode: kernel.ts shipped as
# a missing import, and the loads check caught it).
#
# The mail-envelope boundary: the entry imports mailEnvelope from the
# director package (coordinate/director/director.ts) across the deployed
# layout. One mail-leg definition for the family, never a fork — the
# derivation materializes that module verbatim at the relative spot the
# import resolves to ($out/coordinate/director/director.ts), rebuilt from
# the director package's source on every build, so there is exactly one
# source of truth and no hand-maintained copy (see NOTICE.md).
#
# The entry's projection imports drizzle-orm and zod, resolved from
# lib/node_modules: the same two pins the package.json carries
# (package-lock.json), built with the importNpmLock precedent the zenigata
# package follows.
{
  lib,
  importNpmLock,
  nodejs_24,
  runCommand,
}:

let
  watcherSrc = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
    ];
  };
  # The two manifests are read explicitly from the unfiltered input tree:
  # buildNodeModules' overridable defaults read them through the fileset
  # watcherSrc, whose content-addressed path materializes nothing under a
  # read-only --no-build evaluation. npmRoot stays watcherSrc for the
  # build-time hook.
  nodeModules = importNpmLock.buildNodeModules {
    npmRoot = watcherSrc;
    package = lib.importJSON ./package.json;
    packageLock = lib.importJSON ./package-lock.json;
    nodejs = nodejs_24;
  };
  # The runtime modules: every .ts/.js file of the package, never the
  # tests (they carry their own fixture fakes) or the packaging files.
  watcherRuntime = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.difference (lib.fileset.fileFilter (
      file: file.hasExt "ts" || file.hasExt "js"
    ) ./.) ./tests;
  };
in

runCommand "mail-watcher"
  {
    meta = {
      description = "mail-watcher: the OpenCode plugin and the standalone watcher daemon (a configured directory plugin and the daemon's bin)";
      platforms = lib.platforms.all;
    };
  }
  ''
    mkdir -p "$out/lib/mail-watcher" "$out/coordinate/director" "$out/bin"
    cp -r ${watcherRuntime}/. "$out/lib/mail-watcher/"
    cp ${../../coordinate/director/director.ts} "$out/coordinate/director/director.ts"
    # buildNodeModules lands the tree at <out>/node_modules.
    cp -r ${nodeModules}/node_modules "$out/lib/node_modules"
    # The daemon's bin, wrapped with the pinned nodejs: ExecStart needs
    # no PATH, the forgejo-adapter's rule.
    cat > "$out/bin/watcher-daemon" <<EOF
    #!/bin/sh
    exec ${nodejs_24}/bin/node "$out/lib/mail-watcher/bin/watcher-daemon.ts" "\$@"
    EOF
    chmod +x "$out/bin/watcher-daemon"
  ''
