import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const keeperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/heddle-window-keeper.py");
const hasPython3 = spawnSync("python3", ["--version"]).status === 0;
const homes: string[] = [];
const registry = {
  claude: [
    { id: "acct1", configDir: null, loggedIn: true },
    { id: "acct2", configDir: "~/.claude-acct2", loggedIn: true },
    { id: "acct3", configDir: "~/.claude-acct3", loggedIn: false },
  ],
};

function mkHome({ usageDir = true }: { usageDir?: boolean } = {}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "heddle-test-"));
  homes.push(home);
  if (usageDir) fs.mkdirSync(path.join(home, ".heddle", "usage"), { recursive: true });
  else fs.mkdirSync(path.join(home, ".heddle"), { recursive: true });
  fs.writeFileSync(path.join(home, ".heddle", "accounts.json"), JSON.stringify(registry));
  const fakeClaude = path.join(home, "fake-claude");
  fs.writeFileSync(
    fakeClaude,
    '#!/bin/sh\nprintf \'CFG=%s ARGS=%s\\n\' "${CLAUDE_CONFIG_DIR-<unset>}" "$*" >> "$HOME/.heddle/fake-claude.calls"\nprintf \'{"result":"ok"}\\n\'\n',
  );
  fs.chmodSync(fakeClaude, 0o755);
  return home;
}

function runKeeper(args: string[], home: string, overrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, HEDDLE_CLAUDE_BIN: path.join(home, "fake-claude") };
  delete env.CLAUDE_CONFIG_DIR;
  Object.assign(env, overrides);
  return spawnSync("python3", [keeperPath, ...args], { cwd: path.resolve(path.dirname(keeperPath), ".."), env, encoding: "utf8" });
}

function calls(home: string): string[] {
  const callsPath = path.join(home, ".heddle", "fake-claude.calls");
  return fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8").trimEnd().split("\n") : [];
}

function establishAcct1Window(home: string) {
  const result = runKeeper([], home);
  expect(result.status).toBe(0);
  expect(calls(home)).toHaveLength(1);
}

function writeTap(home: string, account: string, capturedAt: number, used: number, resetsAt: number) {
  fs.writeFileSync(
    path.join(home, ".heddle", "usage", `claude-${account}.json`),
    JSON.stringify({ capturedAt, rate_limits: { five_hour: { used_percentage: used, resets_at: resetsAt } } }),
  );
}

function tempFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...tempFiles(entryPath));
    else if (entry.name.endsWith(".tmp")) files.push(entryPath);
  }
  return files;
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!hasPython3)("heddle-window-keeper", () => {
  it("rejects --verify without an account id", () => {
    const home = mkHome();
    for (const args of [["--verify"], ["--verify", "--dry-run"]]) {
      const result = runKeeper(args, home);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage:");
    }
  });

  it("reports eligible accounts without sending pings in dry-run mode", () => {
    const home = mkHome();
    const result = runKeeper(["--dry-run"], home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("acct1: UNKNOWN (no capture) → WOULD ping (dry-run)");
    expect(result.stdout).toContain("acct2: UNKNOWN (no capture) → WOULD ping (dry-run)");
    expect(result.stdout).not.toContain("acct3");
    expect(fs.existsSync(path.join(home, ".heddle", "fake-claude.calls"))).toBe(false);
  });

  it("starts one default-account window with atomic keeper and state records", () => {
    const home = mkHome();
    const startedAt = Math.floor(Date.now() / 1000);
    const result = runKeeper([], home);
    expect(result.status).toBe(0);
    expect(calls(home)).toHaveLength(1);
    expect(calls(home)[0]).toContain("CFG=<unset>");
    expect(calls(home)[0]).toContain("--model");
    expect(calls(home)[0]).toContain("-p");

    const usage = path.join(home, ".heddle", "usage");
    const anchor = JSON.parse(fs.readFileSync(path.join(usage, "claude-acct1.keeper.json"), "utf8"));
    const state = JSON.parse(fs.readFileSync(path.join(home, ".heddle", "window-keeper.state.json"), "utf8"));
    expect(anchor.account).toBe("acct1");
    expect(anchor.startedAt).toBeGreaterThanOrEqual(startedAt);
    expect(anchor.resets_at - anchor.startedAt).toBe(18000);
    expect(state.last_ping_acct).toBe("acct1");
    expect(tempFiles(path.join(home, ".heddle"))).toEqual([]);
    expect(tempFiles(usage)).toEqual([]);
  });

  it("creates the usage directory when absent", () => {
    const home = mkHome({ usageDir: false });
    const result = runKeeper([], home);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(home, ".heddle", "usage", "claude-acct1.keeper.json"))).toBe(true);
  });

  it("does not re-ping a keeper-started live window and observes the stagger", () => {
    const home = mkHome();
    establishAcct1Window(home);
    const result = runKeeper([], home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("acct1: live (keeper)");
    expect(result.stdout).toContain("nothing to do");
    expect(result.stdout).toMatch(/acct2: .*stagger slot not due/);
    expect(calls(home)).toHaveLength(1);
  });

  it("pings the next account when the stagger is disabled", () => {
    const home = mkHome();
    establishAcct1Window(home);
    const result = runKeeper([], home, { HEDDLE_STAGGER_MIN: "0" });
    expect(result.status).toBe(0);
    expect(calls(home)).toHaveLength(2);
    expect(calls(home)[1]).toContain(`CFG=${path.join(home, ".claude-acct2")}`);
  });

  it("uses a fresher live tap capture instead of pinging that account", () => {
    const home = mkHome();
    establishAcct1Window(home);
    const now = Math.floor(Date.now() / 1000);
    writeTap(home, "acct2", now, 7, now + 3600);
    const result = runKeeper([], home, { HEDDLE_STAGGER_MIN: "0" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("acct2: live (tap), 7% used");
    expect(calls(home)).toHaveLength(1);
  });

  it("pings an account with an expired tap capture", () => {
    const home = mkHome();
    establishAcct1Window(home);
    const now = Math.floor(Date.now() / 1000);
    writeTap(home, "acct2", now, 7, now - 60);
    const result = runKeeper([], home, { HEDDLE_STAGGER_MIN: "0" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/acct2: EXPIRED.*pinged ok=True/);
    expect(calls(home)).toHaveLength(2);
  });

  it("survives an unavailable Claude binary without persisting anchors", () => {
    const home = mkHome();
    const result = runKeeper([], home, { HEDDLE_CLAUDE_BIN: path.join(home, "does-not-exist") });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pinged ok=False");
    expect(result.stdout).toContain("err=");
    expect(fs.existsSync(path.join(home, ".heddle", "usage", "claude-acct1.keeper.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".heddle", "window-keeper.state.json"))).toBe(false);
  });

  it("warns once when its log path is unwritable while still reporting dry-run decisions", () => {
    const home = mkHome();
    fs.mkdirSync(path.join(home, ".heddle", "window-keeper.log"));
    const result = runKeeper(["--dry-run"], home);
    expect(result.status).toBe(0);
    expect(result.stderr.match(/warning: unable to write window keeper log/g)).toHaveLength(1);
    expect(result.stdout).toContain("acct1: UNKNOWN (no capture) → WOULD ping (dry-run)");
    expect(result.stdout).toContain("acct2: UNKNOWN (no capture) → WOULD ping (dry-run)");
  });
});
