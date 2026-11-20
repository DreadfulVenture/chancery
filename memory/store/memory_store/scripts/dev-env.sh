# shellcheck shell=bash
# Shared scratch-stack bootstrap for the dev-loop and rehearsal scripts
# (memory-dev, rehearse). Sourced, never executed — no shebang on purpose; Every process these scripts boot runs against a
# relocated HOME/XDG root and explicitly set store paths, so a lost env
# variable degrades into scratch instead of into the developer's live
# memory directory. dev_env_init aborts before any process spawns when an
# isolation variable is missing or points outside the scratch root — the
# gate is the guarantee, not the caller's discipline.

# dev_env_init <scratch-root>: relocate the environment into the scratch
# root and set every isolation variable. Call once, before booting anything.
dev_env_init() {
  local root="${1:?dev_env_init needs the scratch root}"
  DEV_ROOT="$root"
  DEV_HOME="$root/home"
  DEV_REAL_HOME="$HOME"
  mkdir -p "$DEV_HOME" "$root/memory/data" "$root/memory/queue"

  export HOME="$DEV_HOME"
  export XDG_DATA_HOME="$root/xdg/data"
  export XDG_CONFIG_HOME="$root/xdg/config"
  export XDG_CACHE_HOME="$root/xdg/cache"
  # State too: opencode's detached service registry and auth state live
  # under XDG_STATE_HOME/opencode — missing this one let the rehearsal
  # client attach to the developer's live service (the one surface the
  # first rehearsal run leaked through).
  export XDG_STATE_HOME="$root/xdg/state"
  mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"

  # The two artifact caches stay shared with the real home: they hold
  # content-addressed read-only build artifacts (embedding model files,
  # wheel builds), and re-downloading hundreds of megabytes per run is
  # the price of pointing them at scratch. No live state lives there.
  export FASTEMBED_CACHE_PATH="$DEV_REAL_HOME/.cache/fastembed"
  export UV_CACHE_DIR="$DEV_REAL_HOME/.cache/uv"

  export MEMORY_DATA_DIR="$root/memory/data"
  export MEMORY_QUEUE_DIR="$root/memory/queue"
  export MEMORY_CURSOR_HOOKS_PATH="$root/cursor-hooks.json"
  export MEMORY_FLOOR_RULE_PATH="$root/memory-floor-rule.md"
  export MEMORY_MACHINE_ID="devstack"
  export MEMORY_HUB_PORT="${MEMORY_HUB_PORT:-18767}"
  export DEV_LLM_PORT="${DEV_LLM_PORT:-18768}"
  export MEMORY_MCP_PORT="${MEMORY_MCP_PORT:-17174}"

  dev_env_assert
}

# Abort cold when any isolation variable is empty or outside the scratch
# root. The cache paths are the deliberate exceptions (shared, read-only).
dev_env_assert() {
  local failed="" var value
  # Paths only below; MEMORY_MACHINE_ID is a label, not a location.
  for var in HOME XDG_DATA_HOME XDG_CONFIG_HOME XDG_CACHE_HOME XDG_STATE_HOME \
             MEMORY_DATA_DIR MEMORY_QUEUE_DIR MEMORY_CURSOR_HOOKS_PATH \
             MEMORY_FLOOR_RULE_PATH; do
    value="${!var:-}"
    if [[ -z "$value" ]]; then
      failed="$failed $var(empty)"
    elif [[ "$value" != "$DEV_ROOT" && "$value" != "$DEV_ROOT"/* ]]; then
      failed="$failed $var($value)"
    fi
  done
  if [[ -n "$failed" ]]; then
    echo "dev-env gate: isolation variables point outside the scratch root:$failed" >&2
    echo "  scratch root: $DEV_ROOT" >&2
    exit 1
  fi
}
