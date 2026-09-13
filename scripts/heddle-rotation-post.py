#!/usr/bin/env python3
"""Post one window-keeper advisory through the operator's heddle-comms bridge."""
import os
import re
import subprocess
import sys

_COMMS_POST_FALLBACK = "/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/bin/comms-post.mjs"
COMMS_POST = os.environ.get("HEDDLE_COMMS_POST") or _COMMS_POST_FALLBACK


def important(text):
    outcome = re.search(r"\boutcome=([a-z-]+)\b", text)
    critical = re.search(r"\bcriticalPct=(\d+(?:\.\d+)?)\b", text)
    active = re.search(r"\bis at (\d+(?:\.\d+)?)%", text)
    if outcome and outcome.group(1) in ("wait", "unavailable"):
        return True
    return bool(critical and active and float(active.group(1)) >= float(critical.group(1)))


def main():
    text = sys.stdin.read().strip()
    if not text:
        print("rotation post: empty advisory", file=sys.stderr)
        return 1
    if "HEDDLE_COMMS_POST" not in os.environ:
        print(f"rotation post: HEDDLE_COMMS_POST unset; using built-in fallback {COMMS_POST} — set HEDDLE_COMMS_POST for portability", file=sys.stderr)
    if not os.path.isfile(COMMS_POST):
        print("rotation post: comms-post unavailable", file=sys.stderr)
        return 1
    body = ("⭐ " if important(text) else "") + text
    try:
        # comms-post currently accepts only kind=chat and has no importance argument. Keep the
        # importance marker in the body until its interface grows a dedicated flag.
        args = ["node", COMMS_POST, "--to", "R", "--kind", "chat"]
        issue = os.environ.get("HEDDLE_ROTATION_POST_ISSUE")
        if issue:
            args += ["--issue", issue]
        args += ["--body", body]
        result = subprocess.run(
            args,
            capture_output=True, text=True, timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"rotation post: {type(error).__name__}", file=sys.stderr)
        return 1
    if result.returncode:
        print((result.stderr or result.stdout or "rotation post failed")[-400:], file=sys.stderr)
        return result.returncode or 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
