# The forgejo-adapter package: buildNpmPackage over this product tree,
# following the zenigata precedent — importNpmLock for the dependency setup
# and nodejs_24 as the runtime.
#
# The install keeps the built dist/ and node_modules/ at $out and wraps
# bin/forgejo-adapter (named for the bin entry in package.json) around
# node so ExecStart needs no PATH.
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
    ];
  };
in

buildNpmPackage {
  pname = "forgejo-adapter";
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

    mkdir -p $out/bin
    cp -r node_modules $out/
    cp -r dist $out/

    # package.json's bin entry maps forgejo-adapter to dist/index.js; the
    # wrapper runs it with the pinned nodejs instead of relying on PATH.
    makeBinaryWrapper ${nodejs_24}/bin/node $out/bin/forgejo-adapter \
      --add-flags "$out/dist/index.js"

    runHook postInstall
  '';

  meta = {
    description = "Forgejo adapter for the Zenigata review bot";
    platforms = lib.platforms.all;
  };
}
