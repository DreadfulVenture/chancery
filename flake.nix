{
  description = "Local-first cross-session memory for coding agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };
    git-hooks-nix = {
      url = "github:cachix/git-hooks.nix/204b6977e00caac19e2313015a598543ca7be150";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-compat.follows = "";
    };
    # The zenigata runtime's opencode serve source, tracking nixpkgs-
    # unstable — where the runtime's opencode line lives. Chancery's own
    # nixpkgs input tracks a nixos release that does not carry this
    # opencode line, and the deployment's serve has always come from
    # unstable. The locked rev lives in flake.lock, so lock maintenance
    # refreshes it like every other input, and the flake's
    # zenigata-runtime-compat check gates every refresh: the runtime
    # tracks the branch's opencode, and a semantic break against the
    # driver lands red on the lock PR.
    opencode-nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    # Only the checks build anything from this; the module itself takes
    # home-manager's option set from whoever imports it.
    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    inputs@{ self, flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [ inputs.git-hooks-nix.flakeModule ];

      flake = {
        # The deployment belongs to the thing being deployed: the launchd agent,
        # the Cursor hook events, and the MCP entry are all memory-store's own
        # contract, so a consumer imports this and sets options rather than
        # reimplementing the wiring against this repo's layout.
        homeManagerModules.default = import ./nix/hm-module.nix { inherit self; };

        # The director is its own product with its own module. The plugin
        # doesn't use the daemon, so a host imports it independently, and
        # the two deployments stay decoupled.
        homeManagerModules.director = import ./coordinate/director/module.nix { inherit self; };

        # The Zenigata review bot's NixOS module, its forge adapter, and
        # the watcher daemon (PRJ-540): the standalone watcher that holds
        # the forge and source tokens and serves the credential-free
        # local route the session-side tools proxy to.
        nixosModules = {
          zenigata = import ./nix/zenigata-module.nix;
          forgejo-adapter = import ./nix/forgejo-adapter-module.nix;
          watcher-daemon = import ./nix/watcher-daemon-module.nix;
        };

        # The config contribution other repos overlay onto their own OpenCode
        # configuration: plan-mode permissions and the watched instruction files
        # (the contract materialized by the hm-module, the floor rendered by the
        # daemon). Eval fails here if a rule is malformed — at the source, not a
        # consumer's host build.
        opencodeConfig =
          let
            planPermissions = [
              {
                action = "edit";
                effect = "allow";
                resource = "docs/adr/*";
              }
              {
                action = "edit";
                effect = "allow";
                resource = "docs/prd/*";
              }
              {
                # Plan files live per worktree in .opencode/plan/ (gitignored
                # unless stated otherwise).
                action = "edit";
                effect = "allow";
                resource = ".opencode/plan/*";
              }
              {
                action = "subagent";
                effect = "deny";
                resource = "implementer";
              }
            ];
            malformed = builtins.filter (
              rule:
              !(rule ? action && rule ? effect && rule ? resource)
              || !builtins.elem rule.effect [
                "allow"
                "deny"
              ]
            ) planPermissions;
          in
          if malformed != [ ] then
            throw "opencodeConfig: malformed plan permission rules: ${builtins.toJSON malformed}"
          else
            {
              agents.plan.permissions = planPermissions;
              instructions = [
                "~/.local/services/memory/contract.md"
                "~/.local/services/chancery/rules/writing.md"
                "~/.local/services/chancery/rules/code.md"
                "~/.local/services/chancery/rules/comments.md"
                "~/.local/services/chancery/rules/communication.md"
                "~/.local/services/chancery/rules/review.md"
                "~/.local/services/memory/data/memory-floor.md"
              ];
            };
      };

      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];

      perSystem =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          pch = pkgs.python3Packages.pre-commit-hooks;

          yamllintDefaultConfig = pkgs.writeText "yamllint-default-config" ''
            rules:
              document-start: disable
          '';

          yamllintWrapper = pkgs.writeShellApplication {
            name = "yamllint-wrapper";
            text = ''
              if [ -z "''${YAMLLINT_CONFIG_FILE:-}" ]; then
                export YAMLLINT_CONFIG_FILE="${yamllintDefaultConfig}"
              fi
              exec ${pkgs.yamllint}/bin/yamllint "$@"
            '';
          };

          forbidBinaryScript = pkgs.writeShellApplication {
            name = "forbid-binary";
            text = ''
              status=0
              for file in "$@"; do
                echo "Binary file detected: $file" >&2
                status=1
              done
              exit "$status"
            '';
          };

          scriptMustHaveExtensionScript = pkgs.writeShellApplication {
            name = "script-must-have-extension";
            text = ''
              status=0
              for file in "$@"; do
                if [[ "$file" != *.sh ]]; then
                  echo "Non-executable shell script must have .sh extension: $file" >&2
                  status=1
                fi
              done
              exit "$status"
            '';
          };

          scriptMustNotHaveExtensionScript = pkgs.writeShellApplication {
            name = "script-must-not-have-extension";
            text = ''
              status=0
              for file in "$@"; do
                if [[ "$file" == *.sh ]]; then
                  echo "Executable shell script should not have .sh extension: $file" >&2
                  status=1
                fi
              done
              exit "$status"
            '';
          };

          rev = if self ? rev then "rev:${self.rev}" else "dirty:${self.dirtyShortRev or "unknown"}";
        in
        {
          pre-commit.check.enable = false;
          pre-commit.settings.hooks = {
            nixfmt.enable = true;
            prettier = {
              enable = true;
              excludes = [
                "\\.lock"
                # persona.md ships byte-exact from the ticket; prettier's
                # proseWrap would reflow it.
                "review/zenigata/persona.md"
              ];
            };
            end-of-file-fixer = {
              enable = true;
              entry = "${pch}/bin/end-of-file-fixer";
              types = [ "text" ];
            };
            trim-trailing-whitespace = {
              enable = true;
              entry = "${pch}/bin/trailing-whitespace-fixer";
              types = [ "text" ];
            };
            mixed-line-ending = {
              enable = true;
              entry = "${pch}/bin/mixed-line-ending";
              types = [ "text" ];
            };
            fix-byte-order-marker = {
              enable = true;
              entry = "${pch}/bin/fix-byte-order-marker";
              types = [ "text" ];
            };
            ruff-format = {
              enable = true;
              # The ruff config lives in memory/store/pyproject.toml (the
              # app's project root); the hook's args carry the line length so
              # the one python file outside that tree (nix/cursor-config.py)
              # keeps the same width instead of the 88-char default.
              args = [
                "--line-length"
                "100"
              ];
            };

            nil.enable = true;
            statix = {
              enable = true;
              settings.ignore = [ ".direnv" ];
            };
            shellcheck = {
              enable = true;
              excludes = [ "\\.envrc" ];
            };
            check-json.enable = true;
            check-toml.enable = true;
            check-yaml.enable = true;
            yamllint = {
              enable = true;
              entry = lib.mkForce "${yamllintWrapper}/bin/yamllint-wrapper";
              excludes = [ "\\.lock" ];
            };
            check-merge-conflict = {
              enable = true;
              entry = "${pch}/bin/check-merge-conflict";
              types = [ "text" ];
            };
            check-symlinks.enable = true;
            check-case-conflicts.enable = true;
            check-executables-have-shebangs.enable = true;
            check-shebang-scripts-are-executable = {
              enable = true;
              excludes = [ "\\.envrc" ];
            };
            ruff = {
              enable = true;
              # Same width as ruff-format's args, for the same reason.
              args = [
                "--line-length"
                "100"
              ];
            };

            forbid-binary = {
              enable = true;
              entry = "${forbidBinaryScript}/bin/forbid-binary";
              types = [ "binary" ];
              # The house marks live in assets/: logos are images on purpose.
              excludes = [ "^assets/" ];
              language = "system";
            };
            script-must-have-extension = {
              enable = true;
              entry = "${scriptMustHaveExtensionScript}/bin/script-must-have-extension";
              types = [ "shell" ];
              exclude_types = [ "executable" ];
              excludes = [ "\\.envrc" ];
              language = "system";
            };
            script-must-not-have-extension = {
              enable = true;
              entry = "${scriptMustNotHaveExtensionScript}/bin/script-must-not-have-extension";
              types = [
                "shell"
                "executable"
              ];
              language = "system";
            };
          };

          packages = {
            default = pkgs.callPackage ./memory/store/package.nix { inherit rev; };
            memory-store = pkgs.callPackage ./memory/store/package.nix { inherit rev; };
            memory-hub = pkgs.callPackage ./memory/store/hub.nix { inherit rev; };
            memory-store-plugin = pkgs.callPackage ./memory/opencode-client/package.nix { };
            memory-store-opencode = pkgs.callPackage ./nix/opencode-assets.nix { };
            zenigata = pkgs.callPackage ./review/zenigata/package.nix { };
            zenigata-runtime = pkgs.callPackage ./review/zenigata/runtime.nix {
              # callPackage'd again rather than read from config.packages:
              # referencing an attribute of the set being defined loops
              # the evaluation (the same trap the hm-module check's
              # comment records).
              zenigata = pkgs.callPackage ./review/zenigata/package.nix { };
              opencodeServe = inputs.opencode-nixpkgs.legacyPackages.${pkgs.system}.opencode;
              opencodeAssets = pkgs.callPackage ./nix/opencode-assets.nix { };
            };
            forgejo-adapter = pkgs.callPackage ./review/forgejo-adapter/package.nix { };
            mail-watcher = pkgs.callPackage ./watch/mail-watcher/package.nix { };
            director = pkgs.callPackage ./coordinate/director/package.nix { };
            plan-reminder = pkgs.callPackage ./writs/plan-reminder/package.nix { };
            discovery-reminder = pkgs.callPackage ./writs/discovery-reminder/package.nix { };
            oc-wake = pkgs.callPackage ./wake/oc-wake/package.nix { };
            agenix-secrets-helper = pkgs.callPackage ./tool/agenix-secrets/package.nix { };
          };

          checks = {
            # The compatibility contract (PRJ-479): the driver's integration
            # tests run against THIS package's serve, and the harness lives
            # in review/zenigata/test/runtime-compat-run.ts — the same
            # runner the Makefile's test-runtime-compat target invokes, so
            # the check runs with or without nix. An upgrade that breaks the
            # driver lands red naming the break, and one that works lands
            # green: this is the gate on the runtime's branch-tracking serve
            # input, so a lock refresh carrying a semantic break fails here.
            zenigata-runtime-compat =
              pkgs.runCommand "zenigata-runtime-compat-check"
                {
                  nativeBuildInputs = [
                    pkgs.nodejs_24
                    pkgs.git
                  ];
                  runtimePackage = config.packages.zenigata-runtime;
                  runner = ./review/zenigata/test/runtime-compat-run.ts;
                  testDir = ./review/zenigata/test;
                }
                ''
                  node "$runner" --runtime "$runtimePackage" --test-dir "$testDir"
                  touch "$out"
                '';

            # The runtime package's serve must report the version its
            # derivation declares: this runs the packaged binary, so a
            # serve that lies about its version fails here instead of on a
            # deployed host. The version itself is the branch-tracking
            # input's opencode — the compat check above gates its
            # semantics on every lock refresh.
            zenigata-runtime-version = pkgs.runCommand "zenigata-runtime-version-check" { } ''
              # opencode writes its state dirs under HOME; the build sandbox
              # has none, so the check points it at the build's own temp dir.
              actual="$(HOME="$TMPDIR" ${config.packages.zenigata-runtime}/bin/opencode --version)"
              case "$actual" in
                *"v${config.packages.zenigata-runtime.opencodeServe.version}") touch "$out" ;;
                *)
                  echo "the runtime package's serve reports '$actual', not v${config.packages.zenigata-runtime.opencodeServe.version}" >&2
                  exit 1
                  ;;
              esac
            '';

            # The rendered-config gate (PRJ-505): the NixOS module renders a
            # test deployment carrying the humans list — neutral names —
            # and the runtime's own
            # bin validates the rendered environment: `zenigata
            # --check-config` composes the unit environment with the unit's
            # own environment file, parsing that file's plain KEY=VALUE
            # form only — a subset of the EnvironmentFile reader systemd
            # runs at boot, and the form the test file carries — and runs
            # the composition through loadConfig, the same schema every
            # boot pays. The lineage declaration rides along, and this
            # check is the only enforcement `app=zenigata` has: the
            # module's own assertion pins the initiator=agent infix alone,
            # and this check's eval never evaluates the module's
            # assertions. The deployed deployment's real values are its
            # own tree's business.
            zenigata-rendered-config =
              let
                # One source for both sides of the check: the test
                # deployment's options and the expectation file the bin
                # compares the rendered list against.
                identity = {
                  humans = [ "example-user" ];
                };
                eval = inputs.nixpkgs.lib.nixosSystem {
                  inherit (pkgs) system;
                  modules = [
                    self.nixosModules.zenigata
                    {
                      services.zenigata = {
                        enable = true;
                        allowedLogins = [ "example-user" ];
                        inherit (identity) humans;
                        adapterUrl = "http://adapter.invalid";
                        forgeUrl = "https://forge.example.com";
                        opencodeUrl = "http://opencode.invalid";
                        memoryUrl = "http://127.0.0.1:28132/mcp?app=zenigata&initiator=agent";
                        secretsFile = pkgs.writeText "zenigata-rendered-config-secrets" ''
                          ZENIGATA_EVENT_TOKEN=event-secret
                          ZENIGATA_ADAPTER_TOKEN=adapter-secret
                        '';
                      };
                    }
                  ];
                };
              in
              pkgs.runCommand "zenigata-rendered-config-check"
                {
                  renderedEnvironment = pkgs.writeText "zenigata-rendered-environment.json" (
                    builtins.toJSON eval.config.systemd.services.zenigata.environment
                  );
                  # The unit's own environment file: the bin composes it
                  # over the unit environment the way the boot's
                  # EnvironmentFile does.
                  environmentFile = eval.config.services.zenigata.secretsFile;
                  identityWant = pkgs.writeText "zenigata-rendered-config-want.json" (builtins.toJSON identity);
                }
                ''
                  ${config.packages.zenigata}/bin/zenigata --check-config \
                    "$renderedEnvironment" "$environmentFile" "$identityWant"
                  touch "$out"
                '';

            # The status page's notification script (PRJ-502), evaluated
            # from the BUILT package: the vitest sandbox runs the script
            # as the dev transform emits it, but production serves tsc's
            # output — the page embeds dist/status-notify.js's own
            # composition — and no dev-side check executes those bytes. A
            # target change or a downleveled helper would pass the suite
            # and ship a script that dies in the browser; this check runs
            # the built composition through the same browser-globals
            # harness and pins the failure-then-retry behavior on it.
            zenigata-notify-script =
              pkgs.runCommand "zenigata-notify-script-check"
                {
                  nativeBuildInputs = [ pkgs.nodejs_24 ];
                }
                ''
                  node --input-type=module -e "
                    const { clientScript, SEEN_KEY } = await import('${config.packages.zenigata}/dist/status-notify.js');
                    const constructed = [];
                    class Notification {
                      constructor(title, options) {
                        constructed.push({ title, options });
                      }
                      static permission = 'granted';
                      static requestPermission() {
                        return Promise.resolve('granted');
                      }
                    }
                    const store = new Map();
                    // The storage holds a last check for the boot poll
                    // to diff against: an empty storage would make the
                    // boot poll a cold open that speaks the window
                    // whole, and the phases below would say more than
                    // their assertions count.
                    store.set(
                      SEEN_KEY,
                      JSON.stringify(['acme/widget#9@2026-11-01T00:00:00.000Z@posted']),
                    );
                    const control = { textContent: undefined, remove() {}, appendChild() {} };
                    const document = {
                      getElementById: () => control,
                      createElement: () => ({ textContent: undefined, addEventListener() {} }),
                    };
                    const localStorage = {
                      getItem: (key) => store.get(key) ?? null,
                      setItem: (key, value) => store.set(key, value),
                    };
                    let served;
                    const fetch = () =>
                      Promise.resolve({ ok: true, json: () => Promise.resolve({ runs: served }) });
                    let interval;
                    const setInterval = (fn) => {
                      interval = fn;
                      return 1;
                    };
                    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
                    const boot = new Function(
                      'document', 'localStorage', 'Notification', 'fetch', 'setInterval',
                      clientScript(),
                    );
                    const run = {
                      ts: '2026-11-25T12:00:00.000Z',
                      repo: 'acme/widget',
                      pr: 2,
                      outcome: 'failed',
                      verdict: null,
                      failure: { stage: 'blind', message: 'the draft never parsed' },
                    };
                    served = [run];
                    boot(document, localStorage, Notification, fetch, setInterval);
                    await settle();
                    if (constructed.length !== 1) {
                      throw new Error('the built script did not raise the failed run exactly once');
                    }
                    if (constructed[0].options.tag !== 'acme/widget#2@2026-11-25T12:00:00.000Z@failed') {
                      throw new Error('the built script carried the wrong notification tag');
                    }
                    await interval();
                    await settle();
                    if (constructed.length !== 1) {
                      throw new Error('the built script re-notified the same state');
                    }
                    served = [{ ...run, outcome: 'posted', verdict: 'APPROVE' }];
                    await interval();
                    await settle();
                    if (constructed.length !== 2 || constructed[1].options.tag !== 'acme/widget#2@2026-11-25T12:00:00.000Z@posted') {
                      throw new Error('the built script missed the re-settled outcome');
                    }
                    console.log('the built notification script raised the failure, stayed quiet, and spoke the retry');
                  " && touch "$out"
                '';

            # The hub's bundled interpreter must import the bundled
            # memory_store.store — that is the runtime contract the package
            # exists to satisfy (see hub.nix). Checking it keeps a forgotten
            # python dependency a build failure instead of a restart loop on a
            # deployed hub.
            memory-hub-closure = pkgs.runCommand "memory-hub-closure-check" { } ''
              ${self.packages.${pkgs.system}.memory-hub.passthru.python}/bin/python \
                -c "import sys; sys.path.insert(0, '${
                  self.packages.${pkgs.system}.memory-hub
                }/lib/memory-store'); import memory_store.store" \
                && touch "$out"
            '';

            # The watcher's entry imports the director package's module across
            # the deployed layout (the mail-envelope boundary, see the
            # mail-watcher package); loading the packaged entry keeps a layout
            # slip a build failure instead of a plugin OpenCode silently
            # skips.
            mail-watcher-loads = pkgs.runCommand "mail-watcher-loads-check" { } ''
              ${pkgs.nodejs_24}/bin/node --input-type=module -e "
                const plugin = (await import('${config.packages.mail-watcher}/lib/mail-watcher/index.ts')).default;
                if (plugin?.id !== 'forgejo-watcher' || typeof plugin.setup !== 'function') {
                  console.error('the packaged mail-watcher entry loaded, but exports no plugin with id forgejo-watcher and a setup function');
                  process.exit(1);
                }
                // The plugin side holds no kernel and no credential; the
                // daemon's composition must load beside it in the packaged
                // layout, and the route server's module with it.
                await import('${config.packages.mail-watcher}/lib/mail-watcher/daemon/composition.ts');
                await import('${config.packages.mail-watcher}/lib/mail-watcher/daemon/route.ts');
              " && touch "$out"
            '';

            # The watcher daemon's settings boundary (PRJ-540, zenigata
            # review 700): the rendered config file is a store path,
            # world-readable by construction, so the module must refuse a
            # token anywhere in settings — the sources read the
            # environment first and the block wins per key, and a token
            # pasted here would silently override the secrets file. The
            # check (nix/watcher-daemon-token-refusal.nix) runs one eval
            # per source placement — the forge's top-level forgeToken and
            # a token inside each of the four source blocks — plus a
            # clean control: each refusal must fire and name that
            # source's secret, and the control must pass clean.
            watcher-daemon-token-refusal-check = pkgs.runCommand "watcher-daemon-token-refusal-check" { } ''
              # The eval-only nix invocation redirects its state dirs to
              # the build's tmp: the sandbox grants no /nix/var writes.
              export NIX_STATE_DIR="$TMPDIR/state"
              export NIX_CONF_DIR="$TMPDIR/conf"
              export HOME="$TMPDIR/home"
              ${pkgs.nix}/bin/nix-instantiate --eval --strict \
                --arg modulePath ${./nix/watcher-daemon-module.nix} \
                --arg nixpkgsPath ${pkgs.path} \
                ${./nix/watcher-daemon-token-refusal.nix} && touch "$out"
            '';

            # The director's own surface load: the packaged entry must be a
            # plugin OpenCode can activate (id, setup), and the packaged
            # agent definition and skills must parse with the module's own
            # strict parser — a layout slip or a malformed file is a build
            # failure instead of a plugin the host silently skips.
            director-loads = pkgs.runCommand "director-loads-check" { } ''
              ${pkgs.nodejs_24}/bin/node --input-type=module -e "
                import { readFileSync } from 'node:fs';
                const root = '${config.packages.director}';
                const plugin = (await import(root + '/index.ts')).default;
                if (plugin?.id !== 'director' || typeof plugin.setup !== 'function') {
                  console.error('the packaged director entry loaded, but exports no plugin with id director and a setup function');
                  process.exit(1);
                }
                const { loadAgentDefinition, loadSkillDefinition, loadCommandDefinition } = await import(root + '/index.ts');
                const agent = loadAgentDefinition(readFileSync(root + '/agent/director.md', 'utf8'));
                if (agent.mode !== 'primary' || agent.permissions.length === 0 || agent.system.length === 0) {
                  console.error('the packaged agent definition parsed, but carries no mode, permissions, or system prompt');
                  process.exit(1);
                }
                for (const id of ['orchestrate', 'dispatch-worker', 'steer-worker']) {
                  const skill = loadSkillDefinition(readFileSync(root + '/skills/' + id + '/SKILL.md', 'utf8'));
                  if (skill.name !== id || skill.body.length === 0) {
                    console.error('the packaged ' + id + ' skill parsed, but carries no body or a mismatched name');
                    process.exit(1);
                  }
                }
                for (const file of ['drive-project.md', 'status-report.md']) {
                  const command = loadCommandDefinition(file, readFileSync(root + '/commands/' + file, 'utf8'));
                  if (command.name !== file.slice(0, -3) || command.template.length === 0) {
                    console.error('the packaged ' + file + ' parsed, but carries no template or a mismatched name');
                    process.exit(1);
                  }
                }
              " && touch "$out"
            '';

            # The watcher loads from its configured plugins entry; a copy in the
            # scanned plugins dir would load it a second time: two pollers over
            # the same stamped watches. director.ts names the watcher
            # in prose, so this matches file names and the plugin's id only.
            memory-store-plugin-omits-watcher = pkgs.runCommand "memory-store-plugin-omits-watcher-check" { } ''
              plugins=${config.packages.memory-store-plugin}
              if find "$plugins" -iname '*forgejo-watcher*' | grep -q .; then
                echo "memory-store-plugin ships a forgejo-watcher file" >&2
                exit 1
              fi
              if grep -rqE "id:[[:space:]]*['\"]forgejo-watcher['\"]" "$plugins"; then
                echo "memory-store-plugin ships the forgejo-watcher plugin" >&2
                exit 1
              fi
              touch "$out"
            '';

            # Same ownership line for the wake CLI (PRJ-383 review 189): the
            # bin ships as its own oc-wake package, and the memory plugin's
            # package carries no copy of it.
            memory-store-plugin-omits-oc-wake = pkgs.runCommand "memory-store-plugin-omits-oc-wake-check" { } ''
              plugins=${config.packages.memory-store-plugin}
              if find "$plugins" -iname '*oc-wake*' | grep -q .; then
                echo "memory-store-plugin ships an oc-wake file" >&2
                exit 1
              fi
              touch "$out"
            '';

            # The agenix-secrets helper's suite, defined with the package it
            # tests (see tool/agenix-secrets/package.nix): real
            # encrypt/decrypt cycles in the nix sandbox, never in the dev
            # shell or a published runtime.
            agenix-secrets = config.packages.agenix-secrets-helper.suite;

            # The module carries two service backends and only one of them has a
            # person running it daily. `nix flake check` covers the current
            # system alone unless asked for --all-systems, so this guards the
            # systemd half on Linux CI and the launchd half whenever it is run
            # from a mac; neither platform covers the other.
            hm-module =
              (inputs.home-manager.lib.homeManagerConfiguration {
                inherit pkgs;
                # Imported straight from the file rather than through
                # self.homeManagerModules, and given the package explicitly:
                # reaching into self from perSystem forces the flake outputs
                # that perSystem is still producing, and the evaluation loops.
                modules = [
                  (import ./nix/hm-module.nix { inherit self; })
                  # The director module rides the same evaluation (enabled),
                  # so the pair-import path gets covered and the memory
                  # module's migration warning stays out of the log.
                  (import ./coordinate/director/module.nix { inherit self; })
                  {
                    home = {
                      username = "ci";
                      homeDirectory = if pkgs.stdenv.hostPlatform.isDarwin then "/Users/ci" else "/home/ci";
                      stateVersion = "25.05";
                      # Nobody activates this generation, so the usual nudge to
                      # match stateVersion to the nixpkgs release is just noise.
                      enableNixpkgsReleaseCheck = false;
                    };
                    services.memory-store = {
                      enable = true;
                      package = config.packages.memory-store;
                      cursor.enable = true;
                      opencode.enable = true;
                    };
                    services.director = {
                      enable = true;
                      package = config.packages.director;
                    };
                  }
                ];
              }).activationPackage;

            # The director module's own eval check: nothing else exercises
            # its wiring, so this generation fails here when the link or
            # the floor's default drifts from what the tests assume.
            director-module =
              (inputs.home-manager.lib.homeManagerConfiguration {
                inherit pkgs;
                modules = [
                  (import ./coordinate/director/module.nix { inherit self; })
                  {
                    home = {
                      username = "ci";
                      homeDirectory = "/home/ci";
                      stateVersion = "25.05";
                      enableNixpkgsReleaseCheck = false;
                    };
                    services.director = {
                      enable = true;
                      package = config.packages.director;
                    };
                  }
                  (
                    { config, lib, ... }:
                    let
                      link = config.home.file.".config/opencode/plugins/director" or null;
                      floor = config.services.director.permissionRules;
                      problems =
                        (lib.optional (link == null) "the director module wrote no plugins-dir link")
                        ++ (lib.optional (
                          (lib.length floor) != 7
                        ) "the director module's permissionRules default is not the seven-rule floor");
                    in
                    {
                      home.file."director-module-eval-check".text =
                        if problems == [ ] then
                          "The director module's defaults are intact."
                        else
                          builtins.throw (lib.concatStringsSep "; " problems);
                    }
                  )
                ];
              }).activationPackage;
          };

          devShells.default = pkgs.mkShell {
            inputsFrom = [ config.pre-commit.devShell ];
            packages = [
              pkgs.nodejs_24
              pkgs.python312
              pkgs.uv
              pkgs.jq
            ];
            # The uv-managed interpreter is an upstream standalone build, not
            # nix-patched, and wheels like numpy/onnxruntime need libz and
            # libstdc++ from the loader path, which NixOS does not provide.
            LD_LIBRARY_PATH = lib.makeLibraryPath [
              pkgs.zlib
              pkgs.stdenv.cc.cc.lib
            ];
            shellHook = ''
              # The devshell may be entered from a subdirectory (nix develop
              # -c keeps the invocation CWD), so the project path resolves
              # off the checkout's own root, not $PWD.
              uvRoot="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
              uv sync --frozen --project "$uvRoot/memory/store"
            '';
          };
        };
    };
}
