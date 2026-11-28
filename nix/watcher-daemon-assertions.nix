# The assertion check for the watcher daemon's module (PRJ-540,
# zenigata reviews 700 and 709): one bare eval per refusal the module
# must fire. The token placements (review 700): the rendered config
# file is a store path, world-readable by construction, so the module
# must refuse a token anywhere in settings — the sources read the
# environment first and the block wins per key, and a token pasted into
# settings would silently override the secrets file and leak through
# the store path. The opencodeUrl placement (review 709): forgetting
# the key entirely must reach the module's own assertion — the empty
# default lets the eval survive to it — and the message must name the
# option. Each refusal must fire and name its evidence, and the clean
# control must pass with no refusal at all. The module's bare module
# system is evaluated here — no NixOS boot machinery — so the only
# assertions in play are the module's own.
{
  modulePath,
  nixpkgsPath,
}:
let
  lib = import (nixpkgsPath + "/lib");

  # The service config every case shares: enable, the values the
  # assertions other than the case's own require, and settings with no
  # token in it. Each case replaces the part it exercises.
  base = {
    enable = true;
    opencodeUrl = "http://127.0.0.1:7321";
    secretsFile = "/etc/watcher-daemon-secrets.env";
    settings = {
      forgeUrl = "https://forge.example.com";
      pollSeconds = 30;
    };
  };

  evalOf =
    serviceConfig:
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
            services.watcher-daemon = serviceConfig;
          };
        }
      ];
    };

  refused = serviceConfig: lib.filter (a: !a.assertion) (evalOf serviceConfig).config.assertions;

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
    {
      # The webhook receiver's secret (PRJ-542): the same store-path
      # leak, its own refusal, naming the env name the receiver reads.
      name = "webhook-secret";
      settings = {
        webhookSecret = "x";
      };
      names = "WATCHER_WEBHOOK_SECRET";
    }
  ];

  verdict = lib.forEach cases (
    case:
    let
      failed = refused (
        base
        // {
          inherit (case) settings;
        }
      );
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

  # The forgotten url (review 709, comment 19442): opencodeUrl absent,
  # so the option takes its empty default and the module's own
  # assertion must be the refusal — the friendly message, not the
  # module system's bare used-but-not-defined error.
  forgottenUrl =
    let
      failed = refused (lib.attrsets.removeAttrs base [ "opencodeUrl" ]);
    in
    if failed == [ ] then
      builtins.throw "the module let a forgotten opencodeUrl through: the empty default must reach the friendly assertion"
    else if !lib.all (a: lib.hasInfix "opencodeUrl" a.message) failed then
      builtins.throw "the forgotten-opencodeUrl refusal does not name the option: ${
        lib.concatMapStringsSep " | " (a: a.message) failed
      }"
    else
      "opencodeUrl-forgotten";

  # The restartTriggers behavior (PRJ-542): the unit must carry the
  # secrets file as a restart trigger, so a changed secret content
  # restarts the daemon instead of leaving it running on the old
  # WATCHER_WEBHOOK_SECRET and source tokens. The trigger's attribute is
  # selected alone — the raw stub keeps the unit's other attributes
  # (the package interpolation included) unforced.
  restartTriggers =
    let
      unit = (evalOf base).config.systemd.services.watcher-daemon;
      triggers = unit.restartTriggers or null;
    in
    if triggers != [ base.secretsFile ] then
      builtins.throw "the module's unit carries no restartTriggers on the secrets file: ${builtins.toJSON triggers}"
    else
      "restartTriggers";

  clean = refused base;
in
if clean != [ ] then
  builtins.throw "the clean settings case must pass without a refusal: ${
    lib.concatMapStringsSep " | " (a: a.message) clean
  }"
else
  lib.deepSeq
    (
      verdict
      ++ [
        forgottenUrl
        restartTriggers
      ]
    )
    "all five token placements refused, each naming its source's secret; the webhook secret placement refused, naming WATCHER_WEBHOOK_SECRET; the forgotten opencodeUrl reaches the friendly assertion; the unit restarts on a secrets-file change"
