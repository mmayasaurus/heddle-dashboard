import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const workflow = readFileSync(join(process.cwd(), ".github/workflows/gate.yml"), "utf8");
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "heddle-gate-echo-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function jobBlock(job: string): string {
  const startMarker = `  ${job}:\n`;
  const start = workflow.indexOf(startMarker);
  if (start < 0) throw new Error(`workflow job ${job} was not found`);
  const nextJob = workflow.slice(start + startMarker.length).search(/^  [a-z0-9-]+:\n/m);
  return nextJob < 0
    ? workflow.slice(start)
    : workflow.slice(start, start + startMarker.length + nextJob);
}

function verdictShell(job: string): string {
  const block = jobBlock(job);
  const step = block.indexOf("      - name: Verdict (commit) or echo (edit)\n");
  if (step < 0) throw new Error(`workflow job ${job} has no verdict/echo step`);
  const run = block.indexOf("        run: |\n", step);
  if (run < 0) throw new Error(`workflow job ${job} has no verdict/echo shell`);
  const lines = block.slice(run + "        run: |\n".length).split("\n");
  const firstContent = lines.find((line) => line.trim() !== "");
  if (!firstContent) throw new Error(`workflow job ${job} has an empty verdict/echo shell`);
  const baseIndent = firstContent.match(/^\s*/)?.[0] ?? "";
  const shell: string[] = [];
  for (const line of lines) {
    if (line !== "" && !line.startsWith(baseIndent)) break;
    shell.push(line === "" ? line : line.slice(baseIndent.length));
  }
  return `${shell.join("\n")}\n`;
}

describe("regression HED-182 — gate edit echo reflects the commit verdict", () => {
  const hasJq = spawnSync("jq", ["--version"], { stdio: "ignore" }).status === 0;

  it("keeps the gate aggregation and echo liveness safeguards structurally intact", () => {
    const gate = jobBlock("gate");
    const shell = verdictShell("gate");

    expect(gate).toContain("    needs: [web, rust, rust-test, lint]");
    expect(gate).toContain("    if: always()");
    expect(gate).toContain("      checks: write");
    expect(gate).toContain("    timeout-minutes: 55");
    expect(shell).toContain("for i in $(seq 1 105); do");
    expect(shell).toContain("--paginate --slurp");
    expect(shell).toContain("[.[].check_runs[]]");
    expect(shell).toMatch(/if ! CR=\$\(gh api .* --paginate --slurp/);
    expect(shell).not.toContain("|| echo '{}'");
    expect(shell).toContain('if [ "$CONC" != "none" ] && [ "$INFLIGHT" = "0" ]; then');
    expect(shell).toContain('if [ "$CONC" = "none" ] && [ "$INFLIGHT" = "0" ]; then');
    // D2: exit 0 is reachable only via the accept-break's VERDICT, never a
    // retained CONC at loop exhaustion.
    expect(shell).toContain('VERDICT="$CONC"; break');
    expect(shell).toContain('case "$VERDICT" in');
    // D1: a gate-verdict marker is accepted only when it is newer than the newest
    // commit-path leaf (freshness folded into the CONC jq filter).
    expect(shell).toContain("$m.started_at >= $leaf");
  });

  it("uses the commit-leaf regex in both directions", () => {
    const shell = verdictShell("gate");
    const inFlight = /^(build|web|rust|lint)/;

    expect(shell).toContain('test("^(build|web|rust|lint)")');
    expect(inFlight.test("web (pnpm build + vitest)")).toBe(true);
    expect(inFlight.test("rust (cargo check)")).toBe(true);
    expect(inFlight.test("rust (cargo test)")).toBe(true);
    // HED-207: lint is now a required aggregator leaf, so the echo must watch it.
    expect(inFlight.test("lint (eslint)")).toBe(true);
    for (const name of [
      "gate",
      "gate-verdict",
      // The `^lint` alternative is anchored: `actionlint` (a separate check-run)
      // must NOT match, or the echo would wait on / weigh an unrelated job.
      "actionlint",
    ]) {
      expect(inFlight.test(name)).toBe(false);
    }
  });

  it.skipIf(!hasJq)("runs the edit echo against paginated verdicts, races, outages, and invalid responses", () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    const summary = join(dir, "summary.md");
    const gh = join(bin, "gh");
    const sleep = join(bin, "sleep");
    mkdirSync(bin);
    writeFileSync(gh, `#!/bin/sh
if [ -n "\${CHECKS_SEQUENCE_FILE:-}" ]; then
  COUNT_FILE="\${CHECKS_SEQUENCE_FILE}.count"
  I=$(cat "$COUNT_FILE" 2>/dev/null || printf '1')
  RESPONSE=$(sed -n "\${I}p" "$CHECKS_SEQUENCE_FILE")
  printf '%s\\n' "$((I + 1))" > "$COUNT_FILE"
  if [ "$RESPONSE" = '__FAIL__' ]; then exit 1; fi
  printf '%s\\n' "$RESPONSE"
else
  printf '%s\\n' "$CHECKS_JSON"
fi
`);
    writeFileSync(sleep, "#!/bin/sh\nexit 0\n");
    chmodSync(gh, 0o755);
    chmodSync(sleep, 0o755);

    const run = (checksJson: string, responses?: string[]) => {
      const sequence = join(dir, `responses-${Math.random()}.txt`);
      if (responses) writeFileSync(sequence, `${responses.join("\n")}\n`);
      return spawnSync("/bin/sh", ["-c", verdictShell("gate")], {
        encoding: "utf8",
        env: {
          ...process.env,
          CHECKS_JSON: checksJson,
          CHECKS_SEQUENCE_FILE: responses ? sequence : "",
          GH_TOKEN: "test-token",
          GITHUB_STEP_SUMMARY: summary,
          IS_EDIT: "true",
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          REPO: "owner/repo",
          SHA: "0123456789abcdef",
        },
      });
    };

    const page = (...checkRuns: object[]) => ({ check_runs: checkRuns });
    const pages = (...allPages: object[]) => JSON.stringify(allPages);
    const T = (m: number) => `2026-08-19T00:${String(m).padStart(2, "0")}:00Z`;
    // Marker/leaf carry explicit timestamps — the D1 freshness filter accepts a
    // gate-verdict marker only when it is NEWER than the newest commit-path leaf.
    const marker = (conclusion: string, ts: string) => ({
      name: "gate-verdict",
      started_at: ts,
      status: "completed",
      conclusion,
    });
    const leaf = (status: string, ts: string, conclusion: string | null = null) => ({
      name: "web (pnpm build + vitest)",
      started_at: ts,
      status,
      conclusion,
    });
    const named = (name: string, status: string, ts: string) => ({
      name,
      started_at: ts,
      status,
      conclusion: null,
    });

    // A FRESH success (leaf completed, marker posted after it) → gate green.
    expect(run(pages(page(leaf("completed", T(0), "success"), marker("success", T(5))))).status).toBe(0);

    // F3: the same fresh pair split across two slurped pages → still green.
    expect(
      run(pages(page(leaf("completed", T(0), "success")), page(marker("success", T(5))))).status,
    ).toBe(0);

    // Finding 1 (skipped-leaf false-RED guard): a title/body edit's OWN leaf jobs
    // are if:-false → `skipped` check-runs whose started_at is NEWER than the
    // marker. They must NOT count toward the freshness max, or the marker reads
    // stale and the gate reds on every bot edit (live-confirmed on heddle#57). A
    // real leaf + fresh marker + a NEWER skipped leaf → still green. (Without
    // `.conclusion != "skipped"` in the $leaf select, this exits non-zero.)
    expect(run(pages(page(
      leaf("completed", T(0), "success"),
      marker("success", T(5)),
      leaf("completed", T(20), "skipped"),
    ))).status).toBe(0);

    // >= boundary: a marker whose started_at equals the newest real leaf's is
    // accepted (a marker never posts before its leaf starts; equal → fresh).
    expect(run(pages(page(leaf("completed", T(0), "success"), marker("success", T(0))))).status).toBe(0);

    // D1 (freshness isolation — THE GAP that would false-green): the new build has
    // completed/FAILURE but its fresh failure marker has NOT posted yet; only the
    // OLD success marker exists. Freshness rejects the stale success (older than
    // the completed leaf) → CONC="none" every poll → fail closed, never "gate
    // green". WITHOUT the filter, INFLIGHT=0 + a success marker is accepted here →
    // the false green this fix closes. Single response (repeats every poll).
    const staleGap = run(pages(page(marker("success", T(0)), leaf("completed", T(10), "failure"))));
    expect(staleGap.status).not.toBe(0);
    expect(staleGap.stdout).not.toContain("gate green");

    // D1 (transition): poll 1 the new build is still in flight and the old marker
    // is not fresh → wait; poll 2 the new build completed and a fresh FAILURE
    // marker exists → echo the failure. RED, "was 'failure'".
    const staleRace = run("", [
      pages(page(marker("success", T(0)), leaf("in_progress", T(10)))),
      pages(page(marker("success", T(0)), leaf("completed", T(10), "failure"), marker("failure", T(15)))),
    ]);
    expect(staleRace.status).not.toBe(0);
    expect(staleRace.stdout).toContain("real verdict for 0123456789abcdef was 'failure'");

    // D2 (exhaustion false-GREEN guard): a FRESH success marker read alongside an
    // in-flight leaf (an eventual-consistency race), then the API is out for the
    // rest of the loop. The accept-break never fires (a leaf was in flight), so
    // VERDICT stays empty and the loop exhausts → fail closed, NOT green. (Without
    // the VERDICT flag, the retained CONC=success greens the gate.) __FAIL__ padded
    // past the 105-poll belt so `sed` never returns empty past EOF.
    const staleThenOutage = run("", [
      pages(page(leaf("in_progress", T(0)), marker("success", T(5)))),
      ...Array.from({ length: 120 }, () => "__FAIL__"),
    ]);
    expect(staleThenOutage.status).not.toBe(0);

    // F4: a transient API outage then a FRESH success → green.
    const outageThenSuccess = run("", [
      ...Array.from({ length: 10 }, () => "__FAIL__"),
      pages(page(leaf("completed", T(0), "success"), marker("success", T(5)))),
    ]);
    expect(outageThenSuccess.status).toBe(0);

    // codex P1 (DRY reset on failed read): a "verifiably gone" streak must NOT
    // survive an API outage. 5 gone-polls build DRY→5, then an outage, then a
    // gone-poll — WITHOUT the reset the pre-outage DRY + one post-outage gone-read
    // hits the fail-closed threshold and reds prematurely; WITH the reset the streak
    // restarts, so the echo keeps waiting and accepts the arriving fresh marker.
    const dryStreakBrokenByOutage = run("", [
      ...Array.from({ length: 5 }, () => pages(page())),
      ...Array.from({ length: 7 }, () => "__FAIL__"),
      pages(page()),
      pages(page(leaf("completed", T(0), "success"), marker("success", T(5)))),
      ...Array.from({ length: 60 }, () => "__FAIL__"),
    ]);
    expect(dryStreakBrokenByOutage.status).toBe(0);

    // A fresh FAILURE marker → red; no marker at all → red; malformed → red.
    expect(run(pages(page(leaf("completed", T(0), "failure"), marker("failure", T(5))))).status).not.toBe(0);
    expect(run(pages(page(leaf("completed", T(0), "success")))).status).not.toBe(0);
    expect(run("{malformed").status).not.toBe(0);

    // HED-207 (lint folded into the aggregator) — the LOAD-BEARING INFLIGHT lock:
    // lint is now a held leaf. web is complete but lint is still in_progress and there
    // is NO fresh marker for 10 polls, then the marker arrives. The echo must WAIT
    // through the 10 polls (not fail closed) because INFLIGHT counts lint, then accept.
    // Without `|lint` in INFLIGHT those 10 no-marker polls read INFLIGHT=0 + CONC=none
    // → DRY hits the fail-closed threshold (i>9 && DRY>=6) at poll 10 → RED before the
    // marker is ever seen. So this reds WITHOUT the INFLIGHT `|lint` change (mutation-
    // verified) and greens WITH it. It exercises INFLIGHT only — the freshness $leaf
    // lock is the separate `lintFreshness` case below.
    const lintHolds = run("", [
      ...Array.from({ length: 10 }, () => pages(page(
        leaf("completed", T(0), "success"),
        named("lint (eslint)", "in_progress", T(2)),
      ))),
      pages(page(
        leaf("completed", T(0), "success"),
        named("lint (eslint)", "completed", T(2)),
        marker("success", T(10)),
      )),
      ...Array.from({ length: 60 }, () => "__FAIL__"),
    ]);
    expect(lintHolds.status).toBe(0);

    // HED-207 (grok finding 1) — the LOAD-BEARING FRESHNESS $leaf lock, independent of
    // INFLIGHT: a same-SHA lint-only re-run (GitHub "Re-run failed jobs" reuses web/rust
    // and runs a NEW lint that FAILS) leaves the OLD success gate-verdict marker as the
    // latest marker. lint completed at T(20) is NEWER than that marker (T(5)), so the
    // marker must read STALE → fail closed. WITHOUT `|lint` in the freshness $leaf
    // selector, $leaf=web T(0), the old T(5) success marker reads fresh, INFLIGHT=0 →
    // false-GREEN masking the lint failure. WITH it, $leaf=lint T(20) → CONC=none → red.
    // (lintHolds above cannot catch this — it has no marker, so CONC is "none"
    // regardless of the $leaf selector.)
    const lintFreshness = run(pages(page(
      leaf("completed", T(0), "success"),
      { name: "lint (eslint)", started_at: T(20), status: "completed", conclusion: "failure" },
      marker("success", T(5)),
    )));
    expect(lintFreshness.status).not.toBe(0);
    expect(lintFreshness.stdout).not.toContain("gate green");

    // Commit path (HED-207): the verdict is `all(needs; .result == "success")` —
    // generic over `needs` — so a failing lint leaf reds the required gate, and all
    // success (incl. lint) greens. IS_EDIT=false takes the commit branch, reading
    // RESULTS instead of polling check-runs.
    const runCommit = (results: Record<string, { result: string }>) =>
      spawnSync("/bin/sh", ["-c", verdictShell("gate")], {
        encoding: "utf8",
        env: {
          ...process.env,
          CHECKS_JSON: "[]",
          CHECKS_SEQUENCE_FILE: "",
          GH_TOKEN: "test-token",
          GITHUB_STEP_SUMMARY: summary,
          IS_EDIT: "false",
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          REPO: "owner/repo",
          SHA: "0123456789abcdef",
          RESULTS: JSON.stringify(results),
        },
      });
    const ok = { result: "success" };
    expect(runCommit({ web: ok, rust: ok, "rust-test": ok, lint: { result: "failure" } }).status).not.toBe(0);
    expect(runCommit({ web: ok, rust: ok, "rust-test": ok, lint: ok }).status).toBe(0);
    // Commit-path fail-closed (grok claim 4): a lint that is skipped or cancelled on
    // the commit path is not "success" → MARK=failure → red.
    expect(runCommit({ web: ok, rust: ok, "rust-test": ok, lint: { result: "skipped" } }).status).not.toBe(0);
    expect(runCommit({ web: ok, rust: ok, "rust-test": ok, lint: { result: "cancelled" } }).status).not.toBe(0);

    // Anchor isolation (grok claim 6), behavioral: `actionlint` (a separate hygiene
    // check-run) does NOT start with build/web/rust/lint, so it must NOT hold the echo
    // — a completed leaf + fresh marker greens even while actionlint is in flight. If
    // `^lint` ever widened to match `actionlint`, INFLIGHT would count it and this loop
    // would wait forever → red; the green assert locks the anchor.
    expect(run(pages(page(
      leaf("completed", T(0), "success"),
      marker("success", T(5)),
      named("actionlint", "in_progress", T(2)),
    ))).status).toBe(0);
    // Generous timeout: each case spawns gh+jq per poll and the D2/no-marker cases
    // do a long fail-closed accumulation; under full-suite concurrency on a loaded
    // machine subprocess-spawn latency can exceed vitest's 30s default (HED-182).
  }, 120000);
});
