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
import json, os, re, sys, time, subprocess, datetime as dt, shutil, shlex

try:
    import fcntl
except ImportError:  # Windows has no fcntl; accounting remains available without this optimization.
    fcntl = None

HOME = os.path.expanduser("~")
REG = os.path.join(HOME, ".heddle", "accounts.json")
USAGE = os.path.join(HOME, ".heddle", "usage")
STATE = os.path.join(HOME, ".heddle", "window-keeper.state.json")
LOG = os.path.join(HOME, ".heddle", "window-keeper.log")
ROTATION_ADVICE = os.path.join(HOME, ".heddle", "rotation-advice.json")
TRANSCRIPT_OFFSETS = os.path.join(HOME, ".heddle", "transcript-offsets.json")
TRANSCRIPT_STATE = os.path.join(HOME, ".heddle", "transcript-usage-state.json")
TRANSCRIPT_LOCK = os.path.join(HOME, ".heddle", "transcript-accounting.lock")
PING_MODEL = os.environ.get("HEDDLE_PING_MODEL", "claude-haiku-4-5-20251001")
CLAUDE = os.environ.get("HEDDLE_CLAUDE_BIN", os.path.join(HOME, ".local", "bin", "claude"))
# The per-fleet resume script is not verified to exist on this machine, so keep it an operator-owned
# template instead of inventing a path and presenting it as a real command.
RELAUNCH_TEMPLATE = os.environ.get("HEDDLE_RELAUNCH_TEMPLATE", "bash resume-sessions.sh --account {account} -y")
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


def int_env(name, default, lo, hi):
    """Read a bounded integer config value without ever aborting the keeper at import time.

    Bounds are per-setting and NOT shared: a percentage lives in 1-100, but a stagger is minutes and
    75 x 4 accounts is the whole point of the schedule — clamping minutes to 100 would silently
    rewrite a legitimate 120 into something the operator never asked for. A wrong-but-plausible
    config value that nobody is told about is worse than the crash this function exists to prevent."""
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        value = int(value)
    except (TypeError, ValueError):
        log(f"invalid {name}={value!r}; using default {default}")
        return default
    clamped = min(hi, max(lo, value))
    if clamped != value:
        log(f"{name}={value!r} is outside {lo}-{hi}; clamping to {clamped}")
    return clamped


# Minutes between staggered pings: at least one, and an upper bound past a full 5h window is a typo.
STAGGER_MIN = int_env("HEDDLE_STAGGER_MIN", 75, 1, 300)
# A percentage of the 5h window.
ROTATE_PCT = int_env("HEDDLE_ROTATE_PCT", 85, 1, 100)


def load(path, default):
    try:
        return json.load(open(path))
    except Exception:
        return default


def write_json_atomic(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def safe_segment(acct_id):
    return re.sub(r"[^A-Za-z0-9._-]", "_", str(acct_id))


def window(acct_id):
    """Best-known 5h window for an account. Two sources, freshest wins:
      - the keeper's OWN anchor (written when IT started the window: start=now, resets_at=now+5h) —
        headless `claude -p` pings do NOT fire the statusline, so the tap never sees keeper-started
        windows (verified 2026-08-15); the keeper must remember what it started;
      - the statusline tap capture (claude-<id>.json), which exists only when a LIVE interactive session
        on that account renders — when present and fresher, it carries the real used_percentage."""
    segment = safe_segment(acct_id)
    tap = load(os.path.join(USAGE, f"claude-{segment}.json"), None)
    own = load(os.path.join(USAGE, f"claude-{segment}.keeper.json"), None)
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


def rotation_target(accts, active_id, now):
    """Choose the most useful logged-in account to rotate onto, if its headroom is known enough."""
    known, unknown = [], []
    for acct in accts:
        if acct["id"] == active_id:
            continue
        w = window(acct["id"])
        if not w:
            continue
        if not w.get("resets_at") or w["resets_at"] <= now:
            # An expired reading's usage is unknown, but it is not a warm keeper anchor that can
            # safely stand in for measured headroom.
            continue
        used = w.get("used")
        if used is not None:
            try:
                used_pct = float(used)
            except (TypeError, ValueError):
                continue
            if used_pct >= ROTATE_PCT:
                continue
            known.append((used_pct, acct, w))
        elif w.get("source") == "keeper":
            unknown.append((acct, w))
    if known:
        _, acct, w = min(known, key=lambda item: (item[0], item[1]["id"]))
        return acct, w
    if unknown:
        # A keeper window is a warm, recently anchored fallback when no measured headroom exists.
        acct, w = min(unknown, key=lambda item: (item[1].get("source") != "keeper",
                                                   item[1].get("resets_at") or float("inf"), item[0]["id"]))
        return acct, w
    return None, None


def run_rotation_notification(text):
    if os.environ.get("HEDDLE_ROTATE_NOTIFY") == "0":
        return
    osascript = shutil.which("osascript")
    if not osascript:
        return
    try:
        result = subprocess.run(
            [osascript, "-e", "on run argv\n display notification (item 1 of argv) with title (item 2 of argv)\nend run",
             text, "Heddle rotation advisor"],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode:
            log(f"rotation advisor: notification failed: {(result.stderr or result.stdout)[-160:]}")
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as e:
        log(f"rotation advisor: notification failed: {str(e)[-160:]}")


def post_rotation_advice(text):
    command = os.environ.get("HEDDLE_FLEET_POST_CMD")
    if not command:
        return
    try:
        # This is operator-supplied configuration; handing configuration to a shell turns it into
        # code execution, so parse it into argv instead.
        args = shlex.split(command)
    except ValueError as e:
        log(f"rotation advisor: invalid fleet post command: {str(e)[-160:]}")
        return
    if not args:
        log("rotation advisor: invalid fleet post command: empty command")
        return
    try:
        result = subprocess.run(args, input=text, capture_output=True, text=True, timeout=15)
        if result.returncode:
            log(f"rotation advisor: fleet post failed: {(result.stderr or result.stdout)[-160:]}")
    except (subprocess.TimeoutExpired, OSError) as e:
        log(f"rotation advisor: fleet post failed: {str(e)[-160:]}")


def pct(v):
    """Round a provider percentage for human-facing use. A live capture really does read
    `7.000000000000001` (float arithmetic upstream), and this advisor's whole product is a sentence a
    person reads under pressure — an alert saying "87.00000000000001%" looks broken and costs the
    advice the credibility it needs to be acted on. `None` when there is no number to show.

    A whole number comes back as an int so the common case still reads "7%" rather than "7.0%": the
    goal is to remove noise, not to add a decimal nobody asked for."""
    try:
        rounded = round(float(v), 1)
        # int() must stay INSIDE the guard: json.load decodes the literals NaN/Infinity into floats,
        # and int(nan) raises ValueError while int(inf) raises OverflowError. Outside the try, a single
        # such value in a usage file would abort the whole keeper before any ping — for a cosmetic
        # rounding helper. Anything unrepresentable degrades to None, like any other missing number.
        return int(rounded) if rounded == int(rounded) else rounded
    except (TypeError, ValueError, OverflowError):
        return None


def advise_rotation(accts, state, now):
    # A tap capture is written only when a live interactive session renders its statusline. The newest
    # tap is therefore the load-bearing signal for which account is actively in use; keeper anchors do
    # not prove an interactive session exists, so without a tap we intentionally offer no advice.
    tap_windows = []
    for acct in accts:
        w = window(acct["id"])
        if w and w.get("source") == "tap" and w.get("resets_at") and w["resets_at"] > now:
            tap_windows.append((acct, w))
    if not tap_windows:
        return
    active, active_window = max(tap_windows, key=lambda item: item[1].get("captured") or 0)
    if active_window.get("used") is None:
        return
    try:
        active_used = float(active_window["used"])
    except (TypeError, ValueError):
        return
    if active_used < ROTATE_PCT:
        return

    resets_at = active_window.get("resets_at")
    advice_keys = state.get("rotationAdvice")
    if not isinstance(advice_keys, list):
        advice_keys = []
    advice_key = {"activeId": active["id"], "resetsAt": resets_at}
    if any(key.get("activeId") == active["id"] and key.get("resetsAt") == resets_at
           for key in advice_keys if isinstance(key, dict)):
        return

    target, target_window = rotation_target(accts, active["id"], now)
    active_pct = pct(active_window["used"])
    target_payload = None
    command = None
    template_error = False
    if target:
        target_payload = {"id": target["id"], "usedPct": pct(target_window.get("used")),
                          "resetsAt": target_window.get("resets_at"), "source": target_window.get("source")}
        try:
            command = RELAUNCH_TEMPLATE.format(account=target["id"])
        except Exception as e:  # noqa: BLE001 - malformed operator configuration must still produce advice
            template_error = True
            log(f"rotation advisor: invalid HEDDLE_RELAUNCH_TEMPLATE: {str(e)[-160:]}")
    if target and template_error:
        reason = (f"{active['id']} is at {active_pct}%, meeting the {ROTATE_PCT}% rotation threshold; "
                  f"{target['id']} has the most available headroom, but HEDDLE_RELAUNCH_TEMPLATE is unusable.")
    elif target:
        reason = (f"{active['id']} is at {active_pct}%, meeting the {ROTATE_PCT}% rotation "
                  f"threshold; {target['id']} has the most available headroom.")
    else:
        reason = (f"{active['id']} is at {active_pct}%, meeting the {ROTATE_PCT}% rotation threshold; "
                  "every other logged-in account is also at/over the threshold or unknown.")
    advice = {"advisedAt": int(now),
              "active": {"id": active["id"], "usedPct": active_pct, "resetsAt": resets_at},
              "target": target_payload, "command": command, "thresholdPct": ROTATE_PCT, "reason": reason}
    command_text = command or ("HEDDLE_RELAUNCH_TEMPLATE is unusable" if template_error else "no eligible target")
    advice_text = f"Heddle rotation advice: {reason} Command: {command_text}"

    # These channels are deliberately independent: a broken desktop or fleet hook must not interrupt
    # the five-minute keeper job, nor should it prevent the durable advice artifact from being attempted.
    log(f"rotation advisor: active={active['id']} used={active_pct}% target={target and target['id']} command={command}")
    try:
        write_json_atomic(ROTATION_ADVICE, advice)
    except Exception as e:
        log(f"rotation advisor: unable to write advice file: {str(e)[-160:]}")
    run_rotation_notification(advice_text)
    post_rotation_advice(advice_text)

    try:
        state["rotationAdvice"] = (advice_keys + [advice_key])[-50:]
        write_json_atomic(STATE, state)
    except Exception as e:
        log(f"rotation advisor: unable to persist dedupe state: {str(e)[-160:]}")


def account_uuid_map():
    """Map transcript owner UUIDs to Heddle ids without retaining config credentials.

    The projects directories are commonly shared symlinks, so a config directory cannot establish
    ownership.  Only the deliberately small `accountUuid` field is read from each config file."""
    owners = {}
    for acct in (load(REG, {}) or {}).get("claude", []):
        try:
            config_dir = os.path.expanduser(acct.get("configDir") or "~/.claude")
            with open(os.path.join(config_dir, ".claude.json")) as f:
                config = json.load(f)
            owner_uuid = config.get("accountUuid") if isinstance(config, dict) else None
            acct_id = acct.get("id")
            if isinstance(owner_uuid, str) and isinstance(acct_id, str):
                owners[owner_uuid] = acct_id
        except (OSError, json.JSONDecodeError, ValueError, TypeError):
            # A missing or unavailable config is not worth delaying the five-minute keeper.
            continue
    return owners


def transcript_projects(accts):
    """Return each real projects directory once, even when account configs symlink to it."""
    projects = []
    seen = set()
    for acct in accts:
        try:
            config_dir = os.path.expanduser(acct.get("configDir") or "~/.claude")
            project_dir = os.path.realpath(os.path.join(config_dir, "projects"))
            if project_dir not in seen and os.path.isdir(project_dir):
                seen.add(project_dir)
                projects.append(project_dir)
        except OSError:
            continue
    return projects


def transcript_files(accts):
    """Find transcript files under deduplicated project roots, tolerating unreadable trees."""
    files, seen = [], set()
    for project_dir in transcript_projects(accts):
        try:
            for root, _, names in os.walk(project_dir, onerror=lambda _error: None):
                for name in names:
                    if not name.endswith(".jsonl"):
                        continue
                    try:
                        path = os.path.realpath(os.path.join(root, name))
                        if path not in seen:
                            seen.add(path)
                            files.append(path)
                    except OSError:
                        continue
        except OSError:
            continue
    return sorted(files)


def weekly_windows(accts, now):
    """Return only windows proved by seven-day tap captures; keeper anchors are five-hour only."""
    windows = {}
    for acct in accts:
        try:
            tap = load(os.path.join(USAGE, f"claude-{safe_segment(acct['id'])}.json"), None)
            seven_day = (tap or {}).get("rate_limits", {}).get("seven_day", {})
            resets_at = seven_day.get("resets_at")
            if resets_at is not None:
                resets_at = int(resets_at)
                if resets_at > now:
                    windows[acct["id"]] = (resets_at - 7 * 86400, resets_at)
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    return windows


def transcript_offsets():
    """Load the explicit byte-offset contract, surfacing a broken state path to main's guard."""
    if not os.path.exists(TRANSCRIPT_OFFSETS):
        return {}
    with open(TRANSCRIPT_OFFSETS) as f:
        offsets = json.load(f)
    if not isinstance(offsets, dict):
        raise ValueError("transcript offsets must be an object")
    return offsets


def transcript_state():
    """Load the combined transaction, merging the previous two-file state once if present."""
    if not os.path.exists(TRANSCRIPT_STATE):
        state = {"windows": {}, "files": {}}
    else:
        with open(TRANSCRIPT_STATE) as f:
            state = json.load(f)
        if not isinstance(state, dict):
            raise ValueError("transcript usage state must be an object")
    state.setdefault("windows", {})
    state.setdefault("files", {})
    if not isinstance(state["windows"], dict) or not isinstance(state["files"], dict):
        raise ValueError("transcript usage state has invalid sections")
    legacy_offsets = transcript_offsets()
    files = {}
    for path, value in state["files"].items():
        if isinstance(value, dict) and isinstance(value.get("accounts"), dict):
            files[path] = {"offset": transcript_number(value.get("offset")),
                           "size": transcript_number(value.get("size")),
                           "accounts": value["accounts"], "oversized": bool(value.get("oversized"))}
        elif isinstance(value, dict):
            # The old accumulator stored only per-account counts; merge its matching legacy offset.
            saved = legacy_offsets.get(path, {})
            files[path] = {"offset": transcript_number(saved.get("offset")) if isinstance(saved, dict) else 0,
                           "size": transcript_number(saved.get("size")) if isinstance(saved, dict) else 0,
                           "accounts": value, "oversized": False}
    for path, saved in legacy_offsets.items():
        if path not in files and isinstance(saved, dict):
            files[path] = {"offset": transcript_number(saved.get("offset")),
                           "size": transcript_number(saved.get("size")), "accounts": {}, "oversized": False}
    state["files"] = files
    return state


def transcript_timestamp(value):
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (AttributeError, TypeError, ValueError, OverflowError):
        return None


def transcript_number(value):
    """Usage counts are integers; malformed or negative provider values carry no usable signal."""
    try:
        result = int(value)
        return result if result >= 0 else 0
    except (TypeError, ValueError, OverflowError):
        return 0


def is_fable(model):
    # `affable` is not Fable; model names use separators, so match a complete token only.
    return "fable" in re.split(r"[^a-z0-9]+", model.lower())


def add_transcript_turn(file_counts, account, model, usage):
    account_counts = file_counts.setdefault(account, {})
    counts = account_counts.setdefault(model, {"input": 0, "output": 0, "cacheCreation": 0,
                                                "cacheRead": 0, "turns": 0})
    counts["input"] += transcript_number(usage.get("input_tokens"))
    counts["output"] += transcript_number(usage.get("output_tokens"))
    counts["cacheCreation"] += transcript_number(usage.get("cache_creation_input_tokens"))
    counts["cacheRead"] += transcript_number(usage.get("cache_read_input_tokens"))
    counts["turns"] += 1


def account_summary(acct_id, resets_at, files, now):
    by_model = {}
    sessions_seen = 0
    for file_state in files.values():
        accounts = file_state.get("accounts", file_state) if isinstance(file_state, dict) else {}
        models = accounts.get(acct_id, {}) if isinstance(accounts, dict) else {}
        if not models:
            continue
        sessions_seen += 1
        for model, values in models.items():
            target = by_model.setdefault(model, {"input": 0, "output": 0, "cacheCreation": 0,
                                                  "cacheRead": 0, "turns": 0})
            for key in target:
                target[key] += transcript_number(values.get(key))
    # Cache reads commonly dominate a turn (for example, a large reused context). Including them
    # would swamp real request/output work and make long sessions all look alike.
    weighted_total = sum(values["input"] + values["output"] + values["cacheCreation"]
                         for values in by_model.values())
    fable_weighted = sum(values["input"] + values["output"] + values["cacheCreation"]
                         for model, values in by_model.items() if is_fable(model))
    cache_read_total = sum(values["cacheRead"] for values in by_model.values())
    return {"windowResetsAt": resets_at, "updatedAt": int(now), "sessionsSeen": sessions_seen,
            "byModel": by_model, "weightedTotal": weighted_total, "fableWeighted": fable_weighted,
            "fableShare": fable_weighted / weighted_total if weighted_total else None,
            "cacheReadTotal": cache_read_total}


def remove_account_contributions(files, acct_id):
    """Forget one expired window without rewinding bytes or disturbing other accounts' totals."""
    for file_state in files.values():
        if isinstance(file_state, dict):
            accounts = file_state.get("accounts", file_state)
            if isinstance(accounts, dict):
                accounts.pop(acct_id, None)


def transcript_lock():
    """Acquire a non-blocking lock so overlapping launchd runs never race the transaction."""
    if fcntl is None:
        return None
    os.makedirs(os.path.dirname(TRANSCRIPT_LOCK), exist_ok=True)
    lock_file = open(TRANSCRIPT_LOCK, "a")
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return lock_file
    except BlockingIOError:
        lock_file.close()
        log("[transcripts] accounting skipped; another run holds the lock")
        return False
    except OSError:
        lock_file.close()
        log("[transcripts] accounting skipped; unable to acquire the lock")
        return False


def account_transcripts(accts, now):
    """Incrementally account assistant usage without exposing transcript content anywhere.

    A single counts-only transaction keeps every file's offset beside its accumulated totals, so a
    crash cannot retain one without the other. Transcript content is never emitted or retained.
    """
    lock_file = transcript_lock()
    if lock_file is False:
        return
    try:
        state = transcript_state()
        owners = account_uuid_map()
        windows = weekly_windows(accts, now)
        current_resets = {acct_id: end for acct_id, (_, end) in windows.items()}

        # Each account owns its own weekly aggregate. A rollover drops only that account's old
        # contribution; byte offsets remain valid and other accounts continue draining normally.
        for acct_id, resets_at in current_resets.items():
            previous = state["windows"].get(acct_id)
            if previous is not None and previous != resets_at:
                remove_account_contributions(state["files"], acct_id)
        state["windows"] = current_resets

        budget = int_env("HEDDLE_TRANSCRIPT_BYTES", 32 * 1024 * 1024, 1, 1024 * 1024 * 1024)
        read_bytes = 0
        for path in transcript_files(accts):
            if read_bytes >= budget:
                break
            try:
                size = os.path.getsize(path)
                file_state = state["files"].setdefault(path, {"offset": 0, "size": 0, "accounts": {}, "oversized": False})
                offset = transcript_number(file_state.get("offset")) if isinstance(file_state, dict) else 0
                if size < offset:
                    offset = 0
                    file_state["accounts"] = {}
                    file_state["oversized"] = False
                with open(path, "rb") as f:
                    if offset and not file_state.get("oversized"):
                        # We only persist newline boundaries. Any other byte proves replacement even
                        # when a truncated file happened to regrow past the stale old offset.
                        f.seek(offset - 1)
                        if f.read(1) != b"\n":
                            offset = 0
                            file_state["accounts"] = {}
                            file_state["oversized"] = False
                    if size == offset:
                        file_state.update({"offset": offset, "size": size, "oversized": False})
                        continue
                    f.seek(offset)
                    data = f.read(min(size - offset, budget - read_bytes))
            except OSError:
                continue
            read_bytes += len(data)
            newline = data.rfind(b"\n")
            if newline < 0:
                if offset + len(data) < size:
                    # A complete record exceeds this run's read budget. Skip this fragment so one
                    # pathological line cannot starve every later file; never log transcript data.
                    file_state.update({"offset": offset + len(data), "size": size, "oversized": True})
                    log("[transcripts] skipped oversized JSONL record")
                else:
                    # EOF without a newline is a genuinely incomplete trailing write; wait for it.
                    file_state.update({"offset": offset, "size": size})
                continue
            complete = data[:newline + 1]
            file_counts = file_state.setdefault("accounts", {})
            for raw_line in complete.splitlines():
                try:
                    turn = json.loads(raw_line.decode("utf-8"))
                    if turn.get("type") != "assistant" or turn.get("isSidechain"):
                        continue
                    acct_id = owners.get(turn.get("ownerAccountUuid"))
                    if acct_id not in windows:
                        continue
                    timestamp = transcript_timestamp(turn.get("timestamp"))
                    start, _end = windows[acct_id]
                    if timestamp is None or timestamp < start or timestamp > now:
                        continue
                    message = turn.get("message") or {}
                    model, usage = message.get("model"), message.get("usage")
                    if isinstance(model, str) and isinstance(usage, dict):
                        add_transcript_turn(file_counts, acct_id, model, usage)
                except (UnicodeDecodeError, json.JSONDecodeError, AttributeError, TypeError):
                    # Invalid complete records are skipped silently: logging a transcript line could leak it.
                    continue
            file_state.update({"offset": offset + len(complete), "size": size, "oversized": False})

        write_json_atomic(TRANSCRIPT_STATE, state)
        for acct_id, (_, resets_at) in windows.items():
            write_json_atomic(os.path.join(USAGE, f"claude-{safe_segment(acct_id)}.turns.json"),
                              account_summary(acct_id, resets_at, state["files"], now))
    finally:
        if lock_file is not None:
            try:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            finally:
                lock_file.close()


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
    # Distinct ids must stay distinct after filename sanitization, or two accounts would share
    # capture/anchor files and mis-attribute windows. Registry ids are trusted slugs, so a
    # collision is a registry mistake — skip the later entry loudly rather than cross-write.
    seen_segments = {}
    unique_accts = []
    for a in accts:
        segment = safe_segment(a["id"])
        if segment in seen_segments:
            log(f"registry error: ids {seen_segments[segment]!r} and {a['id']!r} collide after sanitization ('{segment}') — skipping {a['id']!r}")
            continue
        seen_segments[segment] = a["id"]
        unique_accts.append(a)
    accts = unique_accts
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

    if not dry:
        # The advisor is SECONDARY. Keeping windows alive is what this job exists for, and that work
        # happens below — so anything the advisor can throw (a hand-edited state file, an unexpected
        # window shape) must degrade to a log line rather than abort the run before a single ping.
        try:
            advise_rotation(accts, state, now)
        except Exception as e:  # noqa: BLE001 - advising must never cost us a ping
            log(f"[rotate] advisor failed, continuing with pings: {type(e).__name__}: {str(e)[-160:]}")
        # Transcript summaries improve weekly routing, but the staggered pings remain this job's
        # primary responsibility. A damaged transcript state file must therefore never block a ping.
        try:
            account_transcripts(accts, now)
        except Exception as e:  # noqa: BLE001 - accounting must never cost us a ping
            log(f"[transcripts] accounting failed, continuing with pings: {type(e).__name__}: {str(e)[-160:]}")

    for a in accts:
        w = window(a["id"])
        live = bool(w and w["resets_at"] and w["resets_at"] > now)
        # Same rounding as the advisor: this status line is where an operator reads the numbers when
        # they are deciding whether to rotate, and `7.000000000000001%` is noise in that moment.
        status = f"live ({w.get('source')}), {pct(w['used']) if w.get('used') is not None else '?'}% used, resets {fmt(w['resets_at'])}" if live else ("EXPIRED" if w and w.get("resets_at") else "UNKNOWN (no capture)")
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
            write_json_atomic(os.path.join(USAGE, f"claude-{safe_segment(a['id'])}.keeper.json"),
                              {"account": a["id"], "startedAt": int(now), "resets_at": int(now) + 5 * 3600,
                               "used": None, "source": "keeper-ping",
                               "note": "upper bound — a pre-existing live window this keeper could not see may reset earlier; a fresher tap capture supersedes this anchor"})
            state.update({"last_ping_ts": now, "last_ping_acct": a["id"]})
            write_json_atomic(STATE, state)
            break  # one ping per run: the stagger is enforced by run cadence + STAGGER_MIN

    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
