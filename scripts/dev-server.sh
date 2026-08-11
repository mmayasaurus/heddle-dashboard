#!/usr/bin/env bash
#
# dev-server.sh — Build a development-mode vela-server without publishing, signing, or uploading.
#
# Uses exactly the same build commands as a formal release (publish-server.sh matrix mode): frontend pnpm build
# plus cargo zigbuild cross-compilation for Linux. It omits signing/upload/manifest and injects VLX_DEV_BUILD=1,
# making the frontend title bar show the development-style blue DEV badge with the build timestamp so the artifact
# is immediately distinguishable from a release.
#
# Purpose: end-to-end SSH remote-connection testing. With VLX_DEV_SERVER_BIN, the artifact uses the provisioning
# development bypass (see ssh_remote.rs::connect_inner): skip R2 download/signature verification and scp this
# binary directly to the remote host.
#
# Usage (default end-to-end flow: build, then launch desktop dev with VLX_DEV_SERVER_BIN for immediate testing):
#   pnpm dev:server                    # Build Linux artifact and launch desktop dev (the common command).
#   pnpm dev:server --build-only       # Build only, without opening a window.
#   pnpm dev:server --mac              # Also build a local macOS artifact.
#   pnpm dev:server --skip-frontend    # Reuse existing dist/ when the frontend is unchanged.
#
# If a service of the **same version** already runs remotely, reconnect reuses that process instead of replacing
# its binary. To replace it, choose "Stop server" in the exit dialog first, or run manually:
# ssh <host> 'kill $(sed -n "s/.*\"pid\":\([0-9]*\).*/\1/p" ~/.velaterm/run.json); rm -f ~/.velaterm/run.json'
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m    ✗ %s\033[0m\n' "$1" >&2; exit 1; }

LINUX_TARGET="x86_64-unknown-linux-gnu"
LINUX_GLIBC="2.17"   # Match publish-server.sh: minimum compatible glibc (CentOS 7+).

SKIP_FRONTEND=0
BUILD_MAC=0
LAUNCH=1
for arg in "$@"; do
  case "$arg" in
    --skip-frontend) SKIP_FRONTEND=1 ;;
    --mac)           BUILD_MAC=1 ;;
    --build-only)    LAUNCH=0 ;;
    --launch)        LAUNCH=1 ;;  # Retain the legacy spelling; launching is now the default.
    *) die "Unknown argument: $arg (accepted: --build-only / --skip-frontend / --mac)" ;;
  esac
done

VERSION="$(node -p "require('./package.json').version")"
GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)-dev"
BUILD_TIME="$(date +%Y%m%d-%H%M)"

step "Building dev server v${VERSION} (stamp=${BUILD_TIME}, DEV badge enabled)"

# ---- Prerequisite checks, matching the matrix script ----
command -v cargo-zigbuild >/dev/null 2>&1 \
  || die "cargo-zigbuild is missing: cargo install cargo-zigbuild"
rustup target list --installed 2>/dev/null | grep -qx "$LINUX_TARGET" \
  || die "Rust target is missing: rustup target add ${LINUX_TARGET}"

# ---- Frontend: VLX_DEV_BUILD=1 enables the DEV badge; VLX_BUILD_TIME supplies its timestamp ----
if [ "$SKIP_FRONTEND" = 1 ]; then
  [ -f "$ROOT/dist/index.html" ] || die "--skip-frontend was given but dist/ does not exist; build once without the flag first"
  ok "Reusing the existing dist/ (note: if the previous build ran without VLX_DEV_BUILD=1, the badge will not read DEV)"
else
  step "Building the frontend (VLX_DEV_BUILD=1 pnpm build)"
  VLX_DEV_BUILD=1 VLX_BUILD_TIME="$BUILD_TIME" pnpm build || die "Frontend build failed"
fi

# ---- Linux cross-compilation via zigbuild with release-equivalent arguments ----
step "Cross-compiling for Linux (cargo zigbuild --target ${LINUX_TARGET}.${LINUX_GLIBC})"
( cd src-tauri && VLX_GIT_COMMIT="$GIT_COMMIT" VLX_BUILD_TIME="$BUILD_TIME" \
    cargo zigbuild --release --no-default-features --target "${LINUX_TARGET}.${LINUX_GLIBC}" ) \
  || die "Linux cross-compilation failed"
LINUX_BIN="$ROOT/src-tauri/target/${LINUX_TARGET}/release/velaterm"
[ -f "$LINUX_BIN" ] || die "Build output is missing: $LINUX_BIN"
ok "Linux binary: $LINUX_BIN"

# ---- Optional local macOS artifact ----
if [ "$BUILD_MAC" = 1 ]; then
  step "Building the native macOS binary (cargo build --release --no-default-features)"
  ( cd src-tauri && VLX_GIT_COMMIT="$GIT_COMMIT" VLX_BUILD_TIME="$BUILD_TIME" \
      cargo build --release --no-default-features ) || die "macOS build failed"
  ok "macOS binary: $ROOT/src-tauri/target/release/velaterm"
fi

# ---- Finish: usage guidance / end-to-end launch ----
step "Done"
echo "    Connect to a remote host (SSH remote connections take the provisioning development bypass):"
echo "      export VLX_DEV_SERVER_BIN=\"$LINUX_BIN\""
echo "      pnpm dev:desktop"
echo "    A remote host already running this version reuses that process; stop the server first to replace it (see the header)."

if [ "$LAUNCH" = 1 ]; then
  step "Launching the dev desktop build (VLX_DEV_SERVER_BIN is already injected)"
  VLX_DEV_SERVER_BIN="$LINUX_BIN" exec bash "$ROOT/scripts/dev-desktop.sh"
fi
