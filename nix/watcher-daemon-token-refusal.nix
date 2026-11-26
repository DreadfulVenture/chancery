# The token-refusal check for the watcher daemon's module (PRJ-540,
# zenigata review 700): the rendered config file is a store path,
# world-readable by construction, so the module must refuse a token
# anywhere in settings — the sources read the environment first and the
# block wins per key, and a token pasted into settings would silently
# override the secrets file and leak through the store path. One eval
# per source placement (the forge's top-level forgeToken and a token
# inside each of the four source blocks) plus a clean control: each
# refusal must fire and name that source's secret, and the control must
# pass with no refusal at all. The module's bare module system is
# evaluated here — no NixOS boot machinery — so the only assertions in
# play are the module's own.
{
  modulePath,
  nixpkgsPath,
}:
let
  lib = import (nixpkgsPath + "/lib");

  evalOf =
    settings:
    lib.evalModules {
      modules = [
        (nixpkgsPath + "/nixos/modules/misc/assertions.nix")
        modulePath
        {
          options.systemd.services = lib.mkOption { type = lib.types.raw; };
          config = {
            _module.args.pkgs = null;
            # The unit's systemd options do not exist in this bare module
            # set; without the declaration above, the module system builds
            # an undefined-option error whose message forces the unit's
            # whole value (the package interpolation included) while
            # reading assertions. The raw stub swallows the unit unforced
            # — the check reads the module's assertions, never its unit.
            services.watcher-daemon = {
              enable = true;
              opencodeUrl = "http://127.0.0.1:7321";
              secretsFile = "/etc/watcher-daemon-secrets.env";
              inherit settings;
            };
          };
        }
      ];
    };

  refused = settings: lib.filter (a: !a.assertion) (evalOf settings).config.assertions;

  cases = [
    {
      name = "forge-token";
      settings = {
        forgeToken = "x";
      };
      names = "the forge source reads FORGEJO_TOKEN";
    }
    {
      name = "slack-token";
      settings = {
        slack = {
          token = "x";
        };
      };
      names = "the slack source reads SLACK_TOKEN";
    }
    {
      name = "github-token";
      settings = {
        github = {
          token = "x";
        };
      };
      names = "the github source reads GITHUB_TOKEN";
    }
    {
      name = "pagerduty-token";
      settings = {
        pagerduty = {
          token = "x";
        };
      };
      names = "the pagerduty source reads PAGERDUTY_TOKEN";
    }
    {
      name = "linear-token";
      settings = {
        linear = {
          token = "x";
        };
      };
      names = "the linear source reads LINEAR_TOKEN";
    }
  ];

  verdict = lib.forEach cases (
    case:
    let
      failed = refused case.settings;
    in
    if failed == [ ] then
      builtins.throw "the module let ${case.name} through: the token refusal must fire on every source placement"
    else if !lib.all (a: lib.hasInfix case.names a.message) failed then
      builtins.throw "the refusal for ${case.name} does not name the source's secret (${case.names}): ${
        lib.concatMapStringsSep " | " (a: a.message) failed
      }"
    else
      case.name
  );

  clean = refused {
    forgeUrl = "https://forge.example.com";
    pollSeconds = 30;
  };
in
if clean != [ ] then
  builtins.throw "the clean settings case must pass without a refusal: ${
    lib.concatMapStringsSep " | " (a: a.message) clean
  }"
else
  lib.deepSeq verdict "all five placements refused, each naming its source's secret"
