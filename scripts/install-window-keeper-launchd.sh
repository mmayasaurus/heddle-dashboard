#!/bin/sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HEDDLE_DIR="$HOME/.heddle"
PLIST="$HOME/Library/LaunchAgents/io.heddle.window-keeper.plist"
RESOLVED_COMMS_POST="${HEDDLE_COMMS_POST:-/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/bin/comms-post.mjs}"

# Resolve an EXPLICIT-node invocation of the heddle CLI for the sidecar OAuth poller (HED-329) and
# bake it into the plist as HEDDLE_BIN. launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin — it has no
# node, and dist/cli.js's `#!/usr/bin/env -S node` shebang can't find one, so node must be named
# explicitly: `<abs-node> <abs>/dist/cli.js`. A bare `heddle` fails twice (not on that PATH, and the
# shebang still can't find node), so we never bake it. Run this from the main heddle-dashboard
# checkout (beside ../heddle) or set HEDDLE_CORE_DIR to the heddle repo root; a worktree has no
# sibling ../heddle, so the resolver refuses rather than baking a broken path.
NODE_BIN="$HOME/.local/share/fnm/aliases/default/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="$(readlink -f "$(command -v node 2>/dev/null)" 2>/dev/null || true)"
if command -v heddle >/dev/null 2>&1; then
  CLI_JS="$(readlink -f "$(command -v heddle)" 2>/dev/null || command -v heddle)"
else
  CLI_JS="$(cd "${HEDDLE_CORE_DIR:-$SOURCE_DIR/../../heddle}" 2>/dev/null && pwd || true)/dist/cli.js"
fi
if [ ! -x "$NODE_BIN" ] || [ ! -f "$CLI_JS" ]; then
  echo "error: cannot resolve the heddle CLI for HEDDLE_BIN (node='$NODE_BIN' cli='$CLI_JS')." >&2
  echo "       Run from the main heddle-dashboard checkout (beside ../heddle), or set HEDDLE_CORE_DIR to the heddle repo root." >&2
  exit 1
fi

mkdir -p "$HEDDLE_DIR" "$(dirname "$PLIST")"
install -m 755 "$SOURCE_DIR/heddle-window-keeper.py" "$HEDDLE_DIR/window-keeper.py"
install -m 755 "$SOURCE_DIR/heddle-rotation-post.py" "$HEDDLE_DIR/heddle-rotation-post.py"
python3 - "$SOURCE_DIR/io.heddle.window-keeper.plist" "$PLIST" "$HOME" "$RESOLVED_COMMS_POST" "$NODE_BIN" "$CLI_JS" <<'PY'
import shlex, sys
source, destination, home, comms_post, node_bin, cli_js = sys.argv[1:]
# The keeper does shlex.split(HEDDLE_BIN); quote each token so a path containing spaces survives the
# round-trip through the plist <string> and back into argv.
heddle_bin = shlex.quote(node_bin) + " " + shlex.quote(cli_js)
with open(source) as f:
    contents = f.read()
with open(destination, "w") as f:
    f.write(contents.replace("__HOME__", home).replace("__COMMS_POST__", comms_post).replace("__HEDDLE_BIN__", heddle_bin))
PY
chmod 644 "$PLIST"
launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
