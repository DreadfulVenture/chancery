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

        # The Zenigata review bot's NixOS module.
        nixosModules.zenigata = import ./nix/zenigata-module.nix;

        # The Forgejo adapter for Zenigata.
        nixosModules.forgejo-adapter = import ./nix/forgejo-adapter-module.nix;

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
            forgejo-adapter = pkgs.callPackage ./review/forgejo-adapter/package.nix { };
            mail-watcher = pkgs.callPackage ./watch/mail-watcher/package.nix { };
            director = pkgs.callPackage ./coordinate/director/package.nix { };
            plan-reminder = pkgs.callPackage ./writs/plan-reminder/package.nix { };
            discovery-reminder = pkgs.callPackage ./writs/discovery-reminder/package.nix { };
            oc-wake = pkgs.callPackage ./wake/oc-wake/package.nix { };
          };

          checks = {
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
              " && touch "$out"
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
                  }
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
