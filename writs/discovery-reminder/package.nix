# The discovery-mode reminder plugin (writs product): a scanned-file plugin,
# shipped as a flat file the deployment's OpenCode loads from its scanned
# plugins directory, the loading mechanics discovery-reminder.js always had.
# The home is its own package so the writs' products each carry their
# packaging; the home-manager module links the file out of
# share/opencode/plugins.
{
  lib,
  runCommand,
}:

runCommand "discovery-reminder"
  {
    meta = {
      description = "discovery-mode reminder plugin for OpenCode";
      platforms = lib.platforms.all;
    };
  }
  ''
    mkdir -p "$out/share/opencode/plugins"
    install -m 0644 ${./discovery-reminder.ts} "$out/share/opencode/plugins/discovery-reminder.ts"
  ''
