# The complete zenigata review runtime as one package (PRJ-479): the pinned
# opencode serve binary, the runtime's neutral serve config, and the zenigata
# bot — whose session driver carries its @opencode/client pin. Infra consumes
# packages.<system>.zenigata-runtime and layers its own deployment wiring
# (listen address and password, the review route with the gateway's virtual
# key, the agent-definition directories the serve scans) on top.
#
# The compatibility contract is behavior, not version equality: the flake's
# zenigata-runtime-compat check runs the driver's integration tests against
# THIS package's serve — one prompt round-trip and the delegated-pass settle
# barrier — so an upgrade that breaks the driver lands red naming the break,
# and an upgrade that works lands green. Version equality is deliberately
# not asserted anywhere: @opencode/client upgrades flow freely through
# Renovate, and this check gates on what the driver actually does.
#
# Pin policy: the serve tracks nixpkgs-unstable, the branch the deployment's
# opencode has always come from — chancery's own nixpkgs input tracks a
# nixos release that does not carry this opencode line, and the lock's
# carried version is whatever the branch has now, readable from the
# packaged binary. The driver is background-aware: 2.3.x's
# always-background subagent tool is waited out through the job endpoint,
# whose absence fails named as the broken pairing. Upstream's own flake
# ships a stale node_modules hash at its 2.3.x tags, so the serve source
# is nixpkgs rather than upstream's flake; the schema facts below hold at
# the v2.2.5 and v2.3.x sources (PRJ-474: decode unchanged). The compat
# check is the gate: every lock refresh that moves
# the branch's opencode runs the driver against the new serve, and a
# semantic break lands red on the lock PR. Renovate bumps of
# @opencode/client are met by the same red check alone: a client bump that
# breaks the driver fails it naming the break, and the deliberate
# companion move happens in that PR's thread, visible and never silenced.
{
  lib,
  symlinkJoin,
  writeText,
  opencodeServe,
  zenigata,
}:

let
  # The runtime's neutral serve config: the product-owned slice of what the
  # serve runs with. Nothing private, nothing deployment-specific — the
  # model route, the serve's address and password, and the agent-definition
  # directories it scans are the deployment's layer.
  #
  # Schema facts verified against the v2.2.5 opencode source (PRJ-474
  # confirmed decode unchanged into 2.3.0):
  #   - config-level `permissions` push onto every agent's ruleset, and the
  #     LAST matching rule wins (Wildcard match on action and resource), so
  #     the deny-all floor with the subagent carve-out after it lets the
  #     review passes delegate and denies everything else;
  #   - `deny` (never `ask`) is the headless posture: a serve session has
  #     nobody to answer an ask, and an ask parks the tool fiber (the
  #     PRJ-340 permission-park failure);
  #   - the delegation tool's action name is `subagent` in 2.2.5;
  #   - `websearch.use` did not exist as a policy action until 2.3.0, so
  #     the websearch tool is denied by the permissions floor instead.
  #   - `plugin.use` deny is safe for the serve's own machinery: internal
  #     config plugins are registered directly, outside the policy-gated
  #     load path.
  runtimeConfig = {
    "$schema" = "https://opencode.ai/config.json";
    # A Nix-packaged binary must not self-update; a review session carries
    # private repository source, so sharing is off — an adopter opts in.
    update = "disable";
    share = "disabled";
    permissions = [
      {
        action = "*";
        resource = "*";
        effect = "deny";
      }
      {
        action = "subagent";
        resource = "*";
        effect = "allow";
      }
    ];
    # Platform-level refusals for the connections the review runtime must
    # never make: the reviewer's grants already deny the tools, and these
    # deny the channels (integrations, MCP servers, plugins) a tool grant
    # cannot reach. Deliberately NOT `integration.use`: that action also
    # covers providers and models supplied from local config rather than
    # an account, so its deny takes out the deployment's own model route
    # (the runtime's own compat check caught exactly that).
    policies = [
      {
        action = "integration.connect";
        resource = "*";
        effect = "deny";
      }
      {
        action = "mcp.use";
        resource = "*";
        effect = "deny";
      }
      {
        action = "plugin.use";
        resource = "*";
        effect = "deny";
      }
    ];
  };

  runtimeConfigJson = writeText "zenigata-opencode-config.json" (builtins.toJSON runtimeConfig);
in
symlinkJoin {
  pname = "zenigata-runtime";
  # The runtime's version is the serve's own version attribute: the
  # branch-tracking input moves it, and the compat check gates every move.
  inherit (opencodeServe) version;

  paths = [
    opencodeServe
    zenigata
  ];

  postBuild = ''
    mkdir -p $out/share/zenigata/opencode
    cp ${runtimeConfigJson} $out/share/zenigata/opencode/config.json
  '';

  # What a deployment's module consumes without reaching into the tree:
  # the serve derivation behind the package, the serve's version, and the
  # in-package path of the neutral config it may install or compose over.
  passthru = {
    inherit opencodeServe;
    opencodeVersion = opencodeServe.version;
    opencodeConfigPath = "share/zenigata/opencode/config.json";
  };

  meta = {
    description = "The complete Zenigata review runtime: the pinned opencode serve, its neutral config, and the bot";
    platforms = lib.platforms.all;
  };
}
