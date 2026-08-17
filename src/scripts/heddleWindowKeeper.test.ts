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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    HEDDLE_CLAUDE_BIN: path.join(home, "fake-claude"),
    HEDDLE_ROTATE_NOTIFY: "0",
  };
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

function writeKeeperWindow(home: string, account: string, startedAt: number, resetsAt: number, used: number | null) {
  fs.writeFileSync(
    path.join(home, ".heddle", "usage", `claude-${account}.keeper.json`),
    JSON.stringify({ account, startedAt, resets_at: resetsAt, used, source: "keeper-ping" }),
  );
}

function seedRotationWindows(home: string, { activeUsed = 90, peerUsed = 20 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const resetsAt = now + 3600;
  writeTap(home, "acct1", now + 2, activeUsed, resetsAt);
  writeTap(home, "acct2", now + 1, peerUsed, resetsAt);
  return { now, resetsAt };
}

function advice(home: string) {
  return JSON.parse(fs.readFileSync(path.join(home, ".heddle", "rotation-advice.json"), "utf8"));
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

  it("skips a registry id whose sanitized filename collides with an earlier account", () => {
    const home = mkHome();
    fs.writeFileSync(
      path.join(home, ".heddle", "accounts.json"),
      JSON.stringify({
        claude: [
          { id: "team:a", configDir: null, loggedIn: true },
          { id: "team/a", configDir: "~/.claude-team-a", loggedIn: true },
        ],
      }),
    );
    const result = runKeeper(["--dry-run"], home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("collide after sanitization");
    expect(result.stdout).toContain("skipping 'team/a'");
    expect(result.stdout).toContain("team:a: UNKNOWN (no capture) → WOULD ping (dry-run)");
    expect(result.stdout).not.toContain("team/a: UNKNOWN");
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

  it("writes rotation advice for the freshest tap-sourced active account", () => {
    const home = mkHome();
    const { resetsAt } = seedRotationWindows(home);
    const result = runKeeper([], home);
    expect(result.status).toBe(0);
    expect(calls(home)).toEqual([]);

    const rotationAdvice = advice(home);
    expect(rotationAdvice.active).toEqual({ id: "acct1", usedPct: 90, resetsAt });
    expect(rotationAdvice.target).toEqual({ id: "acct2", usedPct: 20, resetsAt, source: "tap" });
    expect(rotationAdvice.command).toContain("acct2");
    expect(rotationAdvice.thresholdPct).toBe(85);
  });

  it("does not advise when the active tap usage is below the default rotation threshold", () => {
    const home = mkHome();
    seedRotationWindows(home, { activeUsed: 80 });
    const result = runKeeper([], home);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(home, ".heddle", "rotation-advice.json"))).toBe(false);
    expect(calls(home)).toEqual([]);
  });

  it("respects HEDDLE_ROTATE_PCT for rotation advice", () => {
    const home = mkHome();
    seedRotationWindows(home, { activeUsed: 80 });
    const result = runKeeper([], home, { HEDDLE_ROTATE_PCT: "75" });
    expect(result.status).toBe(0);
    expect(advice(home).thresholdPct).toBe(75);
    expect(calls(home)).toEqual([]);
  });

  it("does not advise from a keeper-started window without a tap capture", () => {
    const home = mkHome();
    const now = Math.floor(Date.now() / 1000);
    writeKeeperWindow(home, "acct1", now, now + 3600, 90);
    writeKeeperWindow(home, "acct2", now, now + 3600, 20);
    const result = runKeeper([], home);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(home, ".heddle", "rotation-advice.json"))).toBe(false);
    expect(calls(home)).toEqual([]);
  });

  it("deduplicates rotation advice for the same active window", () => {
    const home = mkHome();
    const { resetsAt } = seedRotationWindows(home);
    fs.writeFileSync(
      path.join(home, ".heddle", "window-keeper.state.json"),
      JSON.stringify({ last_ping_ts: 123, last_ping_acct: "acct2" }),
    );
    expect(runKeeper([], home).status).toBe(0);
    const first = advice(home);
    first.advisedAt = "must-not-be-overwritten";
    fs.writeFileSync(path.join(home, ".heddle", "rotation-advice.json"), JSON.stringify(first));

    expect(runKeeper([], home).status).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(home, ".heddle", "window-keeper.state.json"), "utf8"));
    expect(advice(home).advisedAt).toBe("must-not-be-overwritten");
    expect(state.last_ping_ts).toBe(123);
    expect(state.last_ping_acct).toBe("acct2");
    expect(state.rotationAdvice).toContainEqual({ activeId: "acct1", resetsAt });
    expect(calls(home)).toEqual([]);
  });

  it("advises again after the active tap window rolls over", () => {
    const home = mkHome();
    const { now, resetsAt } = seedRotationWindows(home);
    expect(runKeeper([], home).status).toBe(0);
    const first = advice(home);
    first.advisedAt = "old-window";
    fs.writeFileSync(path.join(home, ".heddle", "rotation-advice.json"), JSON.stringify(first));
    writeTap(home, "acct1", now + 3, 90, resetsAt + 3600);

    expect(runKeeper([], home).status).toBe(0);
    expect(advice(home).advisedAt).not.toBe("old-window");
    expect(advice(home).active.resetsAt).toBe(resetsAt + 3600);
    expect(calls(home)).toEqual([]);
  });

  it("writes targetless rotation advice when no eligible target exists", () => {
    const home = mkHome();
    seedRotationWindows(home, { peerUsed: 90 });
    const result = runKeeper([], home);
    expect(result.status).toBe(0);
    expect(advice(home).target).toBeNull();
    expect(advice(home).reason).toContain("every other logged-in account is also at/over the threshold or unknown");
    expect(calls(home)).toEqual([]);
  });

  it("does not choose a logged-out account as the rotation target", () => {
    const home = mkHome();
    const { now, resetsAt } = seedRotationWindows(home);
    writeTap(home, "acct3", now + 3, 1, resetsAt);
    const result = runKeeper([], home);
    expect(result.status).toBe(0);
    expect(advice(home).target.id).toBe("acct2");
    expect(calls(home)).toEqual([]);
  });

  it("prefers known target usage over an unknown keeper window", () => {
    const home = mkHome();
    const { now, resetsAt } = seedRotationWindows(home);
    const withUnknownPeer = {
      claude: [...registry.claude, { id: "acct4", configDir: "~/.claude-acct4", loggedIn: true }],
    };
    fs.writeFileSync(path.join(home, ".heddle", "accounts.json"), JSON.stringify(withUnknownPeer));
    writeKeeperWindow(home, "acct4", now, resetsAt, null);
    const result = runKeeper([], home);
    expect(result.status).toBe(0);
    expect(advice(home).target.id).toBe("acct2");
    expect(calls(home)).toEqual([]);
  });

  it("does not invoke Claude or a relaunch command while advising", () => {
    const home = mkHome();
    seedRotationWindows(home);
    const result = runKeeper([], home, {
      HEDDLE_RELAUNCH_TEMPLATE: `${path.join(home, "fake-claude")} --relaunch {account}`,
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(home, ".heddle", "rotation-advice.json"))).toBe(true);
    expect(calls(home)).toEqual([]);
  });
});
