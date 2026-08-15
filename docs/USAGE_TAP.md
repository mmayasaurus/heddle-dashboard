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
  (`~/.local/state/claudex-usage-cache.json`, per-account `chatgpt.com/backend-api/wham/usage` — the
  endpoint the native Codex CLI uses for `/status`). heddle reads it and **self-refreshes** it
  (`claudex-usage --refresh lb`) when it's >90s stale, so it stays current even when no claudex session
  is rendering. Details in "Codex source" below.
- **Gemini / Cursor** → TODO (each needs its own source: `agy` usage, Cursor's API).

The dashboard's `heddle_provider_limits` Tauri command (`src-tauri/src/heddle_stats/`) reads all of
the above and returns them to the `FleetDrawer`, which renders one column per provider (5h over 7d,
segmented `█░` bars).

## The `heddle_provider_limits` contract (additive-only)

`heddle_provider_limits` → `Vec<ProviderLimit>` (camelCase JSON). The first five fields are the
original shape; everything after them is **optional and additive** — new providers are new entries,
new fields are `Option`, existing fields are never renamed/removed/retyped. Consumers should ignore
keys they don't know.

| field | type | meaning |
|---|---|---|
| `provider` | string | `claude` · `codex` · … (drawer order: claude, codex, then alphabetical) |
| `model` | string? | subtitle — the model seen by the tap, or e.g. `chatgpt · 2 acct` |
| `capturedAt` | epoch s? | when the numbers were captured / fetched |
| `fiveHour`, `sevenDay` | `{usedPercentage?, resetsAt?}` | the rolling windows (`resetsAt` epoch **seconds**) — the binding (max) view across accounts for multi-account providers |
| `source` | string? | `statusline-tap` · `claudex-usage-cache` · … |
| `stale` | bool? | `capturedAt` is older than `staleAfterSecs` (judged at read time; `null` when there is no capture time) — render dimmed/flagged, don't present as live |
| `staleAfterSecs` | int? | the freshness expectation used (tap 600s, Codex 300s) so the UI can tick it live |
| `note` | string? | human caveat about the payload (e.g. a window the provider stopped exposing) |
| `accounts` | `AccountLimit[]?` | per-account rows for multi-account providers: `{label, plan?, fiveHour, sevenDay, windows[], limitReached?, note?}` — `label` is a **masked** email (`m…@example.com`) or `acct N` |
| `windows` | `NamedWindow[]?` | extra named windows beyond 5h/7d, binding across accounts: `{id, label, usedPercentage?, resetsAt?, usedAmount?, limitAmount?, unit?}` |

## Codex source (`heddle_stats/codex.rs`)

- **Per-account rows** (`accounts[]`): one per ChatGPT account behind the claudex LB (2 today), with a
  masked email, `plan` (`prolite`/`pro`/…), its own 5h/7d windows, `limitReached`, and any
  `additional_rate_limits` (per-model buckets such as `GPT-5.3-Codex-Spark`) as `windows[]`. The
  top-level `fiveHour`/`sevenDay`/`windows` stay the **binding max** across accounts — the account
  nearest a wall is what limits you. A cache in the legacy single-account `raine` mode is handled too.
- **5h window**: wham reports `primary_window`/`secondary_window` with `limit_window_seconds`; heddle
  maps them to 5h/7d **by length**. As of 2026-08 OpenAI exposes **only the 7-day window**
  (`primary_window` = 604800s, `secondary_window` null) — the 5h bar is empty and `note` says so.
  Nothing is hard-coded: if a 5-hour window reappears in either slot it shows again automatically and
  the note clears (unit-tested with a fixture).
- **Staleness**: `capturedAt` = the cache's `fetched_at`; heddle kicks `claudex-usage --refresh lb`
  when it is >90s old, and flags `stale: true` if it hasn't refreshed in 300s (network down, expired
  login, helper missing). An account whose fetch failed (`data: null`) keeps its row with a note
  instead of vanishing.
- **Fixtures/tests**: `src-tauri/tests/fixtures/heddle_stats/claudex-usage-cache.*.json` (fake
  identities) + `cargo test --lib heddle_stats`. A machine-dependent live smoke test prints the real
  JSON: `cargo test --lib heddle_stats::codex -- --ignored --nocapture`.

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
