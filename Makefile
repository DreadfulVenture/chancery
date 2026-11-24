SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
MAKEFLAGS += --warn-undefined-variables --no-builtin-rules

.PHONY: test
test: test-memory test-plugin test-watcher test-director test-reminders test-oc-wake ## Run all tests

.PHONY: test-memory
test-memory: ## Run hermetic memory-store tests
	@cd memory/store && MEMORY_DISABLE_EMBEDDINGS=1 PYTHONPATH=. UV_PYTHON=3.12 uv run --frozen --extra dev -- python -m pytest -n auto memory_store/tests

.PHONY: test-plugin
test-plugin: ## Run the OpenCode memory client tests
	@node --test memory/opencode-client/tests/*.test.ts

.PHONY: test-watcher
test-watcher: ## Run the mail-watcher tests
	@npm ci --prefix watch/mail-watcher --no-audit --prefer-offline
	@node --test watch/mail-watcher/tests/*.test.ts

.PHONY: test-director
test-director: ## Run the director package tests
	@node --test coordinate/director/tests/*.test.ts

.PHONY: test-reminders
test-reminders: ## Run the writs reminder plugin tests
	@node --test writs/plan-reminder/tests/*.test.ts writs/discovery-reminder/tests/*.test.ts

.PHONY: test-oc-wake
test-oc-wake: ## Run the oc-wake CLI tests
	@node --test wake/oc-wake/tests/*.test.ts

.PHONY: test-runtime-compat
test-runtime-compat: ## Run the zenigata runtime compat check against the packaged serve (builds the runtime package with nix)
	@out=$$(nix build .#zenigata-runtime --no-link --print-out-paths | tail -1) && \
	node review/zenigata/test/runtime-compat-run.ts --runtime "$$out"

.PHONY: test-agenix
test-agenix: ## Run the agenix-secrets helper tests in the nix sandbox (no dev-shell dependencies)
	@system=$$(nix eval --raw --impure --expr 'builtins.currentSystem') && \
	nix build .#checks.$$system.agenix-secrets --no-link --print-out-paths > /dev/null

.PHONY: memory-dev
memory-dev: ## Boot the local development stack
	@./memory/store/memory_store/scripts/memory-dev

.PHONY: rehearse
rehearse: ## Full rehearsal: scratch stack + real opencode client leg
	@./memory/store/memory_store/scripts/rehearse
