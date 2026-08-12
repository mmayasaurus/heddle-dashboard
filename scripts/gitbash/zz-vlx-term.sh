# Shipped by vlx-term in the Git Bash resource tree. Single source of truth lives at
# scripts/gitbash/zz-vlx-term.sh and is stamped into <tree>/etc/profile.d/zz-vlx-term.sh by
# scripts/release.sh (deploy_gitbash / stage_gitbash / sync_build_gitbash). Sourced by
# /etc/profile on login. Content is machine-independent -- there are NO per-install values here:
# VLX_BIN_DIR is read live from the session environment (injected in pty/manager.rs), so one
# file works on every machine and every install path. Edit here, then `pnpm release` restages it.

# Login /etc/profile rebuilds PATH and drops the bin dir vlx-term injected via env; re-prepend it
# so the built-in vlx-spawn / view commands resolve. VLX_BIN_DIR is a Windows path -> convert.
if [ -n "$VLX_BIN_DIR" ] && command -v cygpath >/dev/null 2>&1; then
  __vlx_bin="$(cygpath -u "$VLX_BIN_DIR" 2>/dev/null)"
  if [ -n "$__vlx_bin" ]; then
    case ":$PATH:" in
      *":$__vlx_bin:"*) ;;
      *) PATH="$__vlx_bin:$PATH"; export PATH ;;
    esac
  fi
  unset __vlx_bin
fi

# Commands that live only in the full Git Bash (the minimal bundle ships bash + core GNU tools).
# Point the user at the one-click download instead of a bare "command not found".
command_not_found_handle() {
  case "$1" in
    git|gitk|git-*|ssh|ssh-keygen|ssh-add|scp|sftp|curl|wget|perl|openssl|gpg|vim|vi|nano|node|npm)
      printf '%s\n' "heddle: '$1' needs the full Git Bash (git/ssh, incl. ssh key login) -- get it from the tab-bar Shell menu (Download full Git Bash)." >&2
      return 127 ;;
  esac
  printf '%s\n' "bash: $1: command not found" >&2
  return 127
}
