# Usage tap — capturing live provider rate-limits for the Fleet drawer

The Fleet drawer shows **true rolling rate-limit usage per provider** (the same numbers your Claude
Code statusline shows), not a spend estimate. That data lives only in the statusline stdin payload
Claude Code hands its statusline renderer, so heddle captures it with a **passthrough tap**.

## How it works

`~/.heddle/usage-tap.mjs` (canonical copy: `scripts/heddle-usage-tap.mjs`) sits in front of the
statusline renderer (claude-hud). It reads the JSON payload Claude Code pipes in, writes it **straight
back to stdout unchanged** (claude-hud renders byte-identically), and on the side records `rate_limits`
+ model to `~/.heddle/usage/<provider>.json`.

- **Claude** → `~/.heddle/usage/claude.json` — `five_hour` / `seven_day` (`used_percentage`, `resets_at`
  in epoch seconds).
- **Codex/GPT** → NOT from the tap. Sourced from `claudex-usage`'s cache
  (`~/.local/state/claudex-usage-cache.json`, per-account `chatgpt.com/backend-api/wham/usage`). heddle
  reads it and **self-refreshes** it (`claudex-usage --refresh lb`) when it's >90s stale, so it stays
  current even when no claudex session is rendering.
- **Gemini / Cursor** → TODO (each needs its own source: `agy` usage, Cursor's API).

The dashboard's `heddle_provider_limits` Tauri command reads all of the above and returns them to the
`FleetDrawer`, which renders one column per provider (5h over 7d, segmented `█░` bars).

## Install (already wired on this machine)

The tap is inserted into `~/.claude/settings.json` → `statusLine.command`, as
`"$BUN" ~/.heddle/usage-tap.mjs | <original claude-hud command>`. The original settings are backed up
at `~/.claude/settings.json.bak-heddle-<timestamp>`.

⚠️ **A session only captures once it started AFTER the tap was installed** — running sessions cache
the statusline command at startup. New/cycled agents populate `claude.json` automatically.

## Revert

`cp ~/.claude/settings.json.bak-heddle-<timestamp> ~/.claude/settings.json` — or just delete the
`"$BUN" .../usage-tap.mjs | ` prefix from the `statusLine.command`. The tap is a pure passthrough, so
removing it changes nothing about how the statusline renders.

## Multi-account (added 2026-08-15)

Maya has 4 Claude Max20 accounts, registered in `~/.heddle/accounts.json` (`claude[]`: id, configDir
— `null` = the default `~/.claude`, email, loggedIn). Each was logged in once via
`CLAUDE_CONFIG_DIR=<dir> claude /login` (macOS keeps each credential in the Keychain; official
multi-account mechanism per the Claude Code env-vars docs). **Gotcha:** never set
`CLAUDE_CONFIG_DIR=~/.claude` explicitly for the default — leave it unset.

- The tap keys captures **per account**: it maps the session's `CLAUDE_CONFIG_DIR` to an account id and
  writes `claude-<acctId>.json` alongside the legacy `claude.json` (drawer compat).
- **Window-keeper** (`scripts/heddle-window-keeper.py`, installed at `~/.heddle/window-keeper.py`,
  launchd `io.heddle.window-keeper`, every 5 min): the 5h window is a rolling window anchored to the
  first request (empirical: `resets_at` on odd minutes), so one ~10-token haiku ping starts an
  account's clock. The keeper pings any account whose window is EXPIRED/UNKNOWN, **staggered 75 min
  apart** so a fresh window opens roughly every 75 min around the clock — always an account about to
  reset for the fleet to rotate onto. **Verified:** pinging a LIVE window does not move `resets_at`
  (`--verify acct2`, 2026-08-15) — the keeper only starts windows, never shifts them. `--dry-run`
  prints decisions. Never uses Fable/Opus.
- Router (HED-68) picks the account with the most 5h headroom; the drawer shows all accounts under
  `claude` with the active one in the summary bar (W, `activeAccount`).
