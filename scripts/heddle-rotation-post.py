#!/usr/bin/env python3
"""Post one window-keeper advisory through the operator's heddle-comms bridge."""
import subprocess
import sys

COMMS_POST = "/Users/mayatobi/Developer/Spinventory-Rebuild-App/.claude/bin/comms-post.mjs"


def important(text):
    return "no legal target" in text.lower() or any(f"{pct}%" in text for pct in range(95, 101))


def main():
    text = sys.stdin.read().strip()
    if not text:
        print("rotation post: empty advisory", file=sys.stderr)
        return 1
    body = ("⭐ " if important(text) else "") + text
    try:
        # comms-post currently accepts only kind=chat and has no importance argument. Keep the
        # importance marker in the body until its interface grows a dedicated flag.
        result = subprocess.run(
            ["node", COMMS_POST, "--to", "R", "--kind", "chat", "--issue", "HED-486", "--body", body],
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
