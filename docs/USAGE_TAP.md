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
- **Gemini** → NOT from the tap. Sourced from the Antigravity CLI: `agy -p "/quota" --output-format json`
  (read-only print mode, agy ≥ 1.1.11), cached to `~/.heddle/usage/gemini.json` in the tap format
  and refreshed out-of-band when stale. Details in "Gemini source" below.
- **Cursor** → NOT from the tap. Sourced from cursor.com's own `usage-summary` JSON API with the local
  Cursor logins (IDE `state.vscdb`; cursor-agent macOS Keychain, opt-in), cached to
  `~/.heddle/usage/cursor.json`. Details in "Cursor source" below.
- **Claude, per account** → the tap's `claude-<acctId>.json` files + `~/.heddle/accounts.json`
  (see "Multi-account" and "Claude source" below).
- **Every poll** also mirrors the assembled `Vec<ProviderLimit>` to `~/.heddle/usage/limits.json`
  (`{writtenAt, limits}`) so out-of-process consumers (heddle-core's cap-aware router) read the SAME
  contract as the drawer; `src-tauri/tests/fixtures/heddle_stats/limits.golden.json` pins that JSON.

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
| `staleAfterSecs` | int? | the freshness expectation used (claude/tap 600s, codex 300s, gemini 600s, cursor 900s) so the UI can tick it live |
| `note` | string? | English diagnostic caveat about the payload (e.g. a window the provider stopped exposing) — same category as backend error strings; for UI copy localize via `noteCodes` |
| `noteCodes` | string[]? | stable dot-namespaced codes for every condition in `note` (`codex.no5hWindow`, `codex.noData`, `codex.legacyMode`) — the translation-key layer; `null` when the source has no notes concept |
| `accounts` | `AccountLimit[]?` | per-account rows for multi-account providers (claude 4 · codex 2 · cursor 2 today), ONE shape for all: `{id, label, plan?, capturedAt?, stale?, fiveHour, sevenDay, windows[], limitReached?, note?, noteCodes[], detail?}` — `id` is a stable key (claude: registry id `acct1`; codex: wham `account_id`; cursor: `cursor-ide` / `cursor-agent-keychain`), `label` a **masked** email (`m…@example.com`) or the id, `capturedAt`/`stale` judged per account, `detail` provider-specific raw facts (documented per source below). Account codes: `claude.noCapture`, `claude.limitReached`, `codex.accountFetchFailed`, `codex.rateLimitReached`, `codex.spendControlReached`, `codex.overageLimitReached`, `cursor.includedApiExhausted`, `cursor.includedTotalExhausted`, `cursor.onDemandLimitReached`, `cursor.tokenExpired`, `cursor.tokenExpiringSoon`, `cursor.fetchFailed` |
| `fableWeeklyEstimatePct` | number? | Claude only (the active account's): estimated share of the WEEKLY cap consumed by Fable models, in percentage points (Fable's soft cap is 50%). `null` until ≥3 attributed samples, or N/A. An **estimate by design** — see "Fable weekly estimate"; exact when the payload carries a Fable-scoped window |
| `fableWeeklySamples` | number? | the number of attributed samples behind the estimate (its confidence); `null` for other providers. Both fields also appear on every Claude `accounts[]` row (with the breakdown in `detail.fableWeekly`) |
| `activeAccount` | string? | the `accounts[].id` whose numbers the top-level `fiveHour`/`sevenDay`/`windows` show — the account this process/dispatch is on (claude: `CLAUDE_CONFIG_DIR` → registry, else the default; cursor: the cursor-agent login, which is what heddle's dispatches bill); `null` when the top level is a binding (max) view (codex) or unknown |
| `windows` | `NamedWindow[]?` | extra named windows beyond 5h/7d, binding across accounts: `{id, label, usedPercentage?, resetsAt?, usedAmount?, limitAmount?, unit?}` — `null` when the provider has no such notion, `[]` when it does but none are present |

All of these commands touch the filesystem (and the ledger's SQLite), so they are `async` and run on
the blocking pool — never on the main thread (README "Contributing").

### `heddle_refresh_provider_limits(provider?)` → `string[]`

Forces an out-of-band refresh of a provider's source (or all refreshable ones when `provider` is
omitted), ignoring the staleness thresholds; returns the providers a refresh was kicked for
(`codex`, `gemini`, `cursor`). It is non-blocking — re-poll `heddle_provider_limits` a few seconds later.
Claude is tap-driven (a session must render its statusline) so it is never in the list. This is the
backend for per-provider refresh buttons.

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
  when it is >90s old (one child at a time, reaped, at most once a minute so a broken helper can't
  pile up processes), and flags `stale: true` if it hasn't refreshed in 300s (network down, expired
  login, helper missing). An account whose fetch failed (`data: null`) keeps its row with a note
  instead of vanishing.
- **Named windows**: `additional_rate_limits[]` buckets are keyed by the provider's stable
  `metered_feature` (fallback: slug of `limit_name`, then position) + `-5h`/`-7d`, so display-name
  changes never merge unrelated buckets. Windows without a positive `limit_window_seconds` are
  skipped rather than guessed into a slot; two windows landing in the same slot keep the higher %.
- **Fixtures/tests**: `src-tauri/tests/fixtures/heddle_stats/claudex-usage-cache.*.json` (fake
  identities) + `cargo test --lib heddle_stats`. A machine-dependent live smoke test prints the real
  JSON: `cargo test --lib heddle_stats::codex -- --ignored --nocapture`.

## Gemini source (`heddle_stats/gemini.rs`)

- **What agy exposes**: since 1.1.11 the read-only slash commands answer non-interactively in print
  mode — `agy -p "/quota" --output-format json` (also `/usage`, `/credits`) — "without starting an
  agent turn, spending quota, or leaving a conversation behind" (agy changelog; live-verified 1.1.13
  on 2026-08-15). It forces a quota reload against Google's Code Assist endpoint using agy's own login
  and returns `command.data.groups[]`, each with `buckets[]`:
  `{id, window: "5h" | "weekly", remaining_fraction, reset_time (RFC3339)}`. Two groups today:
  **Gemini Models** (`gemini-5h`, `gemini-weekly` — what heddle routes to → the entry's 5h/7d) and
  **Claude and GPT models** (`3p-5h`, `3p-weekly` — Antigravity's third-party bucket → extra
  `windows[]` with ids `3p-5h` / `3p-weekly`). `usedPercentage` = `(1 − remaining_fraction) × 100`;
  `resetsAt` = `reset_time` as epoch seconds. A bucket without `remaining_fraction` (agy shows those
  as "Disabled") is an empty window.
- **Never starts a sign-in (HED-114)**: this refresh is a detached, headless child with piped stdio on
  a 180s timer, so it can never *complete* an interactive login — therefore it must never *start* one.
  `agy` begins an OAuth flow (opening a browser, asking for a paste-back code) whenever the HOME it
  inherits has no Antigravity profile; that happened live when the app ran with `HOME` pointed at a
  test fixture, and the unanswerable prompt hung to the 45s budget, backed off, and repeated — asking
  the operator to sign in over and over into a flow that structurally could not finish. Two layers:
  1. **Profile precondition** — no spawn at all unless `$HOME/.gemini/antigravity-cli` already exists
     (agy *creates* that directory as part of first-run sign-in, so its absence means "a refresh would
     prompt"). Blocked with `gemini.noProfile`, which names the HOME and says to run `agy` once in a
     terminal. This one is refused even for the drawer's refresh button.
  2. **Sticky auth block** — any attempt whose failure looks like it needed a human (the run timing
     out, or an error naming sign-in/OAuth/credentials/browser) sets `authBlocked` in the snapshot and
     stops *automatic* refreshes (`gemini.authBlocked`, with the original error). The drawer's refresh
     button may retry once (an explicit human action, at most one prompt); a successful run clears it.
  Being wrong here costs a stale gauge; being wrong the other way hijacks the operator's browser on a
  timer, so both layers fail toward "don't run".

  **Known limit — layer 1 is necessary, not sufficient.** A profile directory proves `agy` *started*
  once, never that a human *finished* signing in, so a HOME whose sign-in was abandoned still passes
  layer 1 and the first refresh there can raise one prompt. This is measured, not assumed: on the
  fixture HOME from the live incident (Agent T, 2026-08-16), every file `agy` writes — `installation_id`,
  `jetski_state.pbtxt`, `conversation_summaries.db`, the whole `antigravity-cli/` tree — was created in
  the first seconds of the *aborted* flow, and is therefore also present in a signed-in HOME. There is
  no known artifact that separates the two states. (`~/.gemini/gemini-credentials.json` looks like the
  discriminator and is not: it belongs to the older `gemini` CLI — on this machine it predates the `agy`
  install by a month.) Two other candidates were measured and rejected: `jetski_state.pbtxt` is
  write-once, so its mtime is a "first init" stamp rather than a "last attempt" clock; and after the
  first ~15 minutes the failing loop stopped touching the HOME **entirely** while still prompting, so
  any mtime-derived backoff would read "last attempt hours ago, safe to retry" in the middle of an
  active prompt loop. `agy` also exposes no documented non-interactive-auth flag (`agy --help`,
  v1.1.11) to probe with instead. So layer 2 is what actually bounds the damage: **at most one prompt
  per HOME state, then automatic refresh is paused until a human clicks the refresh button.** The
  incident being closed is the *repeat* — a prompt every 180s, forever — not the first one.
- **Cost / cadence**: ~3s wall clock and a few Google round trips per run, so it never runs inline.
  `heddle_provider_limits` reads the snapshot and, when it is older than 180s, kicks ONE detached
  refresh thread (`agy … --log-file /dev/null`, so no log file per run under `~/.gemini/…/log/`; 45s
  budget) that rewrites `~/.heddle/usage/gemini.json` atomically. `stale: true` after 600s without a
  successful refresh; a failed run records `lastError`/`lastAttemptAt` in the snapshot (surfaced as
  `note` + `noteCodes` `gemini.refreshFailed` / `gemini.noDataYet`) and backs off 120s. The
  refresh button (`heddle_refresh_provider_limits("gemini")`) forces one immediately.
- **Snapshot format**: tap-compatible (`model: "antigravity"`, `rate_limits.five_hour/seven_day`,
  `capturedAt`) so anything reading `~/.heddle/usage/*.json` sees Gemini like Claude, plus `source`,
  normalized `groups[]`, and the raw agy `data`. The tap reader skips `gemini.json`; `gemini.rs`
  reads it back with the extras.
- **Fixtures/tests**: `src-tauri/tests/fixtures/heddle_stats/agy-quota.json` (a real answer, no
  PII) + `cargo test --lib heddle_stats::gemini`; live: `cargo test --lib heddle_stats::gemini --
  --ignored --nocapture` (runs the real agy; the refresh test writes the real snapshot).

## Cursor source (`heddle_stats/cursor.rs`)

- **Endpoint**: `GET https://cursor.com/api/usage-summary` — the JSON API cursor.com's own dashboard
  reads (and the maintained MIT extension `numanaral/cursor-usage-stats`, 2026-07), authenticated with
  the LOCAL Cursor session: cookie `WorkosCursorSessionToken=<userId>::<jwt>` (`userId` = last `|`
  segment of the JWT `sub`). Same category as the Codex source (a provider's own JSON API, not HTML
  scraping). Live-verified for both accounts 2026-08-15. Money is in **cents**.
- **Two included pools + on-demand** (per Cursor's pricing page and this payload): the included
  allowance has a TOTAL pool that Auto and Cursor models (Grok, Composer — heddle's default Cursor
  routes) draw from — Cursor states it as `plan.totalPercentUsed` ("You've used 17% of your included
  total usage") — and an API sub-pool for named third-party models (kimi, …) — `plan.apiPercentUsed`
  ("You've used 87% of your included API usage"), with `plan.used/limit/remaining` describing that
  sub-pool in dollars (Ultra: `limit` 40000¢ = the $400 "Other Models" allowance). `onDemand
  {enabled, used, limit, remaining}` = usage-based spend vs the spend limit (legacy name `overall`).
  We surface Cursor's own numbers; no arithmetic of our own where the provider states the figure.
- **Windows per account**: `included-total` (`totalPercentUsed`; Cursor doesn't expose this pool's
  dollar size → no amounts), `included-api` (`apiPercentUsed`; amounts = `plan.used`/`plan.limit` in
  USD), `usage-based` (`onDemand.used/limit`% when enabled; amounts in USD); all reset at
  `billingCycleEnd`. Notes lead with Cursor's two display strings, then `cursor.includedApiExhausted`
  (`plan.remaining` 0 / `apiPercentUsed` ≥ 100: named third-party models bill on-demand),
  `cursor.includedTotalExhausted` (`totalPercentUsed` ≥ 100: Auto/Cursor models too),
  `cursor.onDemandLimitReached`, `cursor.tokenExpired` / `cursor.tokenExpiringSoon` (<7d),
  `cursor.fetchFailed` (last-known numbers kept). `limitReached` = "heddle's default Cursor routes
  fail here": on-demand capped out, or on-demand off with the TOTAL pool gone. `detail` = the raw
  `plan` / `onDemand` objects, `membershipType`, `billingCycleStart/End` (epoch s), the display
  messages, `tokenExpiresAt`, `fetchedAt`, `source`.
- **Which window gates what (router, HED-67)**: `included-total` → `cursor-grok-*` / `composer-*` /
  auto; `included-api` → kimi-class named third-party models (second-opinion-hard); `usage-based`
  hard stop (`onDemand.enabled && remaining == 0`) → everything that would bill on-demand.
- **Accounts**: (1) the **Cursor IDE** login — token read (read-only) from the IDE's `state.vscdb`
  (`cursorAuth/accessToken`, `cachedEmail`, `stripeMembershipType`; macOS/Linux/Windows paths) — always
  on; (2) the **cursor-agent CLI** login — token only in the macOS Keychain (`cursor-access-token`),
  read via `/usr/bin/security find-generic-password -w` (the pattern upstream already uses for the
  Claude Code item), which pops a one-time macOS "allow access" prompt → **opt-in**:
  `~/.heddle/usage-sources.json` → `{"cursor": {"keychainCli": true}}` (default off; a failed read
  backs off an hour so a 30s poll never nags). Tokens never leave the module (not logged, not in the
  snapshot, not in error text) and are never refreshed by us — an expired session becomes a note
  telling you to sign in to Cursor / run `cursor-agent login`. **Active account** = the cursor-agent
  login (what heddle's dispatches bill) when its row exists → `activeAccount` + the top-level
  `windows`; with only the IDE login known the top level is the binding (max) view and
  `activeAccount` is `null`.
- **Cadence**: refresh when the snapshot is >180s old (one detached thread, atomic write, 15s HTTP
  timeout, honest `User-Agent: heddle-dashboard/<ver>`), `stale` after 900s, failure backoff 300s;
  `heddle_refresh_provider_limits("cursor")` forces one. Provider notes: `cursor.noAccounts`,
  `cursor.refreshFailed` / `cursor.noDataYet`.
- **Fixtures/tests**: `src-tauri/tests/fixtures/heddle_stats/cursor-usage-summary.json` (a real Ultra
  answer, no PII) + `cargo test --lib heddle_stats::cursor`; live: `cargo test --lib
  heddle_stats::cursor -- --ignored --nocapture` (writes the real snapshot).

## Multi-account (added 2026-08-15)

Maya has 4 Claude Max20 accounts, registered in `~/.heddle/accounts.json` (`claude[]`: id, configDir
— `null` = the default `~/.claude`, email, loggedIn). Each was logged in once via
`CLAUDE_CONFIG_DIR=<dir> claude /login` (macOS keeps each credential in the Keychain; official
multi-account mechanism per the Claude Code env-vars docs). **Gotcha:** never set
`CLAUDE_CONFIG_DIR=~/.claude` explicitly for the default — leave it unset.

- The tap keys its captures **per account**: it maps the session's `CLAUDE_CONFIG_DIR` to an account id and
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

## Claude source (`heddle_stats/claude.rs`) — per account

- Reads the registry `~/.heddle/accounts.json` (`claude[]`) and each `~/.heddle/usage/claude-<id>.json`
  the tap writes; the legacy `claude.json` (last session that rendered, any account) is the fallback.
- **Top level = the ACTIVE account** — the one whose `configDir` matches this process's
  `CLAUDE_CONFIG_DIR` (canonicalized), else the default (`configDir: null`), else the first — named in
  `activeAccount`, so the summary bar stays "the account you're on". If the active account has no
  capture yet, the legacy file keeps the summary populated.
- `accounts[]`: one row per registered account in registry order (`id` = registry id, `label` = masked
  email, own `fiveHour`/`sevenDay`, own `capturedAt`/`stale` (600s), `limitReached` when a window is at
  ≥100% → `claude.limitReached`, `claude.noCapture` when the account has no file yet,
  `detail = {account, configDir, model}`), plus rows for any `claude-unknown-<dir>.json` the tap wrote for
  an unregistered config dir. Without a registry the entry is the plain single-file tap entry
  (`accounts: null`).
- Tests: `cargo test --lib heddle_stats::claude` (registry + tap files in a scratch dir).

## Fable weekly estimate (`heddle_stats/fable_attrib.rs`) — HED-75

Fable is capped at **50% of an account's weekly allowance**, but no readable surface exposes a
Fable-specific window: the statusline payload — and therefore the tap's `claude-<acct>.json` — carries
only `five_hour` / `seven_day` (verified 2026-08-15). So heddle builds an **estimate** from what the tap
does record on every capture: the `model` of the rendering session and the account-wide
`seven_day.used_percentage`.

- **Attribution**: on every poll, each account's newest capture is compared with the previous capture
  heddle ingested for that account; the delta in weekly used% is attributed to the model that rendered
  the newer capture (`fable-*` → Fable, else Other). Persisted per account in
  `~/.heddle/usage/claude-<acct>.attrib.json` (atomic).
- **Honesty rules** (all unit-tested on capture sequences): the same capture is never counted twice; a
  new weekly window (`seven_day.resets_at` moved) starts the books over — what was already used at the
  first capture of a window is `unknown`, not attributed; a gap longer than 10 min between ingested
  captures (the app wasn't watching) sends that delta to `unknown` rather than to whichever model
  rendered next; a downward correction inside a window shrinks the buckets proportionally; the
  estimate is `null` until ≥3 positive samples were attributed, and the sample count is always shown
  next to it. Interleaved sessions on one account (Fable and Haiku both rendering) still blur the
  attribution — this is a best-effort signal for a soft cap, not an accounting record.
- **Exact when possible**: if a `rate_limits` key mentioning `fable` with a `used_percentage` ever
  appears in the payload (the tap captures `rate_limits` verbatim), that value is used as-is and
  `detail.fableWeekly.exact` is `true` — nothing else needs to change.
- **Exposure**: `fableWeeklyEstimatePct` + `fableWeeklySamples` on every Claude `accounts[]` row and, for
  the active account, on the claude `ProviderLimit`; `detail.fableWeekly = {fablePct, otherPct,
  unknownPct, samples, exact, minSamples, windowResetsAt, lastCapturedAt, updatedAt}`. The drawer's bar
  ("Fable ≈NN% of weekly (est.)", soft-limit tick at 50%) is Agent R's; it should render only when the
  estimate is non-null.

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

## Working on this repo from an agent worktree (fleet note)

`heddle-dashboard` is a fork: `origin` = `mmayasaurus/heddle-dashboard`, `upstream` = `vlinx-io/VelaTerm`.
`gh` resolves the **upstream** as the default repo unless told otherwise, so `gh pr create`,
`gh pr list`, and `pr-linear-sync.sh` silently target VelaTerm. Run once per clone (worktrees share
it): `gh repo set-default mmayasaurus/heddle-dashboard`. A fresh worktree also needs an empty `dist/`
before `cargo check` (rust-embed requires the folder), and can share the main checkout's compiled
deps with `CARGO_TARGET_DIR=<main checkout>/src-tauri/target`.
Contract changes: keep them additive, then regenerate the golden with
`cargo test --lib heddle_stats::tests::write_golden -- --ignored` and tell the consumers (Agent R's
drawer, heddle-core's router) — `contract_json_matches_the_golden_file` fails otherwise.
