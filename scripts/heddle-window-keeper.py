#!/usr/bin/env python3
"""heddle window-keeper — keeps every Claude account's 5-hour window ticking, STAGGERED.

Why (Maya, 2026-08-15): the 5h usage window is a rolling window anchored to the FIRST request in a
fresh window (empirically: resets_at lands on odd minutes, e.g. 22:55, 22:10 — not clock hours).
So one tiny ping starts an account's clock. Pinging all four accounts at once would make all four
walls arrive together; pinging them ~STAGGER_MIN apart makes a fresh window open every ~75 min around
the clock, so the fleet can always rotate onto an account that just reset.

What it does (per run, safe to run every 5 min from launchd):
  for each account in ~/.heddle/accounts.json (claude, loggedIn):
    - read its window from ~/.heddle/usage/claude-<id>.json (written by the statusline tap, which
      keys per account via CLAUDE_CONFIG_DIR) OR from claude-<id>.keeper.json (the keeper's own
      anchor for a window IT started) — freshest wins;
    - if the window is EXPIRED (resets_at <= now) or UNKNOWN (no capture), and this account's
      stagger slot is due (>= STAGGER_MIN since the previous account's ping), send ONE minimal
      headless ping under that account's CLAUDE_CONFIG_DIR: `claude -p ok --model haiku` (~10
      tokens) and record the anchor {startedAt: now, resets_at: now+5h} — headless `claude -p`
      does NOT render the statusline, so the tap never sees keeper-started windows.
    - if the window is LIVE, do nothing (a rolling window ignores requests until it expires — the
      keeper never shortens or shifts a running window; see --verify).
  Logs to ~/.heddle/window-keeper.log. --dry-run prints decisions, sends nothing.
  --verify <id>: pings a LIVE account once and reports whether resets_at moved (safety check).

Costs: haiku ~10 tokens per ping, at most one ping per account per 5h. Never uses Fable/Opus.
"""
import json, os, sys, time, subprocess, datetime as dt

HOME = os.path.expanduser("~")
REG = os.path.join(HOME, ".heddle", "accounts.json")
USAGE = os.path.join(HOME, ".heddle", "usage")
STATE = os.path.join(HOME, ".heddle", "window-keeper.state.json")
LOG = os.path.join(HOME, ".heddle", "window-keeper.log")
STAGGER_MIN = int(os.environ.get("HEDDLE_STAGGER_MIN", "75"))
PING_MODEL = os.environ.get("HEDDLE_PING_MODEL", "claude-haiku-4-5-20251001")
CLAUDE = os.environ.get("HEDDLE_CLAUDE_BIN", os.path.join(HOME, ".local", "bin", "claude"))
_LOG_WARNING_EMITTED = False


def log(msg):
    global _LOG_WARNING_EMITTED
    line = f"{dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    print(line)
    try:
        with open(LOG, "a") as f:
            f.write(line + "\n")
    except Exception:
        if not _LOG_WARNING_EMITTED:
            print("warning: unable to write window keeper log", file=sys.stderr)
            _LOG_WARNING_EMITTED = True


def load(path, default):
    try:
        return json.load(open(path))
    except Exception:
        return default


def write_json_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def window(acct_id):
    """Best-known 5h window for an account. Two sources, freshest wins:
      - the keeper's OWN anchor (written when IT started the window: start=now, resets_at=now+5h) —
        headless `claude -p` pings do NOT fire the statusline, so the tap never sees keeper-started
        windows (verified 2026-08-15); the keeper must remember what it started;
      - the statusline tap capture (claude-<id>.json), which exists only when a LIVE interactive session
        on that account renders — when present and fresher, it carries the real used_percentage."""
    tap = load(os.path.join(USAGE, f"claude-{acct_id}.json"), None)
    own = load(os.path.join(USAGE, f"claude-{acct_id}.keeper.json"), None)
    cands = []
    if tap:
        fh = (tap.get("rate_limits") or {}).get("five_hour") or {}
        if fh.get("resets_at"):
            cands.append({"used": fh.get("used_percentage"), "resets_at": fh.get("resets_at"),
                          "captured": tap.get("capturedAt") or 0, "source": "tap"})
    if own and own.get("resets_at"):
        cands.append({"used": own.get("used"), "resets_at": own["resets_at"],
                      "captured": own.get("startedAt") or 0, "source": "keeper"})
    if not cands:
        return None
    return max(cands, key=lambda c: c["captured"] or 0)


def ping(acct):
    env = dict(os.environ)
    if acct.get("configDir"):
        # Same `~` handling as the tap: a child process gets the literal string, so expand it here.
        env["CLAUDE_CONFIG_DIR"] = os.path.expanduser(acct["configDir"])
    else:
        env.pop("CLAUDE_CONFIG_DIR", None)
    t0 = time.time()
    # Arguments are static except CLAUDE_CONFIG_DIR, which comes from the trusted accounts registry.
    try:
        r = subprocess.run([CLAUDE, "-p", "Reply with exactly: ok", "--model", PING_MODEL, "--output-format", "json"],
                           capture_output=True, text=True, timeout=120, env=env)
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as e:
        return False, round(time.time() - t0, 1), str(e)[-160:]
    ok = r.returncode == 0 and '"ok"' in r.stdout
    return ok, round(time.time() - t0, 1), (r.stderr or "")[-160:]


def fmt(ts):
    return dt.datetime.fromtimestamp(ts).strftime("%H:%M:%S") if ts else "—"


def main():
    dry = "--dry-run" in sys.argv
    verify = None
    if "--verify" in sys.argv:
        verify_index = sys.argv.index("--verify")
        if verify_index + 1 >= len(sys.argv) or sys.argv[verify_index + 1].startswith("--"):
            print("usage: heddle-window-keeper.py [--dry-run] [--verify <account-id>]", file=sys.stderr)
            return 2
        verify = sys.argv[verify_index + 1]
    reg = load(REG, {}).get("claude", [])
    accts = [a for a in reg if a.get("loggedIn")]
    if not accts:
        log("no logged-in accounts in registry"); return
    state = load(STATE, {"last_ping_ts": 0, "last_ping_acct": None})
    now = time.time()

    if verify:
        a = next((x for x in accts if x["id"] == verify), None)
        if not a:
            log(f"--verify: unknown account {verify}"); return
        before = window(verify)
        log(f"[verify {verify}] BEFORE: used={before and before['used']}% resets_at={fmt(before and before['resets_at'])}")
        ok, secs, err = ping(a)
        time.sleep(3)
        after = window(verify)
        log(f"[verify {verify}] ping ok={ok} ({secs}s) AFTER: used={after and after['used']}% resets_at={fmt(after and after['resets_at'])}")
        if before and after and before["resets_at"] and after["resets_at"]:
            log(f"[verify {verify}] resets_at moved? {'YES ⚠️' if after['resets_at'] != before['resets_at'] else 'no ✅ (window unchanged by the ping)'}")
        return

    for a in accts:
        w = window(a["id"])
        live = bool(w and w["resets_at"] and w["resets_at"] > now)
        status = f"live ({w.get('source')}), {w['used'] if w.get('used') is not None else '?'}% used, resets {fmt(w['resets_at'])}" if live else ("EXPIRED" if w and w.get("resets_at") else "UNKNOWN (no capture)")
        if live:
            log(f"{a['id']}: {status} → nothing to do"); continue
        since_last = now - float(state.get("last_ping_ts") or 0)
        if state.get("last_ping_ts") and since_last < STAGGER_MIN * 60:
            log(f"{a['id']}: {status} but stagger slot not due ({int((STAGGER_MIN*60 - since_last)/60)}m left) → wait")
            continue
        if dry:
            log(f"{a['id']}: {status} → WOULD ping (dry-run)"); continue
        ok, secs, err = ping(a)
        log(f"{a['id']}: {status} → pinged ok={ok} ({secs}s){'' if ok else ' err=' + err}")
        if ok:
            # Remember the window WE just started (the tap can't see headless pings).
            write_json_atomic(os.path.join(USAGE, f"claude-{a['id']}.keeper.json"),
                              {"account": a["id"], "startedAt": int(now), "resets_at": int(now) + 5 * 3600,
                               "used": None, "source": "keeper-ping"})
            state = {"last_ping_ts": now, "last_ping_acct": a["id"]}
            write_json_atomic(STATE, state)
            break  # one ping per run: the stagger is enforced by run cadence + STAGGER_MIN

    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
