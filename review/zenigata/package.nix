# The Zenigata package: buildNpmPackage over this product tree,
# following the private-repo precedent — importNpmLock for the dependency setup
# and nodejs_24 as the runtime.
#
# The install keeps the layout the app itself resolves: the built tree
# lands at $out with dist/ beside persona.md (the process resolves the
# packaged persona relative to dist/), the agent definition at
# $out/share/zenigata/agent/, and bin/zenigata named for the bin entry in
# package.json, wrapped around node so ExecStart needs no PATH.
{
  lib,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
  makeBinaryWrapper,
}:

let
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
      ./tsconfig.json
      ./src
      ./persona.md
      ./agent
    ];
  };
in

buildNpmPackage {
  pname = "zenigata";
  version = "0.1.0";

  inherit src;

  nodejs = nodejs_24;
  nativeBuildInputs = [ makeBinaryWrapper ];

  # npmDeps comes from importNpmLock: it fetches every dependency against
  # the integrity hashes in package-lock.json, so no npmDepsHash applies.
  inherit (importNpmLock) npmConfigHook;

  # The two manifests are read explicitly from the unfiltered input tree:
  # importNpmLock's overridable defaults read them through the fileset
  # src, whose content-addressed path materializes nothing under a
  # read-only --no-build evaluation. npmRoot stays src for the
  # build-time hook.
  npmDeps = importNpmLock.importNpmLock {
    npmRoot = src;
    package = lib.importJSON ./package.json;
    packageLock = lib.importJSON ./package-lock.json;
  };

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin $out/share/zenigata
    cp -r node_modules $out/
    cp -r dist $out/
    cp persona.md $out/persona.md
    cp -r agent $out/share/zenigata/agent

    # package.json's bin entry maps zenigata to dist/index.js; the wrapper
    # runs it with the pinned nodejs instead of relying on PATH.
    makeBinaryWrapper ${nodejs_24}/bin/node $out/bin/zenigata \
      --add-flags "$out/dist/index.js"

    runHook postInstall
  '';

  meta = {
    description = "The Zenigata pull-request review bot";
    platforms = lib.platforms.all;
  };
}
