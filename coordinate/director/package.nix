# The director package: the coordination plugin as a standalone product.
# The module (director.ts) is both the plugin entry and the mail leg the
# mail-watcher imports; the agent definition, the three orchestration
# skills, and the two commands ship from this package too — the director
# product owns its whole surface, and the writs tree carries the rest of
# the suite's.
#
# The artifact is the opencode plugin folder itself: a package.json with a
# name and exports, so a local directory loads like a published package,
# with the module at the root as the server part. A deployment links this
# directory into its scanned plugins directory (the watched config root,
# so a rebuild is picked up the way the other scanned plugins are); the
# plugin registers its agent, skills, and commands in setup, so no
# per-file links ride the deployment. The module has no npm dependencies —
# node builtins only — and reads its bundled files relative to itself, so
# the artifact layout must mirror the source layout below.
{
  lib,
  runCommand,
  writeText,
}:

let
  packageJson = writeText "director-package.json" (
    builtins.toJSON {
      name = "opencode-director";
      private = true;
      type = "module";
      engines = {
        node = ">=24";
      };
      exports = {
        "." = "./index.ts";
      };
    }
  );
in

runCommand "director"
  {
    meta = {
      description = "director coordination plugin for OpenCode";
      platforms = lib.platforms.all;
    };
  }
  ''
    mkdir -p "$out/agent" "$out/skills" "$out/commands"
    install -m 0644 ${./director.ts} "$out/index.ts"
    install -m 0644 ${./agent/director.md} "$out/agent/director.md"
    install -m 0644 ${./commands/drive-project.md} "$out/commands/drive-project.md"
    install -m 0644 ${./commands/status-report.md} "$out/commands/status-report.md"
    install -m 0644 ${./README.md} "$out/README.md"
    cp -r ${./skills}/. "$out/skills/"
    cat ${packageJson} > "$out/package.json"
    # The skills are single-client now (the director ships for opencode
    # only): a leftover client marker would load as literal skill prose.
    if grep -rq "@clientBlock@" "$out/skills"; then
      echo "director skills carry an unspliced @clientBlock@ marker" >&2
      exit 1
    fi
  ''
