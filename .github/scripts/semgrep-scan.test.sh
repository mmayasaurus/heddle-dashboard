#!/usr/bin/env sh
# Fixture coverage for semgrep-scan.sh. Uses real temporary git repositories and
# a tiny semgrep stand-in so the scanned-volume guard can run without the image.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$SCRIPT_DIR/semgrep-scan.sh"
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/semgrep-scan-test.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT HUP INT TERM

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  needle=$1
  file=$2
  grep -F -- "$needle" "$file" >/dev/null || fail "expected $file to contain: $needle"
}

make_semgrep() {
  mkdir -p "$1/bin"
  cat > "$1/bin/semgrep" <<'EOF'
#!/usr/bin/env sh
set -eu
for arg in "$@"; do
  case "$arg" in
    --json-output=*) json=${arg#--json-output=} ;;
    --sarif-output=*) sarif=${arg#--sarif-output=} ;;
  esac
done
printf '%s\n' "$SEMGREP_FIXTURE_JSON" > "$json"
printf '%s\n' '{"runs":[{"results":[]}]}' > "$sarif"
EOF
  chmod +x "$1/bin/semgrep"
}

make_repo() {
  repo=$1
  mkdir -p "$repo"
  # Force the initial branch to master so the PR-merge fixture is deterministic
  # regardless of the host's init.defaultBranch (main vs master).
  git -C "$repo" init -q -b master
  git -C "$repo" -c user.name=fixture -c user.email=fixture@example.test commit --allow-empty -q -m base
}

run_main_fixture() {
  name=$1
  json=$2
  root="$TEST_ROOT/$name"
  make_repo "$root/repo"
  make_semgrep "$root"
  mkdir -p "$root/home" "$root/temp"
  : > "$root/summary"
  set +e
  (
    cd "$root/repo"
    HOME="$root/home" PATH="$root/bin:$PATH" RUNNER_TEMP="$root/temp" \
      GITHUB_WORKSPACE="$root/repo" GITHUB_STEP_SUMMARY="$root/summary" \
      IS_PR='' PR_HEAD_SHA='' PR_BASE_REF='' BASE_SHA_FALLBACK='' \
      SEMGREP_FIXTURE_JSON="$json" sh "$SCRIPT"
  ) >"$root/output" 2>&1
  rc=$?
  set -e
  printf '%s\n' "$rc"
}

main_zero_rc=$(run_main_fixture main-zero '{"paths":{"scanned":[]}}')
[ "$main_zero_rc" -eq 1 ] || fail "main 0-target fixture exited $main_zero_rc, expected 1"
assert_contains '::error::semgrep scanned 0 targets on a full main scan' "$TEST_ROOT/main-zero/output"

schema_rc=$(run_main_fixture schema-drift '{"paths":{}}')
[ "$schema_rc" -eq 1 ] || fail "schema-drift fixture exited $schema_rc, expected 1"
assert_contains '::error::semgrep scanned-volume unreadable' "$TEST_ROOT/schema-drift/output"

pr_root="$TEST_ROOT/pr-zero"
make_repo "$pr_root/repo"
make_semgrep "$pr_root"
mkdir -p "$pr_root/home" "$pr_root/temp"
git -C "$pr_root/repo" checkout -q -b feature
newline_name=$(printf 'src/new\nname.ts')
mkdir -p "$pr_root/repo/src"
printf 'export const fixture = true;\n' > "$pr_root/repo/$newline_name"
git -C "$pr_root/repo" add -- "$newline_name"
git -C "$pr_root/repo" -c user.name=fixture -c user.email=fixture@example.test commit -q -m feature
pr_head=$(git -C "$pr_root/repo" rev-parse HEAD)
git -C "$pr_root/repo" checkout -q master
git -C "$pr_root/repo" -c user.name=fixture -c user.email=fixture@example.test merge --no-ff -q feature -m merge
: > "$pr_root/summary"
set +e
(
  cd "$pr_root/repo"
  HOME="$pr_root/home" PATH="$pr_root/bin:$PATH" RUNNER_TEMP="$pr_root/temp" \
    GITHUB_WORKSPACE="$pr_root/repo" GITHUB_STEP_SUMMARY="$pr_root/summary" \
    IS_PR=yes PR_HEAD_SHA="$pr_head" PR_BASE_REF=main BASE_SHA_FALLBACK='' \
    SEMGREP_FIXTURE_JSON='{"paths":{"scanned":[]}}' sh "$SCRIPT"
) >"$pr_root/output" 2>&1
pr_rc=$?
set -e
[ "$pr_rc" -eq 0 ] || fail "PR 0-target fixture exited $pr_rc, expected 0"
assert_contains '::warning::semgrep scanned 0 targets while this PR changed 1 in-language file(s)' "$pr_root/output"

symlink_root="$TEST_ROOT/symlink"
# repo + semgrep stand-in are created by run_main_fixture below; here we only
# pre-plant the output symlinks into temp/ so the script must clear them.
mkdir -p "$symlink_root/temp"
printf 'do not overwrite\n' > "$symlink_root/victim"
printf 'do not overwrite\n' > "$symlink_root/sarif-victim"
ln -s "$symlink_root/victim" "$symlink_root/temp/semgrep.json"
ln -s "$symlink_root/sarif-victim" "$symlink_root/temp/semgrep.sarif"
symlink_rc=$(run_main_fixture symlink '{"paths":{"scanned":["src/file.ts"]}}')
[ "$symlink_rc" -eq 0 ] || fail "symlink fixture exited $symlink_rc, expected 0"
[ ! -L "$symlink_root/temp/semgrep.json" ] || fail "semgrep.json symlink was not removed"
[ ! -L "$symlink_root/temp/semgrep.sarif" ] || fail "semgrep.sarif symlink was not removed"
[ "$(cat "$symlink_root/victim")" = 'do not overwrite' ] || fail "semgrep output followed a planted symlink"
[ "$(cat "$symlink_root/sarif-victim")" = 'do not overwrite' ] || fail "semgrep SARIF output followed a planted symlink"

echo "semgrep-scan fixtures: PASS"
