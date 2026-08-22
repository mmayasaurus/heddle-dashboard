#!/usr/bin/env bash
set -euo pipefail

readonly PLIST_NAME='io.heddle.cursor-refresh.plist'
readonly SOURCE="$(cd "$(dirname "$0")" && pwd)/$PLIST_NAME"
readonly DESTINATION="/Users/mayatobi/Library/LaunchAgents/$PLIST_NAME"
readonly LOG_DIR='/Users/mayatobi/.heddle/logs'

mkdir -p "$LOG_DIR"
mkdir -p /Users/mayatobi/Library/LaunchAgents
cp "$SOURCE" "$DESTINATION"
launchctl bootout "gui/$(id -u)" "$DESTINATION" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DESTINATION"
