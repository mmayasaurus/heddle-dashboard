#!/usr/bin/env bash
#
# dev-electron.sh — Electron desktop development with an instance registry for parallel dev-instance management.
#
# Currently Electron still serves static `vite build` output through the sidecar and has no HMR (future work; see
# §4 Electron / §9 in the development-mode and port design document). This script wraps the original
# `electron:dev` build/start flow with instance registration and cleanup so dev:ls / dev:stop can manage it precisely.
#
# electron/main.cjs allocates the Electron sidecar backend port internally, beyond this Bash layer, so the registry
# records only the launcher PID. dev:stop recursively terminates that PID's process tree, including the Electron
# child sidecar.
#
# Usage:
#   pnpm dev:electron [label]      # Optional label; defaults to generated electron-XXXX.
#   VLX_DEV_LABEL=foo pnpm dev:electron
#
set -euo pipefail

cd "$(dirname "$0")/.."
source "$(dirname "$0")/dev-lib.sh"

LABEL="$(dev_label electron "${1:-}")"

echo "==> Electron dev  ·  instance ${LABEL}: build the frontend and backend first, then start Electron."

# Build frontend static output and the backend binary, matching the original electron:dev.
pnpm exec vite build
cargo build --manifest-path src-tauri/Cargo.toml

# Register the running instance; cleanup removes it on exit. Electron exposes no port field to Bash.
dev_write_instance "$LABEL" electron

# On exit/interruption, terminate Electron and its sidecar child, then remove the registry entry.
cleanup() { trap - INT TERM EXIT; [ -n "${ELECTRON_PID:-}" ] && kill "$ELECTRON_PID" 2>/dev/null || true; dev_remove_instance; }
trap cleanup INT TERM EXIT

echo "    Ctrl+C stops it, or run pnpm dev:stop ${LABEL} elsewhere"
pnpm exec electron electron/main.cjs &
ELECTRON_PID=$!
wait "$ELECTRON_PID"
