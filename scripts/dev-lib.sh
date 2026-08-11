#!/usr/bin/env bash
#
# dev-lib.sh — Shared development-instance registry and cleanup helpers for launcher scripts.
#
# Development supports parallel Tauri, Electron, Web, and Mobile instances, but their process signatures are
# identical and ports are random. Stopping one otherwise requires process inspection, while fuzzy name matching
# (`pkill -f`) can kill sibling instances. Each launch therefore writes its identity (label, mode, PID, ports,
# data directory) to `.dev-data/instances/<label>.json` and removes it through a trap on exit. `pnpm dev:ls` lists
# active instances and `pnpm dev:stop <label>` terminates one exact PID, eliminating process-name guesses. See the
# development-mode and port design document under docs/design.
#
# Usage from launcher scripts:
#   source "$(dirname "$0")/dev-lib.sh"
#   LABEL="$(dev_label web "${2:-}")"          # Resolve label: environment > candidate > generated.
#   dev_write_instance "$LABEL" web vitePort=$VITE_PORT backendPort=$BACKEND_PORT \
#                      dataDir="$DATA_DIR" url="$URL"
#   cleanup() { trap - INT TERM EXIT; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; dev_remove_instance; }
#   trap cleanup INT TERM EXIT

# Runtime registry directory; all of .dev-data is ignored by Git.
INSTANCES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.dev-data/instances"

# Registry-file path for this instance, set by dev_write_instance and removed by dev_remove_instance.
DEV_INSTANCE_FILE=""

# dev_label <mode> [candidate] — Resolve and echo this instance's label.
#   Priority: VLX_DEV_LABEL > supplied candidate > generated "<mode>-<4-random-hex-digits>".
dev_label() {
  local mode="$1" cand="${2:-}"
  if [ -n "${VLX_DEV_LABEL:-}" ]; then
    printf '%s' "$VLX_DEV_LABEL"
  elif [ -n "$cand" ]; then
    printf '%s' "$cand"
  else
    printf '%s-%04x' "$mode" "$((RANDOM))"
  fi
}

# dev_write_instance <label> <mode> [key=value ...] — Write the registry file.
#   Pass additional fields as key=value: pure numbers become JSON numbers; all others become strings.
#   Reject startup when a same-labeled instance has a live PID, preventing duplicate labels from overwriting.
dev_write_instance() {
  local label="$1" mode="$2"
  shift 2
  mkdir -p "$INSTANCES_DIR"
  DEV_INSTANCE_FILE="$INSTANCES_DIR/$label.json"

  if [ -f "$DEV_INSTANCE_FILE" ]; then
    local old_pid
    old_pid="$(grep -o '"pid":[0-9]*' "$DEV_INSTANCE_FILE" | grep -o '[0-9]*' | head -1 || true)"
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      echo "✗ A dev instance with this label is already running: $label (pid $old_pid)." >&2
      echo "  Pick another label, or stop it first: pnpm dev:stop $label" >&2
      exit 1
    fi
    # Stale registry entry for a dead instance: overwrite it directly.
  fi

  local extra=""
  local kv k v
  for kv in "$@"; do
    k="${kv%%=*}"
    v="${kv#*=}"
    if printf '%s' "$v" | grep -qE '^[0-9]+$'; then
      extra="$extra,\"$k\":$v"
    else
      extra="$extra,\"$k\":\"$v\""
    fi
  done

  # $$ is the current launcher shell PID. source creates no child process, so this is the launcher itself and the
  # root of the instance process tree; dev:stop uses it to terminate that tree precisely.
  cat > "$DEV_INSTANCE_FILE" <<EOF
{"label":"$label","mode":"$mode","pid":$$,"startedAt":"$(date '+%Y-%m-%d %H:%M:%S')"$extra}
EOF
}

# dev_remove_instance — Remove this instance's registry file from the cleanup trap.
dev_remove_instance() {
  [ -n "$DEV_INSTANCE_FILE" ] && rm -f "$DEV_INSTANCE_FILE"
}
