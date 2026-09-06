#!/bin/sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HEDDLE_DIR="$HOME/.heddle"
PLIST="$HOME/Library/LaunchAgents/io.heddle.window-keeper.plist"
mkdir -p "$HEDDLE_DIR" "$(dirname "$PLIST")"
install -m 755 "$SOURCE_DIR/heddle-window-keeper.py" "$HEDDLE_DIR/window-keeper.py"
install -m 755 "$SOURCE_DIR/heddle-rotation-post.py" "$HEDDLE_DIR/heddle-rotation-post.py"
install -m 644 "$SOURCE_DIR/io.heddle.window-keeper.plist" "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
