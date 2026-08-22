#!/usr/bin/env bash
# Install the io.heddle.cursor-refresh launchd job: a stable symlink to the built dashboard
# binary, plus the plist that invokes it every 5 min to keep ~/.heddle/usage/limits.json's
# cursor block fresh for out-of-app consumers (e.g. the Bugbot-meter watcher).
#
# Requires the dashboard built:  (cd heddle-dashboard/src-tauri && cargo build --release)
# Fail-safe: if the binary is missing (unbuilt / cargo clean'd), the launchd run errors that
# poll (surfaced in the .err log) and consumers warn-stale until the next build — no bad data
# is written. Repoint the symlink at Heddle.app/Contents/MacOS/heddle once the dashboard ships
# as an installed .app; the plist never has to change.
set -euo pipefail

readonly PLIST_NAME='io.heddle.cursor-refresh.plist'
SOURCE="$(cd "$(dirname "$0")" && pwd)/$PLIST_NAME"
readonly SOURCE
readonly DESTINATION="$HOME/Library/LaunchAgents/$PLIST_NAME"
readonly LOG_DIR="$HOME/.heddle"
# Distinct name so it never shadows the JS `heddle` CLI on PATH; the plist invokes it by its
# absolute path (launchd does not expand ~/$HOME, so the plist hardcodes /Users/mayatobi).
readonly SYMLINK="$HOME/.local/bin/heddle-app"
readonly APP_BIN="${HEDDLE_APP_BIN:-$HOME/Developer/heddle-dashboard/src-tauri/target/release/heddle}"

if [[ ! -x "$APP_BIN" ]]; then
  echo "install-cursor-refresh: dashboard binary not found at $APP_BIN" >&2
  echo "  build it first: (cd heddle-dashboard/src-tauri && cargo build --release)" >&2
  echo "  or set HEDDLE_APP_BIN=/abs/path/to/heddle and re-run." >&2
  exit 1
fi

# mkdir the log dir BEFORE load, or launchd silently refuses to open StandardOutPath.
mkdir -p "$LOG_DIR" "$HOME/.local/bin" "$HOME/Library/LaunchAgents"
ln -sf "$APP_BIN" "$SYMLINK"
cp "$SOURCE" "$DESTINATION"
launchctl bootout "gui/$(id -u)" "$DESTINATION" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DESTINATION"
echo "install-cursor-refresh: installed ($SYMLINK -> $APP_BIN; refresh every 300s)"
