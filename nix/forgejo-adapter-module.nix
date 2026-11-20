# NixOS module: the Forgejo adapter for Zenigata.
#
# One service, one environment file for the secrets, and every non-secret
# knob as an option that maps onto a FORGEJO_ADAPTER_* / integration
# variable (see review/forgejo-adapter/src/config.ts and README.md).
# The process binds loopback only; anything reaching it from elsewhere
# needs a reverse proxy in front.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.forgejo-adapter;

  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    optionalAttrs
    types
    ;

  # systemd's StateDirectory takes the path's last component and manages
  # /var/lib/<that component>; anything deeper would desync the unit's
  # directory grants from the path the service actually writes.
  stateDirName = lib.last (lib.splitString "/" cfg.stateDir);

  package = pkgs.callPackage ../review/forgejo-adapter/package.nix { };
in
{
  options.services.forgejo-adapter = {
    enable = mkEnableOption "the Forgejo adapter for Zenigata";

    listenPort = mkOption {
      type = types.port;
      default = 8472;
      description = "Port the adapter listens on (the service binds loopback only).";
    };

    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/forgejo-adapter";
      description = ''
        State directory for the service. systemd's `StateDirectory` takes
        only the path's last component, so the path must be exactly
        `/var/lib/<name>`; the assertion on the module enforces it.
      '';
    };

    forgeBaseUrl = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        Forgejo base URL (FORGEJO_BASE_URL). There is no upstream default;
        the deployer must set this to the Forgejo instance the adapter serves.
      '';
    };

    zenigataIntakeUrl = mkOption {
      type = types.str;
      default = "http://127.0.0.1:8471";
      description = ''
        Zenigata base URL for inbound event delivery
        (ZENIGATA_INTAKE_URL). The adapter appends the intake path
        (`/v1/events`) itself; set the base URL only, and don't
        include the `/v1/events` suffix. If you previously set the
        full intake URL, drop the `/v1/events` suffix.
      '';
    };

    secretsFile = mkOption {
      type = types.path;
      description = ''
        Environment file loaded by the unit's `EnvironmentFile`, carrying
        the secret tokens the adapter requires: `FORGEJO_TOKEN`,
        `ZENIGATA_ADAPTER_TOKEN`, `FORGEJO_WEBHOOK_SECRET`, and
        `ZENIGATA_EVENT_TOKEN` (used for inbound delivery to zenigata).
      '';
    };

    requestTimeoutMs = mkOption {
      type = types.nullOr types.ints.positive;
      default = null;
      description = ''
        Upstream request timeout in milliseconds
        (FORGEJO_ADAPTER_REQUEST_TIMEOUT_MS). When null the adapter uses
        its built-in default.
      '';
    };

    package = mkOption {
      type = types.package;
      default = package;
      defaultText = "the flake's forgejo-adapter package";
      description = "The forgejo-adapter package the unit runs.";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        # systemd's StateDirectory only manages the last path component, so
        # a nested path under /var/lib would leave ReadWritePaths pointing
        # at a directory the unit never gets.
        assertion = cfg.stateDir == "/var/lib/${stateDirName}";
        message = "services.forgejo-adapter.stateDir must be exactly /var/lib/<name> (systemd's StateDirectory takes only the path's last component); got ${cfg.stateDir}.";
      }
      {
        assertion = cfg.forgeBaseUrl != null && cfg.forgeBaseUrl != "";
        message = "services.forgejo-adapter.forgeBaseUrl must be set: the module ships no upstream default and the deployer must provide the Forgejo instance URL.";
      }
      {
        # The adapter appends the intake path itself
        # (review/forgejo-adapter/src/intake.ts); a base value already
        # ending in /v1/events double-paths to /v1/events/v1/events, and
        # without this guard the failure only surfaces as failed
        # deliveries at run time.
        assertion = !lib.hasSuffix "/v1/events" cfg.zenigataIntakeUrl;
        message = "services.forgejo-adapter.zenigataIntakeUrl must be the base URL only; the adapter appends /v1/events itself, so a value ending in /v1/events double-paths the intake path (/v1/events/v1/events); got ${cfg.zenigataIntakeUrl}.";
      }
    ];

    systemd.services.forgejo-adapter = {
      description = "Forgejo adapter for Zenigata";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      environment = {
        FORGEJO_ADAPTER_LISTEN_PORT = toString cfg.listenPort;
        ZENIGATA_INTAKE_URL = cfg.zenigataIntakeUrl;
      }
      // optionalAttrs (cfg.forgeBaseUrl != null) {
        FORGEJO_BASE_URL = cfg.forgeBaseUrl;
      }
      // optionalAttrs (cfg.requestTimeoutMs != null) {
        FORGEJO_ADAPTER_REQUEST_TIMEOUT_MS = toString cfg.requestTimeoutMs;
      };

      serviceConfig = {
        ExecStart = "${cfg.package}/bin/forgejo-adapter";
        EnvironmentFile = "${cfg.secretsFile}";
        DynamicUser = true;
        # Keep any local state private to the service; systemd's default
        # state-dir mode is world-readable.
        StateDirectory = "${stateDirName}:0700";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        ReadWritePaths = [ cfg.stateDir ];
        Restart = "on-failure";
        RestartSec = 5;
      };
    };
  };
}
