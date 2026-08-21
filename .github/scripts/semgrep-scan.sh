#!/usr/bin/env sh
# Extracted from deterministic-review.yml (HED-253) so the scanned-volume guard
# can be fixture-tested directly. POSIX sh on purpose: the semgrep container
# runs the workflow step with `sh -e`, so retain that fail-closed behavior here.
# Inputs: IS_PR, PR_HEAD_SHA, PR_BASE_REF, BASE_SHA_FALLBACK,
# GITHUB_WORKSPACE, GITHUB_STEP_SUMMARY, RUNNER_TEMP.
set -eu

# Container jobs: actions/checkout writes its safe.directory entry to a
# temporary HOME, while this step runs as the image user.
git config --global --add safe.directory "$GITHUB_WORKSPACE"

BASELINE=""
if [ -n "$IS_PR" ]; then
  # The checked-out synthetic PR merge's first parent is the exact base tip
  # merged by GitHub. Verify its second parent first; otherwise use the current
  # base ref's merge-base, and only then the recorded base-SHA fallback.
  if [ "$(git rev-parse -q --verify HEAD^2 2>/dev/null)" = "$PR_HEAD_SHA" ]; then
    BASELINE=$(git rev-parse HEAD^1)
  elif BASELINE=$(git merge-base "origin/$PR_BASE_REF" HEAD 2>/dev/null) && [ -n "$BASELINE" ]; then
    echo "::warning::HEAD is not GitHub's synthetic merge of this PR — baseline = merge-base(origin/$PR_BASE_REF, HEAD)"
  else
    BASELINE="$BASE_SHA_FALLBACK"
    echo "::warning::could not resolve the current base tip — falling back to pull_request.base.sha as the baseline (may lag main)"
  fi
fi

if [ -n "$BASELINE" ]; then
  git ls-files | grep -E '(^|/)\.semgrepignore$' | while IFS= read -r f; do
    git rm -q -- "$f"
  done
  git ls-tree -r --name-only "$BASELINE" | grep -E '(^|/)\.semgrepignore$' | while IFS= read -r f; do
    mkdir -p "$(dirname "$f")"; git show "$BASELINE:$f" > "$f"; git add -- "$f"
  done
  if ! git diff --cached --quiet; then
    git -c user.name=ci -c user.email=ci@localhost commit -q -m "ci: base-branch .semgrepignore for the diff-aware scan"
    echo "::notice::.semgrepignore differs from the base branch — scanned with the base branch's copy"
  fi
fi

# Keep scanner artifacts out of the PR-controlled workspace. Remove a planted
# symlink rather than following it when semgrep creates either output file.
# Scan outputs go to the workflow-passed runner.temp (SEMGREP_OUTPUT_DIR) so they land at the exact
# path the workflow's Upload SARIF step reads; fall back to RUNNER_TEMP for direct/test invocation.
SEMGREP_OUT_DIR="${SEMGREP_OUTPUT_DIR:-${RUNNER_TEMP:-/tmp}}"
SEMGREP_JSON="$SEMGREP_OUT_DIR/semgrep.json"
SEMGREP_SARIF="$SEMGREP_OUT_DIR/semgrep.sarif"
for output in "$SEMGREP_JSON" "$SEMGREP_SARIF"; do
  if [ -L "$output" ]; then
    rm -f -- "$output" \
      || { echo "::error::could not remove pre-existing semgrep output symlink $output — NOT a clean pass"; exit 1; }
  fi
done

set -- scan --config p/typescript --config p/react --config p/rust \
       --metrics=off --disable-nosem --sarif-output="$SEMGREP_SARIF" --json-output="$SEMGREP_JSON" \
       --exclude node_modules --exclude dist --exclude src-tauri/target --exclude src-tauri/gen
if [ -n "$BASELINE" ]; then
  echo "diff-aware scan: baseline $BASELINE"
  set -- "$@" --baseline-commit="$BASELINE"
else
  echo "full scan (push to main)"
fi
# No --error: report-only tier. A tool crash / unparseable output is still an
# honest red (the upload step needs the file).
semgrep "$@"

# One-line receipt in the job summary. python3 is guaranteed in the image (the
# semgrep CLI is a Python package); jq is not.
N=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["runs"][0]["results"]))' "$SEMGREP_SARIF")
echo "semgrep: **$N** finding(s) (${BASELINE:+new vs base }${BASELINE:-full scan})" >> "$GITHUB_STEP_SUMMARY"

# ── Scanned-volume guard (HED-70): a green scanner is not proof it scanned.
# paths.scanned lists the files semgrep analysed. A PR 0-scan can be legitimate
# (excludes / .semgrepignore / deletions), so it warns; full-main 0-scan and
# unreadable output fail closed.
SCANNED=$(python3 -c 'import json,sys; p=json.load(open(sys.argv[1])).get("paths") or {}; s=p.get("scanned"); print(len(s)) if isinstance(s,list) else sys.exit(3)' "$SEMGREP_JSON" 2>/dev/null) \
  || { echo "::error::semgrep scanned-volume unreadable (paths.scanned missing/unparseable in semgrep.json) — NOT a clean pass"; echo "semgrep: ❌ scanned-volume unreadable — NOT a clean pass" >> "$GITHUB_STEP_SUMMARY"; exit 1; }

if [ -n "$BASELINE" ]; then
  # PR: expected = in-language changed files MINUS the scan's own excludes.
  # `git diff -z` and Python's byte-oriented split preserve names containing
  # newlines or non-ASCII bytes, which newline splitting would miscount.
  CHANGED_FILE=$(mktemp "${RUNNER_TEMP:-/tmp}/semgrep-changed.XXXXXX") \
    || { echo "::error::could not create temporary input for the semgrep scanned-volume guard — NOT a clean pass"; exit 1; }
  git diff -z --name-only --diff-filter=ACMR "$BASELINE"..HEAD > "$CHANGED_FILE" \
    || { rm -f -- "$CHANGED_FILE"; echo "::error::git diff failed for the semgrep scanned-volume guard — NOT a clean pass"; exit 1; }
  INLANG=$(python3 -c '
import re, sys
paths = sys.stdin.buffer.read().split(b"\0")
excluded = re.compile(rb"(^|/)(node_modules|dist|src-tauri/(target|gen))/")
language = re.compile(rb"\.(ts|tsx|js|jsx|mjs|cjs|rs)$")
print(sum(bool(language.search(path)) and not excluded.search(path) for path in paths if path))
' < "$CHANGED_FILE") \
    || { rm -f -- "$CHANGED_FILE"; echo "::error::could not count changed in-language files for the semgrep scanned-volume guard — NOT a clean pass"; exit 1; }
  rm -f -- "$CHANGED_FILE"
  if [ "$INLANG" -gt 0 ] && [ "$SCANNED" -eq 0 ]; then
    echo "::warning::semgrep scanned 0 targets while this PR changed $INLANG in-language file(s) — expected when they are all excluded / .semgrepignore'd, but verify it is not a scan miss."
    echo "semgrep volume: scanned 0 target(s) with $INLANG in-language file(s) changed — verify (excludes/ignores expected)" >> "$GITHUB_STEP_SUMMARY"
  else
    echo "semgrep volume: scanned $SCANNED target(s); diff has $INLANG in-language file(s)" >> "$GITHUB_STEP_SUMMARY"
  fi
else
  # main push (full scan): the repo always has TS + Rust source, so a real scan
  # covers > 0 targets; 0 means the scan was empty (git broke, etc.).
  if [ "$SCANNED" -eq 0 ]; then
    echo "::error::semgrep scanned 0 targets on a full main scan, but the repo has TS/Rust source — the scan is empty (a green scanner is not a scan). NOT a clean pass"
    echo "semgrep: ❌ full scan covered 0 targets — NOT a clean pass" >> "$GITHUB_STEP_SUMMARY"
    exit 1
  fi
  echo "semgrep volume: scanned $SCANNED target(s) (full scan)" >> "$GITHUB_STEP_SUMMARY"
fi
