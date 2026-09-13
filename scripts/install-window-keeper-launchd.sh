#!/bin/sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HEDDLE_DIR="$HOME/.heddle"
PLIST="$HOME/Library/LaunchAgents/io.heddle.window-keeper.plist"
RESOLVED_COMMS_POST="${HEDDLE_COMMS_POST:-/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/bin/comms-post.mjs}"
mkdir -p "$HEDDLE_DIR" "$(dirname "$PLIST")"
install -m 755 "$SOURCE_DIR/heddle-window-keeper.py" "$HEDDLE_DIR/window-keeper.py"
install -m 755 "$SOURCE_DIR/heddle-rotation-post.py" "$HEDDLE_DIR/heddle-rotation-post.py"
python3 - "$SOURCE_DIR/io.heddle.window-keeper.plist" "$PLIST" "$HOME" "$RESOLVED_COMMS_POST" <<'PY'
import sys
source, destination, home, comms_post = sys.argv[1:]
with open(source) as f:
    contents = f.read()
with open(destination, "w") as f:
    f.write(contents.replace("__HOME__", home).replace("__COMMS_POST__", comms_post))
PY
chmod 644 "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
