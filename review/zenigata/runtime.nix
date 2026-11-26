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
  makeBinaryWrapper,
  writeText,
  opencodeServe,
  zenigata,
  nodejs_24,
  git,
  opencodeAssets,
}:

let
  # The runtime's neutral serve config: the product-owned slice of what the
  # serve runs with. Nothing private, nothing deployment-specific — the
  # model route, the serve's address and password, and the agent-definition
  # directories it scans are the deployment's layer.
  #
  # Schema facts verified against the v2.2.5 opencode source (PRJ-474
  # confirmed decode unchanged into 2.3.0; action names re-read at the
  # v2.3.0 tag for PRJ-496):
  #   - config-level `permissions` push onto every agent's ruleset, and the
  #     LAST matching rule wins (Wildcard match on action and resource). A
  #     file-defined agent's own frontmatter rules land after the floor
  #     and win; a built-in agent's land before, under it. The deny-all
  #     floor with the subagent carve-out after it therefore keeps the
  #     review passes delegating and denies every other action, while the
  #     reviewer's working grants (read, glob, grep, shell, webfetch,
  #     websearch, subagent) ride its own definition (PRJ-496) and no
  #     deployment re-allow is wanted; built-ins stay under the floor;
  #   - `deny` (never `ask`) is the headless posture: a serve session has
  #     nobody to answer an ask, and an ask parks the tool fiber (the
  #     PRJ-340 permission-park failure);
  #   - the bash tool's action name is `shell` in 2.3.0 (`bash` is only an
  #     input alias) and the delegation tool's is `subagent`;
  #   - `websearch.use` did not exist as a policy action until 2.3.0. The
  #     floor keeps the websearch tool denied for every agent without its
  #     own grant; the reviewer's own grants allow the tool itself, whose
  #     providers are account-keyless but call fixed external endpoints, so
  #     real use rides the deployment's keys and no local fake can carry
  #     it — the compat check's web-lookup proof runs through webfetch
  #     instead. One unguarded edge: the lock-refresh gate proves the other
  #     granted actions by behavior, but nothing in the driver exercises
  #     websearch, so a serve that renamed the action would ship this
  #     grant dead with nothing red.
  #   - `plugin.use` has no blanket denial in the floor (PRJ-535): the
  #     earliest-loaded policy wins the union, so a floor deny would make
  #     every deployment-layer allow ungrantable; without the row the
  #     decision defaults to allow and a plugin loads where the deployment
  #     grants it. The note that matters stays true: the serve's own
  #     internal config plugins are registered directly, outside the
  #     policy-gated load path, so the floor never needed the deny for
  #     its own machinery.
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
    # never make: the reviewer's grants allow its working tools, and these
    # deny the channels no tool grant reaches. The forge MCP is the
    # deliberate exception (review 665): the deployment passes it into the
    # serve, the reviewer session posts its own review through it, and the
    # deployment's own config carries that reviewer's forge-tool rows,
    # named for the MCP server that deployment runs. A deployment that
    # pins no rows gets a reviewer that cannot post — the correct default:
    # the shipped definition stays free of any one deployment's server
    # naming. Plugins are the same posture (PRJ-535): no blanket plugin.use
    # denial here, so plugins load only where a deployment grants them —
    # config-declared or scanned alike — and a deployment that grants no
    # plugin gets none.
    # Deliberately NOT `integration.use`: that action also
    # covers providers and models supplied from local config rather than
    # an account, so its deny takes out the deployment's own model route
    # (the runtime's own compat check caught exactly that).
    policies = [
      {
        action = "integration.connect";
        resource = "*";
        effect = "deny";
      }
    ];
    # The session shell the shell tool runs through (PRJ-539): the serve
    # inherits the service account's login shell as $SHELL — systemd
    # delivers it for User= units — and the v2.3.0 shell-select resolves the
    # session shell from process.env.SHELL alone, so a deployment whose
    # service account's shell is nologin (the deployed zenigata-runtime
    # account) dies at spawn, below PATH, on every shell call. The config's
    # shell key names the shell instead (config/plugin/shell.ts, the
    # v2.3.0 source, feeds Config.latest into the shell-select); the
    # deployment's own config shell key overrides it. /bin/sh is bash on
    # the NixOS hosts this runtime deploys to.
    shell = "/bin/sh";
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

  nativeBuildInputs = [ makeBinaryWrapper ];

  postBuild = ''
    mkdir -p $out/share/zenigata/opencode
    cp ${runtimeConfigJson} $out/share/zenigata/opencode/config.json

    # The review session loads the review-pr skill — and the humanizer its
    # flow runs beside it — from the skills tree the deployment wires into
    # the serve's config home (PRJ-539): the package ships that tree, the
    # opencode assets package's per-client composition, at
    # share/skills.opencode, and deployment.md names the wiring step.
    ln -s ${opencodeAssets}/share/skills.opencode $out/share/skills.opencode

    # The review session's shell PATH carries the runtime's own node and
    # git, appended after whatever PATH the deployment's unit sets (PRJ-539):
    # the review flow runs the tests and builds the change calls for, and
    # those are node and git programs a minimal unit PATH leaves dead. The
    # deployment can still add to the PATH the unit carries; the suffix only
    # guarantees these two. The spawn layer itself — which shell runs at
    # all — is the config's `shell` key above, not this suffix.
    localReal=$out/bin/.opencode-unwrapped
    mv $out/bin/opencode $localReal
    makeBinaryWrapper $localReal $out/bin/opencode \
      --suffix PATH : ${
        lib.makeBinPath [
          nodejs_24
          git
        ]
      }
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
