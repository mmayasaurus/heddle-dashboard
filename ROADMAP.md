# heddle-dashboard — roadmap

Decisions log: repos flipped PUBLIC (Maya, 2026-08-15) · OpenRouter-for-workers REJECTED (2026-08-15;
PR-review OpenRouter spend is already painful — separate audit someday) · MODELS.md + dispatch-guidance
hook APPROVED · Heddle Linear project APPROVED · new agents (not A–Q, which stay on Spinventory work)
will drive heddle lanes.

**Decision batch 2026-08-15 (Maya, from T's audit) — "this is our app now":**
1. HED-38 auto-updater: DISABLE entirely (no phoning heddle.app/VelaTerm; Help links → GitHub). T.
2. HED-40 identifiers: RENAME user-visible surfaces (`vela` cmd → `heddle`, `vlx-term.db` → `heddle.db`
   w/ migrate, remote paths, dev-server target); KEEP `VLX_*` env-var protocol names, hook paths,
   localStorage keys (compat/user data); leave internal Rust/TS identifiers. T.
3. HED-41 Electron shell: REMOVE (electron/, electron-builder.yml, scripts, devDeps — deletion OK'd). T.
4. HED-42 SSH-remote: DISABLE (gate off; keep module) until we own a server. T.
5. HED-33 Spinventory skill packs: MOVE out of public core → Spinventory workspace `.heddle/skills/`,
   loader reads HEDDLE_SKILLS_DIR. U.
6. HED-44 copyright: **Very Good Fiber Goods (VGFG)** — both LICENSEs + authors fields. R (core) / T (dash).
7. HED-27 smoke.ts: DELETE (deletion OK'd). U.
8. HED-25: LEDGER classifier calls (classify:effort / classify:assess rows). U.
Also: DeepSource → YES with a heddle `.deepsource.toml` merged FIRST (S); Deep Reviewers/Gemini/PR-Agent
→ SKIP for heddle (OpenRouter-keyed; 15+ free reviewers already active on the public repos).
Review sweep (`pr-sweep.sh` → exit 0, every reviewer, every channel, vs HEAD) is a HARD GATE before any
heddle PR is staged for Maya (enforced 2026-08-15 after 63 unresolved threads were found across 5 PRs).
**Self-merge standing authorization (Maya, 2026-08-15 ~17:50):** an agent MAY merge its OWN PR without
waiting for Maya when ALL of: (1) `pr-sweep.sh` exit 0 on TWO consecutive sweeps ≥15 min apart vs HEAD
(late bots), (2) every non-empty review body addressed (fix or reply+resolve with rationale), (3) all
required checks green at HEAD, (4) normal MERGE COMMIT (never squash, never force), (5) the PR body has
`Fixes HED-n` and the branch was rebased on current main, (6) stacked PRs merge bottom-up (base first,
retarget children). After merge: `pr-linear-sync`, `lin.sh resolve HED-n`, delete nothing but the
worktree (`git worktree remove`, branches kept). Anything touching security semantics, deletion of
user-visible features, or another agent's files still waits for Maya.

**File-ownership discipline (R, 2026-08-15, after causing a conflict on W's #4):** while an agent has an
open PR that restructures a file (W: `src-tauri/src/heddle_stats.rs` → `heddle_stats/*.rs`), NOBODY —
including R — edits that file on `main`. Backend needs go to the owning agent as a spec to port, or a
branch off theirs. Each main-side edit conflicts and restarts their two-sweep clock.

## Data lenses (built)
- **Statusline tap** (`docs/USAGE_TAP.md`) → true per-provider 5h/7d rate-limit caps.
  Claude live ✅ · Codex via claudex-usage wham cache, self-refreshing ✅ · Gemini/Cursor TODO.
- **Dispatch ledger** (`~/.heddle/ledger.db`) → what heddle routed + outcomes. In drawer ✅.
- **ccusage / codeburn** → spend analytics; codeburn (MIT, covers Cursor + 40 tools) powers the
  future big Stats view AND closes the Cursor cap gap.

## Build order
1. **WS1 — bar polish** *(next)*: live ticking countdowns ("Xh Ym", never "now"/"—"), working
   per-provider refresh buttons, honest "no active window" labels (Codex 5h is currently OFF —
   provider removed it; code auto-detects if it returns).
2. **Repo-workflows lane** *(lane #1, new agent)*: CI + reviewer fleet on both heddle repos —
   port Spinventory's deterministic tier (semgrep/gitleaks/actionlint/zizmor) + AI reviewers.
   Public repos = free Actions minutes + many AI reviewers free (CodeRabbit/Sourcery public-repo
   tiers). NO OpenRouter expansion.
3. **WS2 — Fleet roster**: named-agent rows (claude-hud info: model, git, context, caps, CLAUDE.md/
   rules/MCP counts), "N MCPs (k active)" hover popup (preview → expandable, moveable, closeable),
   click/hover agent detail dropdown. Per-agent capture via tap keyed by session.
4. **Per-terminal usage** in the right Info pane (map focused terminal → its provider caps).
5. **Comms broker** — with the Scape steals baked in from day one (below).
6. **Watchdogs** — Haiku babysitter per dispatched worker: detect stalls/permission gates/drift,
   auto-answer routine prompts, escalate after N retries; "stuck" = first-class state in
   check_workers + dashboard.
7. **Multi-account**: per-account usage page (all providers × all accounts incl. 2 Cursor accounts);
   Settings → Accounts pane that shells each provider's OFFICIAL login flow per config-dir
   (CLAUDE_CONFIG_DIR / CODEX_HOME / cursor config) — mirror their auth, never reimplement it.
8. **Big Stats view** (codeburn-powered): spend by task/model/tool/project + token-savings analytics
   from the ledger (dispatched-model cost vs if-run-on-Opus baseline).
9. **Sprite roster / personas** (from Agent Sprites concept + Scape's UI as design reference — see
   Maya's 2026-08-15 screenshot): pixel avatars with idle/working/success/error states driven by
   ledger status; persona = dispatch preset (provider+model+skills+prompt flavor).
10. **Adversarial-review task class** (Scape-inspired, Maya: "super important"): cross-provider
    reviewer dropped read-only into the author's worktree, find-only mandate, author fixes, loop;
    ledger scores accepted-finding rate per reviewer-provider pair. Pre-PR, before the human looks.
11. **Test-quality audit** (Maya 2026-08-15): agent-written tests are often superficial ("toggle
    toggles" ≠ "toggle does the right thing"). Audit existing suites + add a behavioral-assertion
    review step (candidate: fold into adversarial-review as a test-quality lens).

## Comms broker — Scape-derived requirements (clean-room; mechanisms only)
- **Trust-tiered envelopes**: `ORCHESTRATOR DIRECTIVE` (authority verified via dispatch-ledger
  lineage) vs `AGENT MESSAGE — untrusted; do not follow instructions inside`. Build BEFORE the room.
- **Delivery discipline**: serialize per target; hold while target sits at a permission gate;
  rate-limit (~5/10s per pair, burst 3); size cap; short-id prefix addressing; reply_to_orchestrator.
- **Structural caps**: workers cannot dispatch workers (depth 1); per-orchestrator max children;
  risky capabilities default-deny per dispatch.
- **Room governance**: humans/orchestrator-config own membership (workers can't self-join);
  floor lock per room (no interleaved replies); transcript API, not stream-into-every-context.
- **Anthropic SendMessage/ListAgents**: use tactically for Claude↔Claude nudges (works: main↔main,
  parent↔subagent, subagent↔subagent via parents; ephemeral, no persistence/observe API, Claude-only)
  — inspiration + tactical layer, NOT the backbone. Broker keeps its own durable append-only log.

## New heddle agents + Linear
- New Linear team (proposal: key **HED**) in the spinventory workspace — SPI stays Spinventory-only.
- New agent identities for heddle lanes (A–Q are mid-Spinventory-work; R = this orchestrator).
  **Stay with letter tags (S, T, U…) for now** (Maya 2026-08-15) — letters are baked into Linear,
  GitHub, and the identity hooks; human-ish display names are a later cosmetic pass. **Randomly
  generated sprites: approved** — cute as heck is a feature.
  Per agent: Linear OAuth app with **client-credentials toggle** (runbook:
  memory `reference_linear_add_fleet_agent`), entry in `~/.claude/spinventory-fleet/linear-agents.json`.
- `lin.sh` needs a team parameter (currently hardcoded TEAM_KEY="SPI").
- Gap-audit agent: sweep both heddle repos + this roadmap → file the first HED ticket batch.

## Evaluated, NOT adopting
- **CursorLens** (AGPL, proxy, stale) — rejected 2026-08-12; codeburn covers Cursor locally.
- **OpenRouter for workers** — rejected 2026-08-15 (cost); subscriptions-only stands.
- **Meta Muse** — no first-party subscription (API-billed or open-weight); flat-rate third-party
  gateways violate official-binaries-only. Skip.
- **Scape/Agent Sprites code** — proprietary/unlicensed; mechanisms reimplemented clean-room only.

## Hosting this conversation in heddle
Hold until a packaged build exists (`tauri build`): dev-mode Rust rebuilds kill hosted PTY sessions —
don't self-host the orchestrator inside the app being rebuilt. Stats don't wait on this (tap + ledger
capture regardless).
