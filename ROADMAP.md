# heddle-dashboard — usage & stats roadmap

What makes this more than a rebranded terminal: surfacing heddle's orchestration + real
provider-cap usage. Three complementary data lenses, kept distinct:

- **ccusage** (installed at `~/.bun/bin/ccusage`, JSON output) → true rolling **5h / weekly cap
  usage vs limits**, per provider/model (claude, codex, gemini, …). Does **not** cover Cursor.
- **heddle ledger** (`~/.heddle/ledger.db`, read via bundled `rusqlite`) → what heddle *dispatched*
  + outcomes (orchestrator, task class, provider/model, tokens, pass/fail, in-flight).
- **codeburn** (MIT, `npx codeburn`) → rich spend breakdown by **task/model/tool/project across 40
  tools incl. Cursor**; foundation for the big stats view AND the fix for the Cursor gap.

## Build order
1. **Fleet drawer** — center-pane bottom, collapsible + scrollable. Top: ccusage cap bars (5h +
   weekly, per provider). Below: ledger (in-flight + recent dispatches). Rust shells `ccusage
   --json` + reads the ledger → Tauri commands → React drawer, refreshed on a timer. **[IN PROGRESS]**
2. **Per-terminal usage** — enhance the right **Info** pane with the focused terminal's
   provider/model + usage bars (map terminal → ccusage session).
3. **Big Stats view** (Maya, 2026-08-12) — a dedicated rich stats surface (separate window OR
   full-screen tab): spend by task/model/tool/project, waste-finding, history. Powered by / adopted
   from **codeburn** (MIT). Covers Cursor, closing the gap from step 1.

## Evaluated, NOT adopting
- **CursorLens** (AGPL-3.0, `HamedMP/CursorLens`) — REJECTED: AGPL copyleft would force the whole
  app to AGPL; it's a heavy *proxy* (Next.js + Postgres + ngrok, reconfigures Cursor's API
  endpoint); last pushed 2024-11; targets the Cursor IDE, not `cursor-agent`. codeburn covers Cursor
  locally with no proxy — use that instead.

## To verify before wiring
- codeburn machine-readable output (`--json` / a library entry) for clean embedding; else parse its
  tables or lift its MIT parsing core.
- ccusage `--token-limit max` is an **estimated** ceiling (Anthropic doesn't publish exact caps) —
  label the bars honestly ("vs. your typical max", not an official limit).
- Distribution note: ccusage/codeburn are external CLIs. Fine for local/GitHub use; if heddle is ever
  packaged, either document the dependency or bundle it.
