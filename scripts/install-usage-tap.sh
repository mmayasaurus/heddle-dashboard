#!/bin/sh
set -eu

# shellcheck disable=SC1007
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HEDDLE_DIR="$HOME/.heddle"
SRC="$SOURCE_DIR/heddle-usage-tap.mjs"
DST="$HEDDLE_DIR/usage-tap.mjs"

sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    printf '%s\n' 'error: neither shasum nor sha256sum is available' >&2
    return 1
  fi
}

if [ ! -f "$SRC" ]; then
  printf 'error: source tap not found: %s\n' "$SRC" >&2
  exit 1
fi

mkdir -p "$HEDDLE_DIR"

src_digest=$(sha256 "$SRC")
src_lines=$(wc -l < "$SRC")
printf 'source:   %s (%s lines)\n' "$src_digest" "$src_lines"

if [ -f "$DST" ]; then
  dst_digest=$(sha256 "$DST")
  dst_lines=$(wc -l < "$DST")
  printf 'existing: %s (%s lines)\n' "$dst_digest" "$dst_lines"

  if [ "$dst_digest" = "$src_digest" ]; then
    printf 'usage-tap.mjs already up to date (%s)\n' "$src_digest"
  else
    backup="$DST.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$DST" "$backup"
    printf 'backed up existing -> %s\n' "$backup"
    install -m 755 "$SRC" "$DST"
    printf 'installed %s -> %s\n' "$src_digest" "$DST"
  fi
else
  install -m 755 "$SRC" "$DST"
  printf 'installed %s -> %s\n' "$src_digest" "$DST"
fi

printf '%s\n' 'statusLine wiring:'
plain_settings="$HOME/.claude/settings.json"
reported_plain=0
for settings_file in "$plain_settings" "$HOME"/.claude*/settings.json; do
  [ -f "$settings_file" ] || continue

  if [ "$settings_file" = "$plain_settings" ] && [ "$reported_plain" -eq 1 ]; then
    continue
  fi

  if grep -q 'usage-tap.mjs' "$settings_file"; then
    printf '  wired:     %s\n' "$settings_file"
  else
    printf '  NOT wired: %s\n' "$settings_file"
  fi

  if [ "$settings_file" = "$plain_settings" ]; then
    reported_plain=1
  fi
done

printf 'This installer does not modify settings.json. Verify statusLine.command pipes through %s.\n' "$DST"
printf '%s\n' 'The tap file is re-read on every render, so this refresh takes effect immediately for running sessions (no restart needed).'
