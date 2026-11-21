# The director's home-manager module: the coordination plugin as its own
# product surface, installed independently of the memory stack. The plugin
# folder is the whole install: the module links the built package into
# OpenCode's scanned plugins directory, where it is a watched config root,
# and carries the deny-by-default floor for the director tooling as data
# for the deployment that renders the opencode config.
#
# The module shares nothing with the memory-store module by construction:
# the plugin doesn't use the daemon, the capture, or the contract file, so
# a host can import one without the other. The one value both modules own
# a copy of is the plugins directory default, OpenCode's one scanned
# location, so a deployment overriding either module's scan dir must
# override both.
{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.director;
  home = config.home.homeDirectory;

  inherit (lib)
    mkIf
    mkOption
    mkEnableOption
    types
    ;

  # The plugin folder itself; the artifact shape is the director package's
  # own contract (package.nix beside this module).
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.director;
in
{
  options.services.director = {
    enable = mkEnableOption "the director coordination plugin for OpenCode";

    package = mkOption {
      type = types.package;
      default = package;
      defaultText = "self.packages.<system>.director";
      description = "The director plugin folder to link.";
    };

    pluginDir = mkOption {
      type = types.str;
      default = "${home}/.config/opencode/plugins";
      description = ''
        Directory OpenCode scans for plugins, the same location the
        memory-store module's `opencode.pluginDir` defaults to. OpenCode
        discovers package directories there, so the director loads in
        every session. The directory is a watched config root, so a
        rebuild is picked up the way the other scanned plugins are.
        Overriding this needs the memory-store module's `opencode.pluginDir`
        overridden to match, and the other way around.
      '';
    };

    # The deny-by-default floor for the director tooling, as data for the
    # deployment that owns the opencode config. Rules are the permission
    # ruleset's shape - { action, resource, effect }, last match wins, both
    # sides wildcard-matched - and a tool-level deny names the tool as the
    # action with "*" as the resource, which is how the map shape in an
    # agent or config file migrates too. The floor denies the six mutating
    # director tools and the question tool to every agent; the director
    # agent's own definition re-allows the six its job needs. The allow
    # does not win by composition order: a plugin-registered agent's own
    # rules land before the config-level rules. It wins because the
    # plugin registers a late agent transform from the session.prompt
    # hook, whose appends replay after the config plugin's appends on
    # every agent rebuild, so the definition's allows are the last
    # matching rules. The list and that re-allow live in this repo and
    # move in lockstep: a rule here without its counterpart allow in
    # agent/director.md strips a tool from the director agent, so both
    # halves of a pair ride the same change. (The host evaluates
    # last-match-wins: the host's Permission.evaluate takes the last
    # rule matching the action and resource, in the opencode tree.)
    permissionRules = mkOption {
      type = types.listOf (
        types.submodule {
          options = {
            action = mkOption {
              type = types.str;
              description = "The action glob the rule matches; a tool name for tool-level rules.";
            };
            resource = mkOption {
              type = types.str;
              description = "The resource glob the rule matches; \"*\" for a whole-tool rule.";
            };
            effect = mkOption {
              type = types.enum [
                "allow"
                "deny"
                "ask"
              ];
              description = "What happens when the rule matches.";
            };
          };
        }
      );
      default = [
        {
          action = "director_dispatch";
          resource = "*";
          effect = "deny";
        }
        {
          action = "director_steer";
          resource = "*";
          effect = "deny";
        }
        {
          action = "manifest_write";
          resource = "*";
          effect = "deny";
        }
        {
          action = "manifest_drop";
          resource = "*";
          effect = "deny";
        }
        {
          action = "worktree_add";
          resource = "*";
          effect = "deny";
        }
        {
          action = "worktree_remove";
          resource = "*";
          effect = "deny";
        }
        {
          action = "question";
          resource = "*";
          effect = "deny";
        }
      ];
      description = ''
        Permission rules the deployment's opencode config is built from -
        the deny-by-default floor for the director tooling. Rendering them
        into the config's permission ruleset belongs to the deployment
        that owns that config; nothing here writes it.
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = lib.hasPrefix "${home}/" cfg.pluginDir;
        message = "services.director.pluginDir must be inside ${home}.";
      }
      {
        # Both modules link into OpenCode's one scanned plugins
        # directory, and they own the default twice. A one-sided
        # override puts the director into a directory the memory
        # module's links don't share, and the plugin doesn't load with
        # nothing saying why; when the memory module is in the
        # evaluation, a mismatch fails the build named instead.
        assertion =
          (config.services.memory-store.opencode.pluginDir or null) == null
          || cfg.pluginDir == config.services.memory-store.opencode.pluginDir;
        message = "services.director.pluginDir and services.memory-store.opencode.pluginDir must match; both modules link into OpenCode's one scanned plugins directory.";
      }
    ];

    # The folder is the install. The module links it whole into the
    # scanned plugins directory, and the plugin registers its agent,
    # skills, and commands at load, so the deployment doesn't link
    # anything per file. Settings ride an object-form `plugins` entry
    # naming this exact path, spelled as it sits on disk; the package
    # README beside this module carries the rule and why.
    home.file."${lib.removePrefix "${home}/" cfg.pluginDir}/director".source = cfg.package;
  };
}
