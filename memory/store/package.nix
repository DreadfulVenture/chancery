{
  pkgs,
  lib ? pkgs.lib,
  rev ? "dirty:unknown",
}:

let
  # Taken as a set rather than named one by one: a module nobody remembered to
  # add used to be missing from the package with no build error, surfacing as
  # an ImportError on a deployed machine. The OpenCode client assets (plugin,
  # skills, agents, commands) ship in their own packages; this is the daemon
  # only.
  everything = lib.fileset.unions [
    (lib.fileset.fileFilter (file: file.hasExt "py") ./memory_store)
    ./pyproject.toml
    ./uv.lock
    ./instructions
  ];

  # Tests and docs are not shipped, and the nix files describe the build
  # rather than taking part in it.
  source = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.difference everything ./memory_store/tests;
  };

  # The Cursor hook ships beside the python app under the deployed layout it
  # has always had (lib/memory-store/clients/cursor): the daemon matches the
  # hook command by the "/clients/cursor/hook" suffix to prune its own stale
  # registrations, so the shipped path is a runtime contract. The hook's
  # source home is the memory product's cursor-client/ (one level up from
  # this package), so the derivation takes it from there.
  cursorClient = lib.fileset.toSource {
    root = ../cursor-client;
    fileset = ../cursor-client;
  };
in
pkgs.runCommand "memory-store" { } ''
  mkdir -p "$out/lib/memory-store/clients/cursor"
  cp -R ${source}/. "$out/lib/memory-store/"
  cp ${cursorClient}/hook ${cursorClient}/hook.py "$out/lib/memory-store/clients/cursor/"
  chmod -R u+w "$out/lib/memory-store"
  printf '%s\n' ${lib.escapeShellArg rev} > "$out/lib/memory-store/VERSION"
''
