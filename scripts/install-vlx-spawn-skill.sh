#!/usr/bin/env bash
#
# Install vlx-term's bundled skills into the user-level Claude and Codex skill directories, making these commands
# available in every vlx-term session:
#   /vspawn <task>        — Spawn a child session in the current directory without a worktree by default.
#   /vspawn-tree <task>   — Spawn a child session with a dedicated Git worktree.
#   /vopen <file|URL>     — Open a file/URL in vlx-term's center pane, matching the terminal vopen command.
#
# These are only explicit entry points. Commands with the same names on PATH do the actual work; vlx-term extracts
# them at startup and injects them into every session's PATH, so they require no installation. This script installs
# only the wrappers invoked explicitly in Claude/Codex conversations. The Vela Skills toggle in application
# settings manages the same set and rewrites them at startup to keep them current.
#
# Usage: scripts/install-vlx-spawn-skill.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Remove legacy names: vlx-spawn-here → vlx-spawn-tree (old); vlx-spawn / vlx-spawn-tree / view became vspawn / vspawn-tree / vopen.
rm -rf "${HOME}/.claude/skills/vlx-spawn-here" \
       "${HOME}/.claude/skills/vlx-spawn" \
       "${HOME}/.claude/skills/vlx-spawn-tree" \
       "${HOME}/.claude/skills/view"

CODEX_SKILLS_DIR="${CODEX_HOME:-${HOME}/.codex}/skills"
for skills_dir in "${HOME}/.claude/skills" "$CODEX_SKILLS_DIR"; do
  for name in vspawn vspawn-tree vopen; do
    src="$ROOT/skills/$name/SKILL.md"
    dest="$skills_dir/$name"
    if [[ ! -f "$src" ]]; then
      echo "Skill source file not found: $src" >&2
      exit 1
    fi
    mkdir -p "$dest"
    if [[ "$skills_dir" == "$CODEX_SKILLS_DIR" ]]; then
      # Codex does not accept Claude-specific frontmatter, and its tools have no equivalent for Bash restrictions.
      sed -e '/^argument-hint:/d' \
          -e '/^disable-model-invocation:/d' \
          -e '/^allowed-tools:/d' \
          "$src" > "$dest/SKILL.md"
    else
      cp "$src" "$dest/SKILL.md"
    fi
    echo "Installed the $name skill into $dest"
  done
done

echo "New Claude/Codex sessions in vlx-term can now use:"
echo "  Claude: /vspawn、/vspawn-tree、/vopen"
echo "  Codex:  \$vspawn、\$vspawn-tree、\$vopen"
