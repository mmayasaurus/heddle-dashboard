#!/usr/bin/env bash
# refresh-dock-icon.sh
# Purpose: clear macOS icon caches and restart Dock/Finder to force application icons to refresh.
#
# Usage:
#   bash scripts/refresh-dock-icon.sh                     # Clear caches and restart Dock/Finder.
#   bash scripts/refresh-dock-icon.sh ~/Soft/heddle.app # Also re-register the specified .app for a deeper refresh.
#
# Notes:
#   - Deleted caches are rebuilt automatically by the OS, so removal is safe.
#   - sudo is required to clear system cache directories and will prompt for a password.
#   - This is meaningful only on macOS; other systems exit without action.

set -uo pipefail

if [ "$(uname)" != "Darwin" ]; then
  echo "macOS only (icon caches are a macOS concept). Current system: $(uname). Skipped."
  exit 0
fi

APP_PATH="${1:-}"

echo "==> About to clear the icon caches. This needs administrator rights and may ask for your password."
sudo -v || { echo "Did not obtain sudo rights. Aborted."; exit 1; }

echo "==> Removing the system icon cache: /Library/Caches/com.apple.iconservices.store"
sudo rm -rf /Library/Caches/com.apple.iconservices.store 2>/dev/null || true

echo "==> Removing the iconservices / Dock icon caches under the temporary directories"
sudo find /private/var/folders \
  \( -name com.apple.iconservices -o -name com.apple.dock.iconcache \) \
  -prune -exec rm -rf {} + 2>/dev/null || true

# Optionally re-register the specified .app so LaunchServices rereads its icon; more effective than cache clearing alone.
if [ -n "$APP_PATH" ]; then
  if [ -d "$APP_PATH" ]; then
    echo "==> Re-registering the application: $APP_PATH"
    LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
    "$LSREGISTER" -f "$APP_PATH" || true
  else
    echo "!! Not a valid .app, skipping registration: $APP_PATH"
  fi
fi

echo "==> Restarting Dock and Finder."
killall Dock 2>/dev/null || true
killall Finder 2>/dev/null || true

echo "==> Done. If the icon is still the old one, the cache is probably not the problem: the new icon was most likely never built into the .app."
