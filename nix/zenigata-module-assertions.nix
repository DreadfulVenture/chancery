# The opencodeUrl teaching check for the zenigata module (zenigata
# review 709): opencodeUrl defaults to "" so forgetting the key reaches
# the module's own assertion — which names the option and the reason —
# instead of the module system's bare used-but-not-defined error. One
# eval without the key: the refusal must fire and name the option. The
# module's bare module system is evaluated here — no NixOS boot
# machinery — so the only assertions in play are the module's own.
{
  modulePath,
  nixpkgsPath,
}:
let
  lib = import (nixpkgsPath + "/lib");

  eval = lib.evalModules {
    modules = [
      (nixpkgsPath + "/nixos/modules/misc/assertions.nix")
      modulePath
      {
        options.systemd.services = lib.mkOption { type = lib.types.raw; };
        # The module's agent-definition publication rides the NixOS
        # `environment.etc` option; the raw stub swallows it unforced,
        # the way the unit is swallowed below.
        options.environment.etc = lib.mkOption { type = lib.types.raw; };
        config = {
          _module.args.pkgs = null;
          # The unit's systemd options do not exist in this bare module
          # set; the raw stub swallows the unit unforced — the check
          # reads the module's assertions, never its unit.
          services.zenigata = {
            enable = true;
            allowedLogins = [ "example-user" ];
            adapterUrl = "http://adapter.invalid";
            forgeUrl = "https://forge.example.com";
            memoryUrl = "http://127.0.0.1:28132/mcp?app=zenigata&initiator=agent";
            secretsFile = "/etc/zenigata-secrets.env";
          };
        };
      }
    ];
  };

  failed = lib.filter (a: !a.assertion) eval.config.assertions;
in
if failed == [ ] then
  builtins.throw "the module let a forgotten opencodeUrl through: the empty default must reach the friendly assertion"
else if !lib.all (a: lib.hasInfix "opencodeUrl" a.message) failed then
  builtins.throw "the forgotten-opencodeUrl refusal does not name the option: ${
    lib.concatMapStringsSep " | " (a: a.message) failed
  }"
else
  "the forgotten opencodeUrl reaches the module's assertion, and the message names the option"
