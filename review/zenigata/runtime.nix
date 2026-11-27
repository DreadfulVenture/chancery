# The complete zenigata review runtime as one package (PRJ-479, PRJ-548): the
# pinned opencode serve binary, the runtime's neutral serve config, the
# reviewer agent definition, and the skills tree — ordinary derivations
# composed into one the normal way (plain symlink composition, no wrapper
# machinery), with the stack launcher the flake's `.#zenigata` app runs.
#
# The config layout the serve reads holds exactly ONE config file, the
# neutral floor: the v2.3.0 serve reads both `opencode.json` and
# `opencode.jsonc` from every scanned config directory (config/discovery.ts
# `names`, loaded in that order, missing files skipped) and merges with the
# later document winning for settings (config.ts `latest` is findLast), so
# the deployment's own `opencode.jsonc` layers over the floor by native
# precedence when it sits beside it — the NixOS module's `overrideConfig`
# option composes that two-file directory; no env var carries a config
# path. Policy rows are the union with the earliest-loaded document's
# authority winning (the PRJ-535 fact), so the floor's policy rows keep
# their authority over any deployment file.
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
  writeShellScriptBin,
  writeText,
  runCommand,
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

  runtimeConfigJson = writeText "opencode.json" (builtins.toJSON runtimeConfig);

  # The serve's config home: one derivation, plain symlink composition.
  # Exactly one config file ships here — the floor as `opencode.json` —
  # beside the reviewer agent's definition under the id the driver selects
  # and the skills tree at the entry the serve's skill discovery scans
  # (`<config entry>/skills`, the v2.3.0 source's contract). A deployment
  # that ships its own config places it in this directory's shape as
  # `opencode.jsonc` — the module's `overrideConfig` option composes that
  # directory — and the serve's native two-file precedence layers it over
  # the floor.
  opencodeHome = runCommand "zenigata-opencode-home" { } ''
    mkdir -p $out/share/zenigata/opencode-home/agent
    ln -s ${runtimeConfigJson} $out/share/zenigata/opencode-home/opencode.json
    ln -s ${zenigata}/share/zenigata/agent/reviewer.md \
      $out/share/zenigata/opencode-home/agent/zenigata-reviewer.md
    ln -s ${opencodeAssets}/share/skills.opencode \
      $out/share/zenigata/opencode-home/skills
  '';

  # The stack launcher: the package's own bin a service's ExecStart runs
  # (and the flake's `.#zenigata` app). It composes the environment the
  # pair needs — the config home (the package's own layout unless the
  # deployment points it at its composed two-file directory), the serve
  # port and bot URL, one shared password (minted when unset, handed to
  # the serve as OPENCODE_PASSWORD and to the bot as its Basic-auth key),
  # and the PATH suffix that guarantees node and git after whatever PATH
  # the caller carries (PRJ-539: the review flow runs node and git
  # programs a minimal unit PATH leaves dead) — then starts the serve and
  # execs the bot in the foreground. The two processes share one unit (or
  # one terminal): systemd's cgroup kill — or the terminal's signal —
  # takes both down together, and Restart=on-failure restarts the pair.
  launcher = writeShellScriptBin "zenigata-stack" ''
    set -eu
    : "''${OPENCODE_CONFIG_DIR:-${opencodeHome}/share/zenigata/opencode-home}"
    export OPENCODE_CONFIG_DIR
    : "''${OPENCODE_SERVE_PORT:=8473}"
    : "''${ZENIGATA_OPENCODE_URL:=http://127.0.0.1:''${OPENCODE_SERVE_PORT}}"
    export OPENCODE_SERVE_PORT ZENIGATA_OPENCODE_URL
    if [ -z "''${ZENIGATA_OPENCODE_KEY:-}" ]; then
      ZENIGATA_OPENCODE_KEY="$(head -c 24 /dev/urandom | base64 | tr -d '\n')"
      export ZENIGATA_OPENCODE_KEY
    fi
    export OPENCODE_PASSWORD="''${ZENIGATA_OPENCODE_KEY}"
    export PATH="$PATH:${
      lib.makeBinPath [
        nodejs_24
        git
      ]
    }"
    ${opencodeServe}/bin/opencode serve --hostname 127.0.0.1 --port "$OPENCODE_SERVE_PORT" &
    exec ${zenigata}/bin/zenigata
  '';
in
symlinkJoin {
  pname = "zenigata-runtime";
  # The runtime's version is the serve's own version attribute: the
  # branch-tracking input moves it, and the compat check gates every move.
  inherit (opencodeServe) version;

  paths = [
    opencodeServe
    zenigata
    opencodeHome
    launcher
  ];

  # What a deployment's module consumes without reaching into the tree:
  # the serve derivation behind the package and the serve's version.
  passthru = {
    inherit opencodeServe;
    opencodeVersion = opencodeServe.version;
  };

  meta = {
    description = "The complete Zenigata review runtime: the pinned opencode serve, its neutral config, the reviewer agent, and the skills tree";
    platforms = lib.platforms.all;
  };
}
