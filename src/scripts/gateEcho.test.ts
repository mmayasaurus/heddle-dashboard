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

    expect(gate).toContain("    needs: [web, rust, rust-test]");
    expect(gate).toContain("    if: always()");
    expect(gate).toContain("      checks: write");
    expect(gate).toContain("    timeout-minutes: 50");
    expect(shell).toContain("for i in $(seq 1 105); do");
    expect(shell).toContain("--paginate --slurp");
    expect(shell).toContain("[.[].check_runs[]]");
    expect(shell).toMatch(/if ! CR=\$\(gh api .* --paginate --slurp/);
    expect(shell).not.toContain("|| echo '{}'");
    expect(shell).toContain('if [ "$CONC" != "none" ] && [ "$INFLIGHT" = "0" ]; then');
    expect(shell).toContain('if [ "$CONC" = "none" ] && [ "$INFLIGHT" = "0" ]; then');
  });

  it("uses the commit-leaf regex in both directions", () => {
    const shell = verdictShell("gate");
    const inFlight = /^(build|web|rust)/;

    expect(shell).toContain('test("^(build|web|rust)")');
    expect(inFlight.test("web (pnpm build + vitest)")).toBe(true);
    expect(inFlight.test("rust (cargo check)")).toBe(true);
    for (const name of [
      "gate",
      "gate-verdict",
      "lint (eslint) — NON-required, red until HED-14",
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
    const marker = (conclusion: string) => ({
      name: "gate-verdict",
      started_at: "2026-08-19T00:00:00Z",
      status: "completed",
      conclusion,
    });
    const inFlight = (name: string) => ({
      name,
      started_at: "2026-08-19T00:01:00Z",
      status: "in_progress",
      conclusion: null,
    });

    // F3: the marker is only visible after pagination's second response page.
    expect(run(pages(page(), page(marker("success")))).status).toBe(0);

    // F2: an older success is unusable until matching commit leaves finish.
    const race = run("", [
      pages(page(marker("success"), inFlight("web (pnpm build + vitest)"))),
      pages(page(marker("failure"))),
    ]);
    expect(race.status).not.toBe(0);
    expect(race.stdout).toContain("real verdict for 0123456789abcdef was 'failure'");

    // F4: temporary API failures preserve unknown liveness and retry.
    const outageThenSuccess = run("", [
      ...Array.from({ length: 10 }, () => "__FAIL__"),
      pages(page(marker("success"))),
    ]);
    expect(outageThenSuccess.status).toBe(0);

    expect(run(pages(page(marker("failure")))).status).not.toBe(0);
    expect(run(pages(page())).status).not.toBe(0);
    expect(run("{malformed").status).not.toBe(0);

    // lint is intentionally outside the commit-leaf regex and cannot hold echoing.
    expect(
      run(pages(page(marker("success"), inFlight("lint (eslint) — NON-required, red until HED-14")))).status,
    ).toBe(0);
    // Generous timeout: this case spawns gh+jq per poll and does a ~10-poll
    // fail-closed accumulation; under full-suite concurrency on a loaded machine
    // subprocess-spawn latency can exceed vitest's 30s default (HED-182).
  }, 120000);
});
