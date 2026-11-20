# The plan-mode reminder plugin (writs product): a scanned-file plugin,
# shipped as a flat file the deployment's OpenCode loads from its scanned
# plugins directory, the loading mechanics plan-reminder.js always had. The
# home is its own package so the writs' products each carry their packaging;
# the home-manager module links the file out of share/opencode/plugins.
{
  lib,
  runCommand,
}:

runCommand "plan-reminder"
  {
    meta = {
      description = "per-turn plan-mode reminder plugin for OpenCode";
      platforms = lib.platforms.all;
    };
  }
  ''
    mkdir -p "$out/share/opencode/plugins"
    install -m 0644 ${./plan-reminder.ts} "$out/share/opencode/plugins/plan-reminder.ts"
  ''
