# NixOS module: the watcher daemon (PRJ-540) and its webhook receiver
# (PRJ-542).
#
# One service, one environment file for the secrets, and the watcher
# block as a JSON file the module renders from `settings`. The secrets —
# every source's token (FORGEJO_TOKEN, SLACK_TOKEN, GITHUB_TOKEN,
# PAGERDUTY_TOKEN, the linear token), the host server's password, and
# the webhook receiver's WATCHER_WEBHOOK_SECRET — ride the unit's
# EnvironmentFile alone; `settings` is the block's non-secret surface
# (forgeUrl, pollSeconds, and the source blocks whose tokens stay in the
# secrets file). The process's local route binds loopback only; the
# session-side tools proxy to it over options.watcher.daemonUrl and no
# forge credential ever enters an opencode environment.
#
# The webhook receiver is the daemon's second server, and a different
# trust domain from the route: it serves the forge's deliveries,
# verified against WATCHER_WEBHOOK_SECRET. Its bind defaults to
# loopback — the adopter-first shape, zero infra change, polling stays
# the backstop for a forge that cannot reach the host. Making it
# reachable (an LAN allow-list, a tunnel front) is the deployment's
# choice, never a product fact; the hook registration it calls for is a
# hand step either way (one hook per watched repo: url + secret + the
# v17 events), and the daemon self-diagnoses a watched repo whose hook
# is missing.
#
# The unit runs under DynamicUser with ProtectHome, so the host's own
# service registration file (in the operator's home) is out of reach:
# `opencodeUrl` states the opencode server the daemon's stamps, mail,
# and event stream ride, and `opencodePassword` (secretsFile) carries
# the matching local password. The env names are the daemon's own:
# WATCHER_OPENCODE_URL and WATCHER_OPENCODE_PASSWORD.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.watcher-daemon;

  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    types
    ;

  # systemd's StateDirectory takes the path's last component and manages
  # /var/lib/<that component>; anything deeper would desync the unit's
  # directory grants from the path the service actually writes.
  stateDirName = lib.last (lib.splitString "/" cfg.stateDir);

  package = pkgs.callPackage ../watch/mail-watcher/package.nix { };

  # The watcher block, rendered as the JSON file WATCHER_CONFIG points
  # the daemon at. The projection's database defaults under the state
  # directory (the daemon's own default derives from $XDG_STATE_HOME,
  # which the DynamicUser sandbox should not depend on); a dbPath the
  # deployer states wins.
  #
  # The rendered file is a store path: world-readable by construction
  # (0444), not a secret. That is the module's boundary — settings
  # carries non-secret knobs only, and every token rides the secrets
  # file's EnvironmentFile, which the unit keeps out of the store. The
  # sources read the environment first and the block wins per key, so a
  # token pasted into settings would silently override the secrets file
  # and leak through the store path; the assertion below refuses it, and
  # the check in the flake's tests pins each source's placement.
  settings' = lib.recursiveUpdate {
    dbPath = "${cfg.stateDir}/pr-state.db";
  } cfg.settings;

  configFile = pkgs.writeText "watcher-daemon.json" (builtins.toJSON settings');

  # The secret keys the module refuses in settings, one walk per
  # family: the sources' tokens (isTokenKey), and the webhook
  # receiver's secret (PRJ-542). The walk skips derivations (a settings
  # value may be one) and walks lists, so no placement hides.
  isTokenKey = name: name == "token" || name == "forgeToken";

  # The webhook secret's keys: the receiver's settings paste targets.
  isWebhookSecretKey = name: name == "webhookSecret" || name == "secret";

  # The refused keys' paths in settings, named for the refusal message.
  secretPathsOf =
    pred: value: prefix:
    if lib.isAttrs value && !(value ? "type" && value.type == "derivation") then
      lib.concatMap (
        name:
        if pred name then [ "${prefix}.${name}" ] else secretPathsOf pred value.${name} "${prefix}.${name}"
      ) (builtins.attrNames value)
    else if lib.isList value then
      lib.concatMap (item: secretPathsOf pred item prefix) value
    else
      [ ];

  tokenPaths = secretPathsOf isTokenKey cfg.settings "settings";
  webhookSecretPaths = secretPathsOf isWebhookSecretKey cfg.settings "settings";
in
{
  options.services.watcher-daemon = {
    enable = mkEnableOption "the watcher daemon (PRJ-540): the forge reads leave the opencode environment";

    listenPort = mkOption {
      type = types.port;
      default = 8473;
      description = "Port the daemon's local route listens on (the route binds 127.0.0.1 only). The plugin's options.watcher.daemonUrl names this as http://127.0.0.1:<port>.";
    };

    webhookPort = mkOption {
      type = types.port;
      default = 8474;
      description = "Port the daemon's webhook receiver (PRJ-542) listens on — the daemon's second server, the forge's X-Forgejo-Signature-verified deliveries in.";
    };

    webhookBind = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = ''
        Address the webhook receiver binds. Loopback is the default and
        the adopter-first shape: zero infra change, and a forge that
        cannot reach the host loses nothing — polling stays the
        backstop. Making the receiver reachable is a deployment choice,
        not a product fact: allow-list it on the LAN, front it with a
        tunnel, or point the forge at it directly, whatever the host's
        shape allows. The hook registration is a hand step either way —
        one hook per watched repo (url + secret + the v17 events) — and
        the daemon self-diagnoses a watched repo whose hook is missing;
        state the url the hooks carry in settings.webhookUrl when the
        deployment's reachability choice produces one that differs from
        the receiver's own origin.
      '';
    };

    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/watcher-daemon";
      description = ''
        State directory for the service. systemd's `StateDirectory` takes
        only the path's last component, so the path must be exactly
        `/var/lib/<name>`; the assertion on the module enforces it. The
        pr-state projection's database lives here (settings.dbPath).
      '';
    };

    settings = mkOption {
      type = types.attrsOf types.anything;
      default = { };
      description = ''
        The watcher block the daemon composes from, as JSON — the shape
        the plugin's options.watcher carried before the split
        (forgeUrl, pollSeconds, the slack/github/pagerduty/linear
        blocks). Non-secret knobs only: the rendered file is a store
        path, world-readable by construction (0444), and the module
        refuses both a token anywhere in settings (the forge's
        forgeToken, or a token key inside the slack, github, pagerduty,
        or linear block) and a webhook secret anywhere in settings
        (webhookSecret). The projection's database path defaults under
        stateDir (`/var/lib/watcher-daemon/pr-state.db`).
        settings.webhookUrl (optional) names the url the deployment
        registered its webhook hooks under, for the missing-hook
        diagnosis.
      '';
    };

    opencodeUrl = mkOption {
      type = types.str;
      default = "";
      description = ''
        The opencode server's base url (WATCHER_OPENCODE_URL) — the
        service the daemon's stamp writes, synthetic mail, and event
        stream ride. There is no upstream default: the unit's sandbox
        cannot read the operator's service registration file, so the
        deployer must state the server. The empty default exists so
        forgetting the key reaches the module's assertion — which
        teaches the why — instead of the module system's bare
        used-but-not-defined error, which names the option but not the
        reason.
      '';
    };

    secretsFile = mkOption {
      type = types.path;
      description = ''
        Environment file loaded by the unit's `EnvironmentFile`, carrying
        the secrets the sources read from the environment:
        `FORGEJO_TOKEN` (required — the watcher is off without it),
        `SLACK_TOKEN`, `GITHUB_TOKEN`, `PAGERDUTY_TOKEN`, `LINEAR_TOKEN`,
        `WATCHER_WEBHOOK_SECRET` (the webhook receiver's shared secret —
        empty or absent fails closed: every delivery answers 403), and
        `WATCHER_OPENCODE_PASSWORD` — the opencode server's local
        password matching `opencodeUrl`.
      '';
    };

    package = mkOption {
      type = types.package;
      default = package;
      defaultText = "the flake's mail-watcher package";
      description = "The mail-watcher package the unit runs (the daemon's bin inside it).";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        # systemd's StateDirectory only manages the last path component, so
        # a nested path under /var/lib would leave ReadWritePaths pointing
        # at a directory the unit never gets.
        assertion = cfg.stateDir == "/var/lib/${stateDirName}";
        message = "services.watcher-daemon.stateDir must be exactly /var/lib/<name> (systemd's StateDirectory takes only the path's last component); got ${cfg.stateDir}.";
      }
      {
        assertion = cfg.opencodeUrl != "";
        message = "services.watcher-daemon.opencodeUrl must be set: the unit's sandbox cannot read the host's service registration file, so the opencode server must be stated.";
      }
      {
        # The rendered config file is a store path, world-readable by
        # construction; the sources read the environment first and the
        # block wins per key, so a token pasted here would silently
        # override the secrets file and leak through the store path.
        # The message names all five sources, so the failure teaches the
        # placement each one reads.
        assertion = tokenPaths == [ ];
        message = ''
          services.watcher-daemon.settings carries a token (${lib.concatStringsSep ", " tokenPaths}) — refuse it. The rendered config file is a store path and world-readable, and the sources read the environment first with the block winning per key, so a token here would silently override the secrets file and leak through the store path. Every source's token rides the secrets file's EnvironmentFile instead: the forge source reads FORGEJO_TOKEN (the block's own forgeToken key), the slack source reads SLACK_TOKEN (slack.token), the github source reads GITHUB_TOKEN (github.token), the pagerduty source reads PAGERDUTY_TOKEN (pagerduty.token), and the linear source reads LINEAR_TOKEN (linear.token). settings carries non-secret knobs only (forgeUrl, pollSeconds, dbPath, and the source blocks' urls, services, and projects).
        '';
      }
      {
        # The webhook secret's sibling refusal (PRJ-542): the same store
        # path, the same leak, a different secret — the receiver's shared
        # secret rides the secrets file as WATCHER_WEBHOOK_SECRET, read
        # from the environment alone, and an empty one fails closed
        # rather than leaking an unverified acceptance.
        assertion = webhookSecretPaths == [ ];
        message = ''
          services.watcher-daemon.settings carries a webhook secret (${lib.concatStringsSep ", " webhookSecretPaths}) — refuse it. The rendered config file is a store path and world-readable, so a webhook secret pasted into settings would leak through it. The receiver's secret rides the secrets file's EnvironmentFile instead, as WATCHER_WEBHOOK_SECRET, which the receiver reads from the environment alone. settings carries non-secret knobs only.
        '';
      }
    ];

    systemd.services.watcher-daemon = {
      description = "Watcher daemon: forge polling and session wake delivery, credential-free route on loopback";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network.target"
        # The ordering hints the common deployment: the daemon's session
        # writes, mail, and event stream ride the host's opencode server,
        # and the adoption walk is one-shot at daemon start, so a boot
        # before the server would race it. A host whose opencode unit
        # carries another name degrades harmlessly (an unknown ordering
        # name is ignored), and the event stream reconnects with backoff
        # (the daemon's host leg), so the deployment's composition stays
        # the authority on the exact unit name — the judgment, stated:
        # the hint lives here, the authoritative ordering lives with the
        # deployment that names the unit.
        "opencode.service"
      ];

      environment = {
        WATCHER_CONFIG = "${configFile}";
        WATCHER_ROUTE_PORT = toString cfg.listenPort;
        WATCHER_WEBHOOK_PORT = toString cfg.webhookPort;
        WATCHER_WEBHOOK_BIND = cfg.webhookBind;
        WATCHER_OPENCODE_URL = cfg.opencodeUrl;
      };

      serviceConfig = {
        ExecStart = "${cfg.package}/bin/watcher-daemon";
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
      # A secrets-file change is invisible to the unit otherwise: the
      # EnvironmentFile references the file by path, so a new secret
      # content redeploys nothing and the running daemon would hold the
      # old WATCHER_WEBHOOK_SECRET and source tokens until a restart it
      # never saw coming. The trigger restarts the service on the file's
      # change.
      restartTriggers = [ cfg.secretsFile ];
    };
  };
}
