# The director package: the coordination plugin as a standalone product
# (PRJ-453). The module (director.ts) is both the plugin entry and the mail
# leg the mail-watcher imports; the agent definition ships from the package
# (share/opencode/agents/director.md), so the director product owns its
# agent — the writs agents directory carries the rest of the suite's.
#
# The deployed layout is the directory-plugin shape: a deployment names
# "${director}/lib/director" in its OpenCode `plugins` (a configured entry,
# not a scanned file), and links the agent out of share/opencode/agents. The
# module has no npm dependencies — node builtins only — so the package is
# the two files and nothing else.
{
  lib,
  runCommand,
}:

runCommand "director"
  {
    meta = {
      description = "director coordination plugin for OpenCode";
      platforms = lib.platforms.all;
    };
  }
  ''
    mkdir -p "$out/lib/director" "$out/share/opencode/agents"
    install -m 0644 ${./director.ts} "$out/lib/director/index.ts"
    install -m 0644 ${./agent/director.md} "$out/share/opencode/agents/director.md"
  ''
