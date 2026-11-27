# NixOS module: the Zenigata pull-request review bot (PRJ-548 rework).
#
# One service, one environment file for the secrets, every non-secret knob
# as an option that maps onto a ZENIGATA_* variable (the mapping is spelled
# out in review/zenigata/docs/deployment.md). The unit runs the runtime
# package's launcher: the opencode serve starts inside the config
# directory the launcher points it at — the package's own layout, or the
# composed two-file directory the module builds when overrideConfig
# carries the deployment's opencode.jsonc — and the bot execs beside it,
# so a deployment is an enablement, not an assembly.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.zenigata;

  inherit (lib)
    concatStringsSep
    hasInfix
    mkEnableOption
    mkIf
    mkOption
    types
    ;

  # systemd's StateDirectory takes the path's last component and manages
  # /var/lib/<that component>; anything deeper would desync the unit's
  # directory grants from the path the service actually writes.
  stateDirName = lib.last (lib.splitString "/" cfg.stateDir);

  # A conservative forge account name: letters, digits, dot, underscore,
  # hyphen, starting with a letter or digit. The runtime re-checks the
  # same shape on the rendered variable; this type rejects a malformed
  # entry where the deployment authors it, which is also where the comma
  # the CSV join cannot carry fails.
  accountName = types.strMatching "[A-Za-z0-9][A-Za-z0-9._-]*";

  # The deployment's config home, composed when overrideConfig carries a
  # file: the package floor's opencode.json with the deployment's
  # opencode.jsonc beside it, plus the agent and skills entries the
  # runtime home carries — the two-file directory the serve's own
  # precedence layers (jsonc wins for settings). The unit's
  # OPENCODE_CONFIG_DIR points here; without a deployment file the
  # launcher defaults to the package's own single-file home.
  composedConfigHome =
    if cfg.overrideConfig == null then
      null
    else
      pkgs.runCommand "zenigata-opencode-config-home" { } ''
        mkdir -p $out
        for entry in opencode.json agent skills; do
          ln -s "${cfg.package}/share/zenigata/opencode-home/$entry" "$out/$entry"
        done
        ln -s "${cfg.overrideConfig}" "$out/opencode.jsonc"
      '';
in
{
  options.services.zenigata = {
    enable = mkEnableOption "the Zenigata pull-request review bot";

    listenPort = mkOption {
      type = types.port;
      default = 8471;
      description = "Port the intake server listens on, on loopback only.";
    };

    opencodePort = mkOption {
      type = types.port;
      default = 8473;
      description = ''
        Port the packaged opencode serve listens on, on loopback only. The
        launcher composes the bot's serve URL from it; no deployment
        wiring reads or rewrites it.
      '';
    };

    overrideConfig = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = ''
        Optional path to an opencode.jsonc the deployment ships, layered
        over the runtime package's own config floor — the deployment's
        model route, the forge MCP server the reviewer posts through, and
        every other deployment-owned surface (PRJ-501's credential-bearing
        injection). The module composes the serve's config directory with
        the package floor's `opencode.json` and the deployment's
        `opencode.jsonc` beside it, and points the unit at it: the v2.3.0
        serve reads both files from one directory and merges with the
        jsonc winning for settings, so the deployment's file wins through
        the serve's own precedence, with no env var carrying a config
        path.
      '';
    };

    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/zenigata";
      description = ''
        Directory holding the review journal (`reviews.jsonl`), the
        disposable review worktrees, and the serve's own state (its
        database and session records live under it). systemd's
        `StateDirectory` takes only the path's last component, so the
        path must be exactly `/var/lib/<name>`; the assertion on the
        module enforces it.
      '';
    };

    secretsFile = mkOption {
      type = types.path;
      description = ''
        Environment file loaded by the unit's `EnvironmentFile`, carrying
        `ZENIGATA_EVENT_TOKEN`, `ZENIGATA_ADAPTER_TOKEN`, and every
        credential the stack reads from the environment — the model
        provider's key among them, named as the deployment's override
        config references it.
      '';
    };

    allowedLogins = mkOption {
      type = types.listOf types.str;
      description = ''
        Logins whose review requests are honored; a requester outside
        the list is skipped with no session and no post.
      '';
    };

    allowedRepos = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = ''
        Repositories the bot reviews. An empty list leaves the variable
        unset, which means every repository the adapter serves.
      '';
    };

    personaFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = ''
        Persona file overriding the packaged default at
        `<package>/persona.md`. The override beats the packaged default;
        `ZENIGATA_PERSONA_FILE` is set only when this is non-null.
      '';
    };

    adapterUrl = mkOption {
      type = types.str;
      description = "Base URL of the forge adapter service.";
    };

    forgeUrl = mkOption {
      type = types.str;
      description = ''
        Base URL of the forge the adapter serves, e.g.
        `https://forge.example.com`. The status page renders every PR cell as
        a link into the forge with it, and the dropped starts' re-request
        affordance points there. Not a secret: the unit carries it in its
        plain environment and the status page's config echo shows it.
      '';
    };

    memoryUrl = mkOption {
      type = types.str;
      description = ''
        The memory daemon's full MCP endpoint URL, query params included,
        e.g. `http://127.0.0.1:28132/mcp?app=zenigata&initiator=agent`.
        The `initiator=agent` param is the lineage gate's deployment
        declaration and must never be dropped: it is what makes the
        daemon attribute the bot's writes as agent observations.
      '';
    };

    humans = mkOption {
      type = types.listOf accountName;
      default = [ ];
      description = ''
        Forge accounts whose thread prose is a human's words to the bot's
        sessions: chiefly the operator's. The list renders one
        operator-speech sentence into the review session's and the answer
        session's start prompts — accounts on it speak for the operator
        for veracity and corrections, and every other account's prose is
        a claim to trace (PRJ-514, the session-origin ADR's review-bot
        instance). An empty list renders nothing: the reviewer then
        treats all thread content as claims.
      '';
    };

    reviewTimeoutSeconds = mkOption {
      type = types.ints.positive;
      default = 1800;
      description = ''
        Whole-run deadline for one review. A run that exceeds it reaches
        no verdict and posts nothing: the journal record is the failure
        surface, and only a completed review reaches the PR. A review the
        forge created from an abandoned in-flight post can still land
        afterwards; the run accepts that, and the adapter SHOULD dedupe
        posts on (repo, pr, expectedHeadSha) — see docs/forge-adapter.md.
      '';
    };

    turnPollSeconds = mkOption {
      type = types.ints.positive;
      default = 3;
      description = ''
        Seconds between the session driver's turn-state polls. The poll
        holds one short request, never a long wait on the model.
      '';
    };

    turnBudgetSeconds = mkOption {
      type = types.ints.positive;
      default = 1800;
      description = ''
        Seconds one prompt's turn may run before the session driver calls
        it stuck: the driver interrupts the turn and the prompt fails,
        which ends the run through its existing cleanup path. The
        whole-run deadline backstops it. The default covers the review
        run's single prompt (review 665): the session's whole skill flow
        — the review, its humanizer, and the forge post — is one turn.
      '';
    };

    retryPolicy = mkOption {
      type = types.enum [
        "never"
        "once"
      ];
      default = "never";
      description = ''
        The review-event retry posture. `never` (the default) refuses to
        re-process an event the journal already ran, so an automatic
        re-fire path exists nowhere in the default configuration. `once`
        allows one automatic re-run of a failed event on redelivery; only
        a failure triggers it, and a posted or aborted run is never
        re-run.
      '';
    };

    agentName = mkOption {
      type = types.str;
      default = "zenigata-reviewer";
      description = ''
        Agent name the session driver selects for every review and
        reply session. The runtime package composes the reviewer's
        definition into its own config layout under this same name —
        the packaged default is what makes `ZENIGATA_AGENT` resolve,
        and a deployment that renames the agent supplies its own
        definition through the override layer.
      '';
    };

    package = mkOption {
      type = types.package;
      description = ''
        The Zenigata runtime package the unit runs: the pinned serve, the
        reviewer agent, the skills tree, and the bot in one closure, with
        the launcher bin the unit's ExecStart starts. Set it to the
        flake's `packages.zenigata-runtime` — the runtime composes
        flake-pinned inputs (the branch-tracking opencode serve and the
        skills assets package) that a plain nixpkgs callPackage cannot
        provide.
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        # systemd's StateDirectory only manages the last path component, so
        # a nested path under /var/lib would leave ReadWritePaths pointing
        # at a directory the unit never gets.
        assertion = cfg.stateDir == "/var/lib/${stateDirName}";
        message = "services.zenigata.stateDir must be exactly /var/lib/<name> (systemd's StateDirectory takes only the path's last component); got ${cfg.stateDir}.";
      }
      {
        # ZENIGATA_ALLOWED_LOGINS would render empty and the bot's boot-time
        # config check would crash-loop the unit.
        assertion = cfg.allowedLogins != [ ];
        message = "services.zenigata.allowedLogins must not be empty: ZENIGATA_ALLOWED_LOGINS is required and an empty list renders it empty.";
      }
      {
        # Without initiator=agent the memory daemon's lineage gate refuses
        # every observation write: the bot would answer replies but
        # silently never learn from them.
        assertion = hasInfix "initiator=agent" cfg.memoryUrl;
        message = "services.zenigata.memoryUrl must carry the initiator=agent query parameter: without it the memory daemon's lineage gate refuses every observation write and the bot silently never learns.";
      }
    ];

    systemd.services.zenigata = {
      description = "Zenigata pull-request review bot";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      # The review pipeline runs git (clone, fetch, checkout, rev-parse)
      # as a subprocess, so the unit carries it on PATH.
      path = [ pkgs.git ];

      environment = {
        ZENIGATA_LISTEN_PORT = toString cfg.listenPort;
        ZENIGATA_STATE_DIR = cfg.stateDir;
        OPENCODE_SERVE_PORT = toString cfg.opencodePort;
        ZENIGATA_ALLOWED_LOGINS = concatStringsSep "," cfg.allowedLogins;
        ZENIGATA_ADAPTER_URL = cfg.adapterUrl;
        ZENIGATA_FORGE_URL = cfg.forgeUrl;
        ZENIGATA_MEMORY_URL = cfg.memoryUrl;
        ZENIGATA_REVIEW_TIMEOUT_SECONDS = toString cfg.reviewTimeoutSeconds;
        ZENIGATA_AGENT = cfg.agentName;
        # The serve's state lands under HOME (XDG's defaults derive from
        # it), inside the granted state directory: no extra ReadWritePaths
        # for the serve's database and session records.
        HOME = cfg.stateDir;
      }
      // lib.optionalAttrs (cfg.allowedRepos != [ ]) {
        ZENIGATA_ALLOWED_REPOS = concatStringsSep "," cfg.allowedRepos;
      }
      // lib.optionalAttrs (cfg.humans != [ ]) {
        ZENIGATA_HUMANS = concatStringsSep "," cfg.humans;
      }
      // lib.optionalAttrs (cfg.personaFile != null) {
        ZENIGATA_PERSONA_FILE = cfg.personaFile;
      }
      // lib.optionalAttrs (cfg.overrideConfig != null) {
        OPENCODE_CONFIG_DIR = composedConfigHome;
      }
      # The three knobs default to the quiet-spend posture; the variables
      # render only when an option departs from its default, so a
      # deployment that never touches them gets the unit's environment
      # bytes for nothing else.
      // lib.optionalAttrs (cfg.turnPollSeconds != 3) {
        ZENIGATA_TURN_POLL_SECONDS = toString cfg.turnPollSeconds;
      }
      // lib.optionalAttrs (cfg.turnBudgetSeconds != 1800) {
        ZENIGATA_TURN_BUDGET_SECONDS = toString cfg.turnBudgetSeconds;
      }
      // lib.optionalAttrs (cfg.retryPolicy != "never") {
        ZENIGATA_RETRY_POLICY = cfg.retryPolicy;
      };

      serviceConfig = {
        # The launcher: the serve starts in the package's own config
        # layout, then the bot execs in the foreground. One unit, one
        # process pair; a stop or a crash takes both, and
        # Restart=on-failure loops the pair (the boot preflight's named
        # exits included).
        ExecStart = "${cfg.package}/bin/zenigata-stack";
        EnvironmentFile = "${cfg.secretsFile}";
        DynamicUser = true;
        # The 0700 keeps the journal (review bodies, failure messages) and
        # the review worktrees — whose .git/config carries the credentialed
        # clone URL for the whole run — unreadable to other host users;
        # systemd's default state-dir mode is world-readable.
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
