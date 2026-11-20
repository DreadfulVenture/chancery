# Home-manager module: the memory-store daemon as a background service, plus
# the Cursor and OpenCode client wiring that goes with it.
#
# Two init systems, one module. Everything that decides when the daemon runs
# is platform-specific — a launchd agent on darwin, a systemd --user unit
# elsewhere — and everything else, the client config, the Cursor wiring and
# the OpenCode plugin link, is the same on both. The platform-specific part
# runs to about fifty lines, which does not pay for a second module plus a
# shared file to thread the common derivations through.
#
# The condition is always on a value, never on which attributes `config` has:
# the module system needs the shape of the returned attrset before it can
# hand this module its `pkgs` argument, so deciding the shape from
# pkgs.stdenv deadlocks.
{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.memory-store;
  home = config.home.homeDirectory;

  inherit (pkgs.stdenv.hostPlatform) isDarwin isLinux;

  inherit (lib)
    mkIf
    mkOption
    mkEnableOption
    types
    ;
  inherit (lib.generators) toPlist;

  # Where the daemon's code is read from.
  sourceDir = "${cfg.package}/lib/memory-store";

  # The client assets ship as real packages; the module only links from
  # them. Held as derivations rather than interpolated strings.
  pluginPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.memory-store-plugin;
  assetsPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.memory-store-opencode;
  # The writs' reminder plugins ship as flat scanned-plugin files, one
  # package each; the director ships as a directory plugin the deployment
  # names in its config, and its agent definition rides that package
  # (PRJ-453) — the module links only the agent from it.
  planReminderPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.plan-reminder;
  discoveryReminderPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.discovery-reminder;
  directorPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.director;
  # The wake CLI is its own product surface (PRJ-383 review 189), not the
  # memory plugin's, so the bin rides its own package onto PATH.
  ocWakePackage = self.packages.${pkgs.stdenv.hostPlatform.system}.oc-wake;

  daemonEnv = {
    MEMORY_MCP_PORT = toString cfg.port;
    MEMORY_DATA_DIR = cfg.dataDir;
    MEMORY_QUEUE_DIR = cfg.queueDir;
    MEMORY_HUB_URL = cfg.hubUrl;
    MEMORY_EMBEDDING_MODEL = cfg.embeddingModel;
    MEMORY_LLM_BASE_URL = cfg.llm.baseUrl;
    MEMORY_LLM_MODEL = cfg.llm.model;
    MEMORY_LLM_TIMEOUT = toString cfg.llm.timeoutSecs;
    MEMORY_LLM_EXTRA_BODY = cfg.llm.extraBody;
    MEMORY_CONSOLIDATION_IDLE_SECS = toString cfg.consolidationIdleSecs;
    MEMORY_SPAN_LOG = cfg.logLevel;
    MEMORY_TOOL_HOLDS = if cfg.toolHolds then "1" else "0";
  }
  // lib.optionalAttrs (cfg.embeddingDim != null) {
    MEMORY_EMBEDDING_DIM = toString cfg.embeddingDim;
  }
  // lib.optionalAttrs (cfg.machineId != "") { MEMORY_MACHINE_ID = cfg.machineId; }
  // lib.optionalAttrs cfg.cursor.enable {
    MEMORY_FLOOR_RULE_PATH = cfg.cursor.floorRulePath;
    MEMORY_CURSOR_HOOKS_PATH = cfg.cursor.hooksPath;
    MEMORY_CURSOR_HOOK_COMMAND = cursorHookCommand;
  }
  // cfg.extraEnv;

  # Everything a client has to know and cannot work out for itself. Clients
  # run with whatever environment their editor was launched from, so a
  # deployment that moved the port or the data directory reaches them here
  # or not at all. The floor and the contract reach OpenCode through the
  # generated config's `instructions` entries instead — the daemon still
  # writes both files, and the harness watches and delivers them.
  clientConfig = pkgs.writeText "memory-store-client.json" (
    builtins.toJSON {
      daemon_url = "http://127.0.0.1:${toString cfg.port}";
      queue_dir = cfg.queueDir;
      log_level = cfg.logLevel;
    }
  );

  exportLines = lib.concatStringsSep "\n" (
    lib.mapAttrsToList (name: value: "export ${name}=${lib.escapeShellArg value}") daemonEnv
  );

  # uv resolves the dependency set from the lock beside the memory_store
  # package. The venv goes to a writable path because the packaged source
  # lives in the store.
  #
  # The interpreter is platform-specific. On darwin only-managed holds: uv's
  # own CPython runs, and the system python is built without loadable SQLite
  # extensions, so pointing uv at it would silently lose the sqlite-vec
  # index — recall degrading from an index lookup to a scan of every vector,
  # with nothing reporting the loss. NixOS refuses to execute a dynamically
  # linked managed CPython at all (exit 2, crash-loop), so Linux hands uv
  # the same nixpkgs python the daemon is verified against; that python
  # loads sqlite-vec via enable_load_extension (verified against 3.12).
  # The consumer's own python is honored, keep it loadable.
  # The name is built from cfg.python.pythonVersion: a consumer points at a
  # newer nixpkgs python without caring for the exact binary suffix.
  pythonBin = "${cfg.python}/bin/python${lib.versions.majorMinor cfg.python.pythonVersion}";
  pythonExport =
    if cfg.extraEnv ? UV_PYTHON then
      ""
    else if isDarwin then
      "export UV_PYTHON_PREFERENCE=only-managed"
    else
      "export UV_PYTHON=${pythonBin}\nexport UV_PYTHON_PREFERENCE=only-system";

  # Sourced before the fixed exports so that a deployment stays the
  # authority over the settings the option tree owns (port, data dirs) and
  # the file carries only what the tree has no place for: secrets never see
  # nix, and a plain MEMORY_* value in the file will not silently shadow the
  # module's own option for the same key.
  sourceEnvFile = lib.optionalString (cfg.environmentFile != null) ''
    if [ ! -f ${lib.escapeShellArg cfg.environmentFile} ]; then
      echo "memory-store-daemon: environmentFile ${lib.escapeShellArg cfg.environmentFile} is missing" >&2
      exit 2
    fi
    set -a
    # the path arrives resolved in the store; shellcheck cannot follow a source
    # target outside the script's own inputs, so the lookup is silenced here
    # rather than widened for the whole file
    # shellcheck disable=SC1091
    . ${lib.escapeShellArg cfg.environmentFile}
    set +a
  '';

  runScript = pkgs.writeShellApplication {
    name = "memory-store-daemon";
    runtimeInputs = [ pkgs.uv ];
    text = ''
      ${sourceEnvFile}
      ${exportLines}
      # uv creates the venv itself; pre-creating the directory makes it an
      # existing non-venv and uv refuses it.
      export UV_PROJECT_ENVIRONMENT=${lib.escapeShellArg cfg.stateDir}/venv
      ${pythonExport}
      export FASTEMBED_CACHE_PATH=${lib.escapeShellArg "${home}/.cache/fastembed"}
      export PYTHONUNBUFFERED=1
      mkdir -p "$MEMORY_DATA_DIR" "$MEMORY_QUEUE_DIR" "$FASTEMBED_CACHE_PATH" \
        ${lib.escapeShellArg cfg.stateDir}
      src=${lib.escapeShellArg sourceDir}
      # The app runs as a Python package: its parent directory is the import
      # root, and the entry point lives inside memory_store/. A deployment
      # adding its own PYTHONPATH through extraEnv gets it as a suffix after
      # the import root; UV_PYTHON keeps the extraEnv-wins rule.
      export PYTHONPATH="$src''${PYTHONPATH:+:$PYTHONPATH}"
      uv sync --frozen --project "$src"
      exec uv run --frozen --no-sync --project "$src" python3 "$src/memory_store/server/daemon.py"
    '';
  };

  wrapperPath = "${home}/.local/bin/memory-store-daemon";
  plistPath = "${home}/Library/LaunchAgents/${cfg.label}.plist";

  # macOS announces a background item again whenever the plist or the
  # executable named in it resolves to a different file, so on darwin the
  # wrapper execs through this symlink rather than naming the daemon's store
  # path. That keeps the wrapper's own text identical across rebuilds, and
  # launchd never looks past it.
  daemonLink = "${cfg.stateDir}/daemon";

  # /bin/sh over a store path for the same reason. The wait is because the
  # script itself sits outside the store: launchd execs it successfully at
  # login whether or not the store volume is mounted, and the daemon it points
  # at is not there until it is.
  darwinWrapper = pkgs.writeText "memory-store-daemon" ''
    #!/bin/sh
    /bin/wait4path /nix/store
    exec ${lib.escapeShellArg daemonLink}
  '';

  # Written by hand rather than through home-manager's launchd.agents, which
  # wraps every program in `/bin/sh -c wait4path …` — macOS then lists the
  # login item as "sh".
  launchdAgent = toPlist { escape = true; } {
    Label = cfg.label;
    ProgramArguments = [ wrapperPath ];
    RunAtLoad = true;
    KeepAlive = true;
    StandardOutPath = cfg.logFile;
    StandardErrorPath = cfg.logFile;
    LimitLoadToSessionType = "Aqua";
  };

  launchdPlist = pkgs.writeText "${cfg.label}.plist" launchdAgent;

  # default.target rather than graphical-session.target: the daemon serves a
  # loopback port and has nothing to do with a display. Logs go to logFile
  # rather than the journal so that the one path the README points at holds
  # whichever init is running; `journalctl --user -u` is unaffected.
  systemdUnit = {
    Unit.Description = "memory-store daemon";
    Service = {
      ExecStart = wrapperPath;
      Restart = "always";
      StandardOutput = "append:${cfg.logFile}";
      StandardError = "append:${cfg.logFile}";
    };
    Install.WantedBy = [ "default.target" ];
  };

  # Reload only when the definition actually moved. The daemon holds Cursor's
  # MCP session for the life of the process, so an unconditional restart on
  # every activation drops a live session for nothing.
  signature = builtins.hashString "sha256" (
    (
      if isDarwin then
        # The wrapper is what launchd actually starts, so its text belongs in
        # the signature alongside the plist: a reload is the only thing that
        # gets a running agent onto a rewritten wrapper.
        launchdAgent + darwinWrapper.outPath
      else
        builtins.toJSON systemdUnit
    )
    + runScript.outPath
  );

  # Absolute because an activation script's PATH is not ours to assume, and a
  # store path is the only spelling of these tools that exists on both
  # platforms.
  coreutils = "${pkgs.coreutils}/bin";
  cmp = "${pkgs.diffutils}/bin/cmp";

  # launchd reads the plist and the wrapper from the home directory rather
  # than through home.file, because home.file makes them symlinks into one
  # store path shared by every file it manages, so an edit to any of those
  # moves these two as well, and macOS reads a moved file as a background item
  # the user has not seen before. Replacing only on a content change is what
  # keeps an unrelated rebuild from announcing all over again.
  launchdInstall = ''
    installStable() {
      local src="$1" dst="$2" mode="$3"
      if [[ -f "$dst" && ! -L "$dst" ]] && ${cmp} -s "$src" "$dst"; then
        return 0
      fi
      verboseEcho "Installing $dst"
      run ${coreutils}/mkdir -p "$(${coreutils}/dirname "$dst")"
      run ${coreutils}/install -m "$mode" "$src" "$dst.new"
      run ${coreutils}/mv -f "$dst.new" "$dst"
    }

    run ${coreutils}/ln -sfn ${lib.escapeShellArg "${runScript}/bin/memory-store-daemon"} ${lib.escapeShellArg daemonLink}
    installStable ${darwinWrapper} ${lib.escapeShellArg wrapperPath} 0755
    installStable ${launchdPlist} ${lib.escapeShellArg plistPath} 0644
  '';

  # The two halves answer the same pair of questions: is it already running
  # with this definition, and if not, replace it. Which one is chosen is an
  # eval-time decision, not a runtime one — pkgs.systemd does not exist on
  # darwin, and nothing forces the branch that is not taken.
  launchdReload = ''
    domain="gui/$UID"
    plist="${home}/Library/LaunchAgents/$label.plist"
    if /bin/launchctl print "$domain/$label" >/dev/null 2>&1 \
       && [[ -f "$marker" && "$(${coreutils}/cat "$marker")" == "$sig" ]]; then
      verboseEcho "$label unchanged; leaving it running"
    else
      verboseEcho "Reloading $label"
      run /bin/launchctl bootout "$domain/$label" 2>/dev/null || true
      # bootout is asynchronous and a KeepAlive service may still be tearing
      # down; bootstrapping into a domain that still holds the label fails
      # with "5: Input/output error".
      for _ in {1..20}; do
        /bin/launchctl print "$domain/$label" >/dev/null 2>&1 || break
        sleep 0.5
      done
      if run /bin/launchctl bootstrap "$domain" "$plist"; then
        echo "$sig" > "$marker"
      else
        warnEcho "Failed to bootstrap $label"
      fi
    fi
  '';

  # The signature is what decides, not the unit text: it digests the unit
  # content including the daemon's store paths, so an unchanged signature
  # means an unchanged daemon and a restart would be pure churn.
  systemdReload = ''
    unit="$label.service"
    if ${pkgs.systemd}/bin/systemctl --user is-active --quiet "$unit" \
       && [[ -f "$marker" && "$(${coreutils}/cat "$marker")" == "$sig" ]]; then
      verboseEcho "$unit unchanged; leaving it running"
    else
      verboseEcho "Reloading $unit"
      run ${pkgs.systemd}/bin/systemctl --user daemon-reload
      if run ${pkgs.systemd}/bin/systemctl --user restart "$unit"; then
        echo "$sig" > "$marker"
      else
        warnEcho "Failed to restart $unit"
      fi
    fi
  '';

  cursorHookDir = "${sourceDir}/clients/cursor";
  cursorHookCommand = "${cursorHookDir}/hook";

  # The three pieces Cursor needs — the MCP server, the capture hooks, the
  # contract rule — are registered one per file, in the three places Cursor
  # rereads whenever it rebuilds its state.
  #
  # A Cursor plugin would hold all three in one directory, and on 3.21.18
  # there is no durable way to deliver one here. ~/.cursor/plugins/local is
  # refused outright: the loader gates it on an admin setting, allowing local
  # imports for a team account only when allowUserLocalPluginImports is not
  # false, and it is false on this team. The remaining route is answering a
  # workspaceOpen hook with a path, and a plugin arriving that way lasts only
  # until the extension host restarts — the restart rebuilds the plugin
  # registry without re-firing workspaceOpen, so the plugin is dropped while
  # its hook entry stays in hooks.json looking healthy. Nothing reports it,
  # and the capture hooks stop firing silently along with the tools.
  #
  # Direct registration has none of that: the servers already in mcp.json
  # were measured surviving the same extension host restart that dropped the
  # plugin, and a deploy reaches a running Cursor instead of waiting for one.

  # The client name rides on the URL because Cursor has no way to put it in a
  # tool call: its MCP hooks allow or deny, they do not rewrite arguments. The
  # daemon stamps writes from this and refuses a connection that claims
  # nothing. The lineage initiator rides beside it for the same reason — the
  # deployment's declaration of who starts Cursor's sessions, read at the
  # gate and never taken from a model-supplied argument (PRD
  # 20261114-lineage-gated-writes).
  cursorServerUrl = "http://127.0.0.1:${toString cfg.port}/mcp?app=cursor&initiator=human";

  # The frontmatter belongs to Cursor and the bodies belong to the repo's
  # shipped rules, so the rules stay plain markdown in the repo and are
  # wrapped here. Each lands in ~/.cursor/rules beside the floor, which the
  # daemon re-renders on every persona write.
  cursorRule =
    file: name: description:
    pkgs.writeText name ''
      ---
      description: ${description}
      alwaysApply: true
      ---

      ${builtins.readFile file}
    '';

  cursorContractRule =
    cursorRule ../memory/store/instructions/memory.md "memory.mdc"
      "How the memory tools work and when to use them";

  cursorWritingRule =
    cursorRule ../memory/store/instructions/writing.md "writing.mdc"
      "The writing rule for agent prose";

  # Read as a set for the same reason the package fileset is: a skill nobody
  # remembered to list would be missing from the client with nothing reporting
  # it. The names come from the flake's own copy, so adding a skill needs a
  # rebuild — and so does editing one, since the links reach into the package
  # rather than at a working tree.
  skillNames = lib.attrNames (
    lib.filterAttrs (_: entryType: entryType == "directory") (builtins.readDir ../writs/skills)
  );

  # Both clients take the same layout — one directory per skill holding a
  # SKILL.md — so the only thing that differs is where they look for it.
  skillLinks =
    dir: packageDrv: packageSub:
    lib.listToAttrs (
      map (name: {
        name = "${lib.removePrefix "${home}/" dir}/${name}";
        value.source = "${packageDrv}/${packageSub}/${name}";
      }) skillNames
    );

  # Skills are linked as whole directories; the rest of the client assets are
  # flat files linked one by one, read off the flake's own copy so nothing
  # can be forgotten to list. The links reach the package outputs, which are
  # the distribution boundary consumers build against. The `exts` filter
  # keeps packaging files (package.json, package.nix) and tests out of the
  # scanned plugins dir: the plugin packages' source roots carry them.
  fileLinks =
    dir: sourceRoot: packageDrv: packageSub: exts:
    lib.mapAttrs'
      (
        name: _:
        lib.nameValuePair "${lib.removePrefix "${home}/" dir}/${name}" {
          source = "${packageDrv}/${packageSub}/${name}";
        }
      )
      (
        lib.filterAttrs (name: _: exts == null || lib.any (ext: lib.hasSuffix ".${ext}" name) exts) (
          lib.filterAttrs (_: entryType: entryType == "regular") (builtins.readDir sourceRoot)
        )
      );
in
{
  options.services.memory-store = {
    enable = mkEnableOption "the memory-store daemon";

    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.memory-store;
      defaultText = "memory-store's own package for this system";
      description = "Package holding the daemon sources.";
    };

    port = mkOption {
      type = types.port;
      default = 17173;
      description = "Loopback port serving the MCP endpoint and /nudge.";
    };

    label = mkOption {
      type = types.str;
      default = "dev.memory-store.daemon";
      description = "launchd label for the agent.";
    };

    dataDir = mkOption {
      type = types.str;
      default = "${home}/.local/services/memory/data";
      description = "Directory holding the SQLite store and the rendered floor.";
    };

    queueDir = mkOption {
      type = types.str;
      default = "${home}/.local/services/memory/queue";
      description = "Directory holding the capture queue the clients append to.";
    };

    clientConfigPath = mkOption {
      type = types.str;
      default = "${home}/.local/services/memory/client.json";
      description = ''
        Where the clients look up the daemon's port and queue directory. Cursor
        runs hooks with a login environment the launchd agent's settings never
        reach, so a non-default port has no other way to get to the hook.
        Changing this needs MEMORY_CLIENT_CONFIG set to match in every client.
      '';
    };

    stateDir = mkOption {
      type = types.str;
      default = "${home}/.local/state/memory-store";
      description = "Writable scratch: the uv virtualenv and the reload signature.";
    };

    rulesDir = mkOption {
      type = types.str;
      default = "${home}/.local/services/chancery/rules";
      description = ''
        The chancery's working rules, placed as watched instruction files.
        The flake's opencodeConfig export lists the default path, so
        overriding it needs the consuming deployment's own instructions
        list to follow.
      '';
    };

    logFile = mkOption {
      type = types.str;
      default =
        if isDarwin then "${home}/Library/Logs/memory-store.launchd.log" else "${cfg.stateDir}/daemon.log";
      defaultText = "~/Library/Logs on darwin, stateDir/daemon.log elsewhere";
      description = "Combined stdout/stderr path for the service.";
    };

    machineId = mkOption {
      type = types.str;
      default = "";
      description = "Origin stamp on records; the hostname when left empty.";
    };

    embeddingModel = mkOption {
      type = types.str;
      default = "BAAI/bge-small-en-v1.5";
      description = ''
        fastembed model for recall vectors. The dimension is written into the
        store the first time it is created, so changing this later is a
        migration rather than a setting.
      '';
    };

    embeddingDim = mkOption {
      type = types.nullOr types.int;
      default = null;
      description = "Vector width, needed only for models outside the known-dimension table.";
    };

    hubUrl = mkOption {
      type = types.str;
      default = "";
      description = ''
        Relay to sync with. Empty means this machine keeps its own store:
        nothing queues for push and no sync cycle runs.
      '';
    };

    consolidationIdleSecs = mkOption {
      type = types.int;
      default = 600;
      description = "How quiet a session must be before its turns are summarized.";
    };

    llm = {
      baseUrl = mkOption {
        type = types.str;
        default = "";
        example = "http://127.0.0.1:11434/v1";
        description = "OpenAI-compatible endpoint for consolidation. Empty disables summarizing.";
      };

      model = mkOption {
        type = types.str;
        default = "";
        description = "Model name at that endpoint.";
      };

      timeoutSecs = mkOption {
        type = types.int;
        default = 300;
        description = "Ceiling on one summarize call.";
      };

      extraBody = mkOption {
        type = types.str;
        default = "";
        example = ''{"reasoning_effort": "none"}'';
        description = ''
          JSON object merged into every chat-completion request. Ollama takes
          reasoning controls only per request, so a reasoning model needs its
          deliberation switched off here or each summary costs minutes.
        '';
      };
    };

    logLevel = mkOption {
      type = types.enum [
        "debug"
        "info"
        "error"
      ];
      default = "info";
      description = ''
        One level for the daemon and both clients. At `debug` each side
        emits point observations alongside its spans: the locations a
        client resolved, whether standing context reached the model, and
        why a prompt was or was not nudged. Clients have no other
        observability — a hook that ran and declined and a hook Cursor
        never invoked are otherwise indistinguishable.

        It reaches the clients through client.json, since they run with
        whatever environment their editor was launched from.
      '';
    };

    toolHolds = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Whether a tool rule may hold a call. On, a bound tool's first
        execution in each conversation is refused with the rule as its
        error, and later executions get the rule as information. Off, every
        tool rule is information only.

        Cursor's first-tool hold for unfetched session-start facts is not
        a tool rule and applies either way.
      '';
    };

    extraEnv = mkOption {
      type = types.attrsOf types.str;
      default = { };
      description = "Additional MEMORY_* environment for the daemon.";
    };

    python = mkOption {
      type = types.package;
      default = pkgs.python312;
      defaultText = "nixpkgs python312";
      description = ''
        The interpreter uv builds and runs the daemon with. Only consumed on
        Linux: uv's own managed CPython is a dynamically linked binary NixOS
        refuses to execute, so the wrapper pins UV_PYTHON to this package
        (darwin keeps uv's managed python, which runs there). The package's
        sqlite must accept loadable extensions — the store loads sqlite-vec
        through one, and a python that cannot degrades recall from an index
        lookup to a scan of every vector with nothing reporting it.
      '';
    };

    environmentFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = ''
        Path to an env file (agenix/sops/a plain VAR=... file) sourced before
        the daemon starts, for secrets and deployment values the option tree
        has no knob for. Sourced with set -a, before the module's own exports,
        so a file cannot quietly shadow an option-backed setting; a missing
        file stops the daemon loudly. A file change is part of the reload
        signature, but only the path is known at eval time — rotating the
        contents still needs a restart (`systemctl --user restart`, or a
        rebuild that re-writes the unit).
      '';
    };

    cursor = {
      enable = mkEnableOption "the Cursor client (the MCP server, the capture hooks, the rules and the skills)";

      configDir = mkOption {
        type = types.str;
        default = "${home}/.cursor";
        description = "Cursor's global configuration directory.";
      };

      serverName = mkOption {
        type = types.str;
        default = "memory";
        description = "Key under mcpServers in mcp.json.";
      };

      hookEvents = mkOption {
        type = types.listOf types.str;
        default = [
          "beforeSubmitPrompt"
          "afterAgentResponse"
          "preCompact"
        ];
        description = ''
          Conversation events the client answers, merged into Cursor's
          hooks.json. Which events fire the client is the client's own
          contract, so it is declared here rather than by whoever installs
          it. The tool-time events are the daemon's (daemonHookEvents).

          sessionStart is deliberately absent: Cursor silently drops its
          payload above a small, undocumented size. The session-start
          delivery rides the conversation's first beforeSubmitPrompt instead,
          which inlines up to 10,000 characters across all hooks. The
          knowledge-base doc (capped at 6,000) goes inline; the facts matched
          to the opening request would push it past the limit, so the block
          tells the agent to fetch them with knowledge_read first.
        '';
      };

      hookMatchers = mkOption {
        type = types.attrsOf types.str;
        default = { };
        description = ''
          Per-event matcher regexes for hookEvents. An event without one runs
          the client on every fire, which is right for the conversation
          events.
        '';
      };

      daemonHookEvents = mkOption {
        type = types.listOf types.str;
        default = [
          "beforeShellExecution"
          "preToolUse"
          "postToolUse"
        ];
        description = ''
          Events the daemon registers in hooks.json itself, which activation
          then leaves entirely alone — neither writing nor pruning them.

          These are the tool-time events. Their matchers are the tools the
          store has rules bound to, which change when a rule is enrolled
          rather than when the machine is rebuilt. A matcher baked at build
          time would be stale by the next enrolment, and activation pruning
          what it did not write would delete the daemon's entries on every
          rebuild. preToolUse matches every tool: the hook stamps the
          workspace directory and conversation onto the memory tools that
          need them, which Cursor cannot carry in the MCP arguments itself,
          reports compliance pulls, and refuses a conversation's first tool
          call once while its session-start facts sit unfetched.
        '';
      };

      floorRulePath = mkOption {
        type = types.str;
        default = "${home}/.cursor/rules/memory-floor.mdc";
        description = ''
          Where the daemon renders the floor as an always-applied rule. The
          daemon owns this one rather than nix, because it is rewritten
          whenever a floor rule is written rather than on a rebuild.
        '';
      };

      hooksPath = mkOption {
        type = types.str;
        default = "${home}/.cursor/hooks.json";
        description = ''
          Cursor's hooks file, handed to the daemon so it can keep its
          tool-time entries current. Shared with every other tool the user
          installs, so the daemon replaces only its own entries.
        '';
      };
    };

    opencode = {
      enable = mkEnableOption "the OpenCode client (the plugin and the skills)";

      pluginDir = mkOption {
        type = types.str;
        default = "${home}/.config/opencode/plugins";
        description = ''
          Directory OpenCode scans for plugins. Anything matching
          plugins/*.js there is loaded, so the file only has to land in it.
        '';
      };

      skillsDir = mkOption {
        type = types.str;
        default = "${home}/.config/opencode/skills";
        description = ''
          Directory OpenCode scans for global skills, one `<name>/SKILL.md`
          per subdirectory. `~/.claude/skills` and `~/.agents/skills` are
          skill sources too, and a skill is identified by its directory
          name, so linking the same set into one of those as well is
          redundant rather than additive.
        '';
      };

      agentsDir = mkOption {
        type = types.str;
        default = "${home}/.config/opencode/agents";
        description = "Directory OpenCode scans for global agents, one `<name>.md` per file.";
      };

      commandsDir = mkOption {
        type = types.str;
        default = "${home}/.config/opencode/commands";
        description = "Directory OpenCode scans for global commands, one `<name>.md` per file.";
      };
    };
  };

  # The platform split rides on mkIf rather than on `// optionalAttrs
  # isDarwin`, because the module system asks which attributes `config` has
  # before it can hand this module its `pkgs` argument. Deciding the shape of
  # the attrset from pkgs.stdenv is what makes that circular; deciding a
  # value from it is not.
  config = mkIf cfg.enable (
    lib.mkMerge [
      (mkIf isDarwin {
        # The plist is recorded in the generation so that whoever installs the
        # module can see, by diffing one generation against the next, that the
        # agent is gone and has to be booted out. Dropping the module takes
        # this module's own activation code with it, so nothing here is in a
        # position to do that cleanup.
        home.extraBuilderCommands = ''
          mkdir -p $out/launch-agents
          ln -s ${launchdPlist} $out/launch-agents/${cfg.label}.plist
        '';
      })
      (mkIf isLinux {
        systemd.user.services.${cfg.label} = systemdUnit;

        # systemd reads the unit afresh on every activation and nothing
        # reports the ExecStart path to the user, so none of the stable-path
        # care darwin needs buys anything here: the wrapper names the daemon
        # directly and home-manager owns the file.
        home.file.".local/bin/memory-store-daemon" = {
          text = ''
            #!${pkgs.runtimeShell}
            exec ${runScript}/bin/memory-store-daemon
          '';
          executable = true;
        };
      })
      {
        assertions = [
          {
            assertion = isDarwin || isLinux;
            message = "services.memory-store runs the daemon under launchd or systemd --user, and knows no other init.";
          }
          {
            # home.file can only place things under the home directory, and the
            # plugin is installed that way.
            assertion = !cfg.opencode.enable || lib.hasPrefix "${home}/" cfg.opencode.pluginDir;
            message = "services.memory-store.opencode.pluginDir must be inside ${home}.";
          }
          {
            # Same constraint: the skills are linked with home.file too.
            assertion = !cfg.opencode.enable || lib.hasPrefix "${home}/" cfg.opencode.skillsDir;
            message = "services.memory-store.opencode.skillsDir must be inside ${home}.";
          }
          {
            # The rules are placed with home.file too, and the flake export
            # lists the default path.
            assertion = !cfg.opencode.enable || lib.hasPrefix "${home}/" cfg.rulesDir;
            message = "services.memory-store.rulesDir must be inside ${home}.";
          }
          {
            assertion = !cfg.opencode.enable || lib.hasPrefix "${home}/" cfg.opencode.agentsDir;
            message = "services.memory-store.opencode.agentsDir must be inside ${home}.";
          }
          {
            assertion = !cfg.opencode.enable || lib.hasPrefix "${home}/" cfg.opencode.commandsDir;
            message = "services.memory-store.opencode.commandsDir must be inside ${home}.";
          }
          {
            # Same constraint: the contract rule is placed with home.file.
            assertion = !cfg.cursor.enable || lib.hasPrefix "${home}/" cfg.cursor.configDir;
            message = "services.memory-store.cursor.configDir must be inside ${home}.";
          }
        ];

        home = {
          # The wake CLI's own package puts its bin on PATH (PRJ-383 review
          # 189: the memory plugin's package no longer carries the bin). The
          # bin reads /proc for its pid + starttime identity, so the package
          # is linux-only and darwin takes the plugin without it.
          packages = lib.optionals (cfg.opencode.enable && isLinux) [ ocWakePackage ];

          file =
            lib.optionalAttrs cfg.cursor.enable (
              {
                "${lib.removePrefix "${home}/" cfg.cursor.configDir}/rules/memory.mdc".source = cursorContractRule;
                "${lib.removePrefix "${home}/" cfg.cursor.configDir}/rules/writing.mdc".source = cursorWritingRule;
              }
              // skillLinks "${cfg.cursor.configDir}/skills" assetsPackage "share/skills.cursor"
            )
            // lib.optionalAttrs cfg.opencode.enable (
              {
                # The memory contract at a stable path: OpenCode configs watch
                # it as an instruction file (the deployment's `instructions`
                # entry), and the content follows the package on deploy
                # without the path moving.
                ".local/services/memory/contract.md".source =
                  "${cfg.package}/lib/memory-store/instructions/memory.md";
                # The chancery's rules land beside it under their own root:
                # working rules, shipped by the repo, watched the same way.
                "${lib.removePrefix "${home}/" cfg.rulesDir}/writing.md".source =
                  "${cfg.package}/lib/memory-store/instructions/writing.md";
                # The director agent ships from the director package
                # (PRJ-453); the rest of the agents come from the writs tree
                # through the assets package below.
                "${lib.removePrefix "${home}/" cfg.opencode.agentsDir}/director.md".source =
                  "${directorPackage}/share/opencode/agents/director.md";
              }
              //
                fileLinks cfg.opencode.pluginDir ../memory/opencode-client pluginPackage "share/opencode/plugins"
                  [
                    "ts"
                    "js"
                  ]
              //
                fileLinks cfg.opencode.pluginDir ../writs/plan-reminder planReminderPackage "share/opencode/plugins"
                  [
                    "ts"
                    "js"
                  ]
              //
                fileLinks cfg.opencode.pluginDir ../writs/discovery-reminder discoveryReminderPackage
                  "share/opencode/plugins"
                  [
                    "ts"
                    "js"
                  ]
              // fileLinks cfg.opencode.agentsDir ../writs/agents assetsPackage "share/opencode/agents" null
              // fileLinks cfg.opencode.commandsDir ../writs/commands assetsPackage "share/opencode/commands" null
              // skillLinks cfg.opencode.skillsDir assetsPackage "share/skills.opencode"
            );

          activation.memoryStoreAgent = lib.hm.dag.entryAfter [ "onFilesChange" ] ''
            run mkdir -p ${lib.escapeShellArg cfg.stateDir}

            # Ahead of the rest of the block, none of which it depends on: an
            # activation that gives up partway should still leave launchd a
            # plist and a wrapper to start the daemon from.
            ${lib.optionalString isDarwin launchdInstall}

            run mkdir -p "$(dirname ${lib.escapeShellArg cfg.clientConfigPath})"
            run cp -f ${clientConfig} ${lib.escapeShellArg cfg.clientConfigPath}
            run chmod u+w ${lib.escapeShellArg cfg.clientConfigPath}

            label=${lib.escapeShellArg cfg.label}
            marker=${lib.escapeShellArg cfg.stateDir}/agent.sig
            sig=${lib.escapeShellArg signature}
            ${if isDarwin then launchdReload else systemdReload}
          '';

          # mcp.json and hooks.json are mutable and shared with everything
          # else the user installs, so they are merged key by key at
          # activation rather than declared as files. Anything writing them
          # has to hold the same discipline: touch your own keys, never
          # rewrite the file wholesale.
          #
          # /bin/memory-store-register-plugin stays in the owned suffixes so
          # that a machine still carrying the plugin registrar has it pruned
          # on the next activation; it registers a second copy of everything
          # here on every workspace open.
          activation.memoryStoreCursor = mkIf cfg.cursor.enable (
            lib.hm.dag.entryAfter [ "writeBoundary" ] ''
              run ${pkgs.python3}/bin/python3 ${./cursor-config.py} \
                --cursor-dir ${lib.escapeShellArg cfg.cursor.configDir} \
                --server-name ${lib.escapeShellArg cfg.cursor.serverName} \
                --server-url ${lib.escapeShellArg cursorServerUrl} \
                --hook-command ${lib.escapeShellArg cursorHookCommand} \
                --owned-suffix /bin/memory-store-register-plugin /clients/cursor/hook \
                --events ${lib.escapeShellArgs cfg.cursor.hookEvents} \
                --matcher ${
                  lib.escapeShellArgs (
                    lib.mapAttrsToList (event: matcher: "${event}=${matcher}") cfg.cursor.hookMatchers
                  )
                } \
                --daemon-event ${lib.escapeShellArgs cfg.cursor.daemonHookEvents} \
                || warnEcho "memory-store cursor wiring failed"
            ''
          );
        };
      }
    ]
  );
}
