# The zenigata-ui package: buildNpmPackage over this product tree, the
# same pattern the bot's package carries — importNpmLock for the
# dependency setup and nodejs_24 as the runtime. The build runs tsc (the
# server) and the esbuild client bundle; dist/ installs whole, and the
# bin is the UI server's node entry.
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
      ./tool
      ./index.html
      ./assets
    ];
  };
in

buildNpmPackage {
  pname = "zenigata-ui";
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

    # package.json's bin entry maps zenigata-ui to dist/server/index.js;
    # the wrapper runs it with the pinned nodejs instead of relying on
    # PATH.
    makeBinaryWrapper ${nodejs_24}/bin/node $out/bin/zenigata-ui \
      --add-flags "$out/dist/server/index.js"

    runHook postInstall
  '';

  meta = {
    description = "The Zenigata status page app, consuming the intake's HTTP surface";
    platforms = lib.platforms.all;
  };
}
