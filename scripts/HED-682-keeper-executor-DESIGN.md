# HED-682 credential-swap verification (cswap source clone-read + own-session probe, 2026-09-15 ~23:00Z)

Design pivot (R 2794, Maya firsthand): rotation ACTION = in-place credential swap under the RUNNING session (same window, zero restart). kill+resume DEMOTED to fallback. "Verify against current CLI, clone+read cswap, don't guess." Ref impl = github.com/realiti4/claude-swap (MIT, 2.3k★), cloned to scratchpad/cswap.

## GROUND TRUTH — my own acct4 session (read-only probe, auth-memory permits observing own session)
- `CLAUDE_CONFIG_DIR = /Users/mayatobi/.claude-acct4`; `CLAUDE_SECURESTORAGE_CONFIG_DIR` unset.
- Derived hashed keychain service = `Claude Code-credentials-b8ac112a` — **EXISTS** (`security find-generic-password` exit 0).
- Plaintext `/Users/mayatobi/.claude-acct4/.credentials.json` = **DOES NOT EXIST**.
- Unsuffixed default-login entry `Claude Code-credentials` also exists.
- **⇒ A running fleet session reads the HASHED keychain entry; it is keychain-ONLY (no plaintext file).** This is the exact posture the swap must operate on.

## THE MECHANISM — VERIFIED FEASIBLE (corrects my earlier "high-risk/infeasible" read)
credentials.py `_write_oauth_credentials` (L954-1010), the live-login OAuth write behind `cswap switch`/`auto`:
- macOS keychain usable ⇒ **writes the entry DIRECTLY**: `macos_keychain.set_password(CLAUDE_CODE_KEYCHAIN_SERVICE, keychain_account_name(), credentials)` (L976-981). Service const `"Claude Code-credentials"` (credentials.py:117).
- Hot-reload contract (L957-966, `_refresh_stale_credentials_file` L1012-1033, cswap #86): **"Claude Code invalidates its memoized OAuth token only when [the .credentials.json] mtime changes or the file is absent."** Keychain-only (fileless) users: **"their absent-file path already hot-reloads via the ~30s Keychain TTL"** — NO restart.
- ⇒ **Overwrite the hashed keychain entry with the swapped account's creds under the refresh lock; the running session picks them up within ~30s. No plaintext, no delete, no migration race.** The fleet's fileless posture is the BEST case (auto hot-reload; the plaintext-present case is the one that needs an mtime bump).

## Why cswap "never writes the hashed entry" — and why that DOESN'T block us
session.py docstring (L11-14, L255-299, L864-866): cswap's PROFILE/`run` model seeds a plaintext `.credentials.json` + deletes the stale hashed entry, letting claude re-migrate plaintext→hashed on first write; it declines to write the hashed entry itself. session.py L97: "we never pull credentials out from under a running claude." **BUT that is cswap's LAUNCH-time profile-setup model** (set up store, THEN launch claude into it) — a deliberate design boundary so claude owns per-profile migration. For the DEFAULT login it DOES write the keychain entry directly under a running claude (`_write_oauth_credentials` above = `cswap auto`'s headline feature). The fleet case = write the *hashed* service name instead of the unsuffixed one: the identical `set_password` call. Mechanism-proven; only the service string differs.

## VERIFIED cswap facts (reusable primitives)
1. Keychain service (session.py:232) = `"Claude Code-credentials-" + sha256(NFC(RAW CLAUDE_CONFIG_DIR))[:8]` (hashes the raw exported string, unresolved). Account name = `macos_keychain.keychain_account_name()` (mirrors claude getUsername()). Confirmed against my acct4 (`b8ac112a`).
2. Read override: `CLAUDE_SECURESTORAGE_CONFIG_DIR` overrides CLAUDE_CONFIG_DIR for the service derivation when DEFINED; defined-but-empty = default store (credentials.py:661-713). Fleet doesn't set it.
3. **Dual refresh lock** (claude_locks.py, vs claude-code 2.1.218): DIRECTORY mutexes. Refresh path takes TWO in CC order — `<config-home>/.oauth_refresh.lock` then legacy `~/.claude.lock`; both stale=60s, touch=5s (cswap touches @3s). `claude_credentials_lock()` acquires both, CC order (no deadlock), 60s staleness, ~9s/lock timeout. Under the lock CC's double-checked re-read sees the swapped non-expired cred and ABORTS its own refresh. `claude_config_lock()` = `~/.claude.json.lock` (stale 10s).
4. Swapped token must OUTLIVE CC's 5-min refresh buffer (autoswitch.py:13-25,770-778); cswap ensures 2×=10min validity + dead-token quarantine + systemic/transient error taxonomy. Large tested suite (test_autoswitch, test_macos_keychain_contract, test_swap_accounts).
5. `_write_account_credentials` (credentials.py:1304) = cswap's OWN slot BACKUP store (`.enc`+backup keychain items), separate from the live entry — not relevant to the live swap.
6. cswap CLI verbs: `run N` = LAUNCH claude under a profile (cwd→account via mappings.py `slot_for_directory`) = equivalent to the fleet launcher / kill+resume, NOT under-running-swap. `switch`/`auto` = under-running DEFAULT-login swap. mappings.py = cwd→(email,orgUuid) for `cswap run`, NOT a seat→account census map.

## THE CENSUS SKEW (advisor's key catch — real, engine-independent)
The swap moves the ACCOUNT, not the SEAT: put acct1's creds into `~/.claude-acct4`'s hashed entry ⇒ seat acct4 now consumes acct1's quota, but `live_census` (keeper L451, keys on `CLAUDE_CONFIG_DIR=` in `ps eww`) still attributes it to acct4, and `accounts.json`/`account_uuid_map` map dir→account by naming CONVENTION. After a swap that convention is false ⇒ `rotation_target` computes wrong loads next cycle unless the keeper tracks a seat→account mapping (updated on each swap; or reads each entry's real identity). CLAUDE_CONFIG_DIR is fixed at process launch, so swapping-into-the-seat is the ONLY under-running option — the skew is inherent to the swap and the keeper MUST own it. (Counterpoint worth raising: kill+resume re-establishes a clean seat==account identity, no persistent skew — a simplicity argument for the fallback.)

## THE FORK (for advisor → R → Maya)
- **(A) Re-implement the swap in the keeper (Python).** Core write is small + mechanism-proven (`set_password` hashed service, under the dual lock, ~30s TTL hot-reload). But the SAFE version needs cswap's whole apparatus: dual-lock cooperation, account-name derivation, token-outlives-refresh check, dead-token quarantine, displaced-cred capture for rollback. Re-deriving all that = against NEVER-REINVENT.
- **(B) Adopt cswap CLI as the engine.** Blocked as-is: its public verbs do default-login swap (R forbids touching default login) or launch-time profile setup (= kill+resume), NOT under-running HASHED-entry swap. Also Maya-gated adoption (reference-claude-swap: no install yet).
- **(C) HYBRID (my lean): keeper owns detection/target/census (already built) + reuse cswap's tested PRIMITIVES** (`macos_keychain.set_password`/account-name, `claude_locks.claude_credentials_lock`, token-validity + quarantine helpers) for the write, targeting the HASHED service name. NEVER-REINVENT-respecting (reuse proven units, not the ill-fitting CLI model). Open Q: import/vendor cswap as a lib vs port the ~4 primitive functions. Either way = Maya-gated (live credential path).
- ALL paths: dry-run first (resolve target + WOULD-swap log, NO keychain write) → Maya deploy nod → separate keeper redeploy gate. Merge = security-semantics, Maya-gated, NOT self-merge.

## R's rails (2799) + conservation (2817)
- Re-check TARGET meter at ACTION time, not the advice snapshot (vendor meters hard-reset mid-cycle, same-day).
- NEVER touch the default login (currently erroring "org disabled Claude Code subscription access"). acct1-4 stores only.
- Target broke between advice & action ⇒ FAIL LOUD.
- Conservation (R 2817, Maya): build workers → codex (not claude); Agent-tool subagents burn the session acct (not conservation). Read #fleet 2815 before dispatch.
