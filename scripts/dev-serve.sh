#!/usr/bin/env bash
#
# dev-serve.sh <web|mobile> — plaintext development backend plus Vite HMR on random ports.
#
# The modes differ only in binding:
#   web: Vite on localhost and backend on 127.0.0.1 (`--local-http`) for a local browser.
#   mobile: both on 0.0.0.0 (`--lan-http`) for a phone browser or shell over LAN.
#
# Clients connect to Vite, which proxies /ws and /api to the real backend while preserving HMR.
#
# Design:
# 1. Random Vite/backend ports allow Tauri, Electron, and both modes to run concurrently.
# 2. Each mode defaults to `.dev-data/<mode>` for safe parallel databases and starts with an empty tree.
# 3. Password defaults to `dev` and may be overridden with VELA_SERVE_PASSWORD.
#
# Usage:
#   pnpm dev:web                          # Local browser with HMR and an isolated empty database
#   pnpm dev:mobile                       # Phone access with HMR and an isolated empty database
#   VLX_DEV_DATA_DIR="$HOME/Library/Application Support/io.vlinx.vlxterm" pnpm dev:mobile
#                                         # Use the real database only when no other backend writes it
#   VELA_SERVE_PASSWORD=mypw pnpm dev:web # Custom login password
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

MODE="${1:-web}"
case "$MODE" in
  web)    HTTP_FLAG="--local-http" ;;
  mobile) HTTP_FLAG="--lan-http" ;;
  *) echo "usage: $0 <web|mobile> [label]"; exit 1 ;;
esac

# Register a label from environment, second argument, or automatic generation for dev:ls/dev:stop.
source "$(dirname "$0")/dev-lib.sh"
LABEL="$(dev_label "$MODE" "${2:-}")"

PASSWORD="${VELA_SERVE_PASSWORD:-dev}"
DATA_DIR="${VLX_DEV_DATA_DIR:-$ROOT/.dev-data/$MODE}"
mkdir -p "$DATA_DIR"

# Reserve ports free on 0.0.0.0 so they work for loopback and LAN bindings.
free_port() { node -e 'const s=require("net").createServer();s.listen(0,"0.0.0.0",()=>{process.stdout.write(String(s.address().port));s.close()})'; }
BACKEND_PORT="$(free_port)"
VITE_PORT="$(free_port)"

# Mobile mode discovers the first non-loopback IPv4 using platform-specific methods; web uses localhost.
# Fall back to 127.0.0.1 nonfatally when discovery fails.
lan_ip() {
  case "$(uname -s)" in
    Darwin)
      ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1 ;;
    Linux)
      { hostname -I 2>/dev/null | awk '{print $1}'; } | grep -E '.' || echo 127.0.0.1 ;;
    MINGW*|MSYS*|CYGWIN*)
      ipconfig 2>/dev/null | grep -a 'IPv4' | grep -aoE '[0-9]+(\.[0-9]+){3}' \
        | grep -vE '^127\.' | head -1 | grep -E '.' || echo 127.0.0.1 ;;
    *) echo 127.0.0.1 ;;
  esac
}
LAN_IP="$(lan_ip)"

# Clients connect to Vite; mobile binds it to 0.0.0.0 and points HMR at the LAN address.
if [ "$MODE" = "mobile" ]; then
  CLIENT_HOST="$LAN_IP"
  export VLX_VITE_HOST="0.0.0.0"
  export VLX_VITE_HMR_HOST="$LAN_IP"
else
  CLIENT_HOST="localhost"
fi
URL="http://${CLIENT_HOST}:${VITE_PORT}"

# Register the instance; cleanup removes it on exit.
dev_write_instance "$LABEL" "$MODE" \
  "vitePort=$VITE_PORT" "backendPort=$BACKEND_PORT" "dataDir=$DATA_DIR" "url=$URL"

echo "============================================================"
echo " dev · ${MODE} mode (HMR)  ·  instance ${LABEL}"
echo "   URL       : ${URL}"
echo "   Password  : ${PASSWORD}"
echo "   Data dir  : ${DATA_DIR}"
echo "   Ports     : Vite ${VITE_PORT} / backend ${BACKEND_PORT} (both random, so instances run in parallel)"
if [ "$MODE" = "mobile" ]; then
  echo "   Pair link : vlxterm://pair?host=${CLIENT_HOST}&port=${VITE_PORT}&password=${PASSWORD}&name=dev"
  echo "   (type the link into Add host in the phone app, or turn it into a QR code)"
fi
echo " Ctrl+C stops both the backend and Vite; elsewhere, use pnpm dev:stop ${LABEL}"
echo "============================================================"

# On exit or interruption, terminate backend/Vite children and remove the registry entry.
pids=()
cleanup() { trap - INT TERM EXIT; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; dev_remove_instance; }
trap cleanup INT TERM EXIT

# 1. Start the debug backend on a random plaintext port and isolated database. Pass password by environment.
VELA_SERVE_PASSWORD="$PASSWORD" \
  cargo run --manifest-path src-tauri/Cargo.toml -- \
    --serve "$HTTP_FLAG" --port "$BACKEND_PORT" --data-dir "$DATA_DIR" &
pids+=($!)

# 2. Start Vite HMR on a random port and proxy /ws and /api to the backend.
VLX_VITE_PORT="$VITE_PORT" VLX_DEV_BACKEND="http://127.0.0.1:${BACKEND_PORT}" \
  pnpm exec vite &
pids+=($!)

# 3. In web mode, open a browser after Vite starts; mobile clients connect themselves.
if [ "$MODE" = "web" ]; then
  (
    for _ in $(seq 1 60); do
      if curl -s -o /dev/null "http://127.0.0.1:${VITE_PORT}/" 2>/dev/null; then
        open "$URL" 2>/dev/null \
          || xdg-open "$URL" 2>/dev/null \
          || powershell.exe -NoProfile -Command "Start-Process '$URL'" 2>/dev/null \
          || cmd.exe //c start "" "$URL" 2>/dev/null \
          || true
        break
      fi
      sleep 0.5
    done
  ) &
fi

wait
