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

# Either/or with the keeper-less usage-poll producer (HED-552, reciprocal of HED-517's guard): exactly
# one scheduled usage-sidecar producer per machine. If io.heddle.usage-poll-claude is loaded, installing
# the keeper too would double-write the claude-<id>.oauth-usage.json sidecars. Fail SAFE: only launchctl's
# "not found" (exit 113) proves the producer absent; any other failure leaves its status undetermined, so
# refuse rather than risk a second producer. Runs before any mutation so a refusal touches nothing.
PRODUCER_LABEL="io.heddle.usage-poll-claude"
if launchctl print "gui/$(id -u)/$PRODUCER_LABEL" >/dev/null 2>&1; then
  PRODUCER_RC=0
else
  PRODUCER_RC=$?
fi
if [ "$PRODUCER_RC" -eq 0 ]; then
  echo "error: $PRODUCER_LABEL is loaded — this machine already runs the keeper-less usage-poll producer." >&2
  echo "       Install exactly one producer per machine (never both). Boot out the producer, or skip the keeper." >&2
  exit 1
elif [ "$PRODUCER_RC" -ne 113 ]; then
  echo "error: cannot determine whether $PRODUCER_LABEL is loaded (launchctl exit $PRODUCER_RC); refusing to install a second usage producer." >&2
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
