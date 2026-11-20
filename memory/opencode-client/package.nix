# The OpenCode capture plugin as a real package, laid out where OpenCode
# scans for plugins. Taken as a set: a plugin file nobody remembered to add
# would be missing from the deployment with nothing reporting it. The memory
# client's source home is this product dir; only its top-level .ts files ship
# (the loader imports TypeScript natively, and the source-language rule keeps
# new .js sources out), so tests and the packaging files stay out. The other
# plugins are products of their own — the director (coordinate/director), the
# reminders (writs/plan-reminder, writs/discovery-reminder), and the
# mail-watcher (watch/mail-watcher, a directory plugin named in OpenCode
# config instead of scanned).
{
  lib,
  runCommand,
}:

let
  pluginFiles = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.difference (lib.fileset.fileFilter (
      file: file.hasExt "ts" || file.hasExt "js"
    ) ./.) ./tests;
  };
in

runCommand "memory-store-plugin"
  {
    meta = {
      description = "memory-store capture plugin for OpenCode";
      platforms = lib.platforms.all;
    };
  }
  ''
    mkdir -p "$out/share/opencode/plugins"
    cp ${pluginFiles}/*.ts "$out/share/opencode/plugins/"
  ''
