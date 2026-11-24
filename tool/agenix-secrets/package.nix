# The agenix-secrets helper package: the dotenv age-secrets tool the
# agenix-secrets skill ships. tool/ is the home for agent-operating tools,
# and this product is its first; each product carries its own packaging
# (the plan-reminder pattern). The python source under bin/ is the source
# of truth, and this derivation is the built form the packaged skill ships
# as its bin/age-env-secret. The wrapper gives the built binary its own
# age on PATH, so the skill's examples work on hosts that never installed
# age. Two things the build handles about the source: the writer prepends
# its own interpreter line, so the source's shebang is stripped from the
# content passed to the writer; and naming ignore codes replaces flake8's
# default list, so both E501 (some lines run past its 79-column default)
# and W503 (the formatter's wrap style puts the line break before the
# operator) are named explicitly. The suite check rides the package as
# passthru.suite: the unittest file locates the built helper one directory
# up from itself, so the check lays out bin/ beside tests/. It carries
# age, python3, and openssh from nixpkgs — age ships both age and
# age-keygen, and openssh ships the ssh-keygen that builds the
# ssh-recipient fixture — deliberately in this sandbox only, never in the
# dev shell or a published runtime.
{
  lib,
  runCommand,
  writers,
  age,
  python3,
  openssh,
}:

let
  # The guard fails the build when the source's first line stops being the
  # shebang, instead of removePrefix silently passing a stray comment line
  # into the writer's content.
  shebang = "#!/usr/bin/env python3\n";
  source = builtins.readFile ./bin/age-env-secret.py;
  helper =
    writers.writePython3Bin "age-env-secret"
      {
        flakeIgnore = [
          "E501"
          "W503"
          # ruff-format's slice style puts spaces around a complex
          # subscript's colon, which flake8's E203 flags; naming ignores
          # replaces flake8's default list, where E203 normally lives.
          "E203"
        ];
        # The writer's own wrapping hook (makeWrapperArgs runs wrapProgram in
        # the build phase) gives the built binary its own age on PATH — the
        # build phase, not a postFixup hook, because the writer's
        # runCommandLocal-based derivation never reaches the fixup phases.
        makeWrapperArgs = [
          "--prefix"
          "PATH"
          ":"
          (lib.makeBinPath [ age ])
        ];
      }
      (
        if lib.hasPrefix shebang source then
          lib.removePrefix shebang source
        else
          throw "tool/agenix-secrets/bin/age-env-secret.py lost its `#!/usr/bin/env python3` first line; the writer needs the shebang stripped"
      );
in
helper.overrideAttrs (old: {
  passthru = (old.passthru or { }) // {
    suite =
      runCommand "agenix-secrets-check"
        {
          nativeBuildInputs = [
            age
            python3
            openssh
          ];
          testFile = ./tests/test-age-env-secret.py;
        }
        ''
          mkdir -p bin tests
          cp -r ${helper}/bin/. bin/
          cp "$testFile" tests/test-age-env-secret.py
          python3 tests/test-age-env-secret.py
          touch "$out"
        '';
  };
})
