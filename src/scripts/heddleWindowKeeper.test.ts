import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
  const unavailableSecurity = path.join(home, "fake-security-unavailable");
  fs.writeFileSync(unavailableSecurity, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(unavailableSecurity, 0o755);
  return home;
}

function runKeeper(args: string[], home: string, overrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    HEDDLE_CLAUDE_BIN: path.join(home, "fake-claude"),
    HEDDLE_ROTATE_NOTIFY: "0",
    HEDDLE_SECURITY_BIN: path.join(home, "fake-security-unavailable"),
    HEDDLE_OAUTH_USAGE_URL: `file://${path.join(home, "missing-oauth-usage.json")}`,
    HEDDLE_OAUTH_ALLOW_INSECURE_URL: "1",
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

type TranscriptTurn = {
  ownerAccountUuid: string;
  timestamp: string;
  model: string;
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
  prompt?: string;
  isSidechain?: boolean;
};

function setupTranscriptAccounts(home: string) {
  const sharedProjects = path.join(home, "shared-projects");
  fs.mkdirSync(sharedProjects, { recursive: true });
  const accounts = [
    { id: "acct1", configDir: path.join(home, ".claude"), uuid: "uuid-acct1" },
    { id: "acct2", configDir: path.join(home, ".claude-acct2"), uuid: "uuid-acct2" },
  ];
  for (const account of accounts) {
    fs.mkdirSync(account.configDir, { recursive: true });
    fs.writeFileSync(path.join(account.configDir, ".claude.json"), JSON.stringify({ accountUuid: account.uuid }));
    fs.symlinkSync(sharedProjects, path.join(account.configDir, "projects"), "dir");
  }
  return { accounts, sharedProjects };
}

function writeTranscriptWindow(home: string, account: string, resetsAt: number) {
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(
    path.join(home, ".heddle", "usage", `claude-${account}.json`),
    JSON.stringify({
      capturedAt: now,
      rate_limits: {
        five_hour: { used_percentage: 1, resets_at: now + 3600 },
        seven_day: { resets_at: resetsAt },
      },
    }),
  );
}

function transcriptLine(turn: TranscriptTurn): string {
  return JSON.stringify({
    type: "assistant",
    ownerAccountUuid: turn.ownerAccountUuid,
    timestamp: turn.timestamp,
    ...(turn.isSidechain ? { isSidechain: true } : {}),
    message: {
      model: turn.model,
      usage: {
        input_tokens: turn.input ?? 0,
        output_tokens: turn.output ?? 0,
        cache_creation_input_tokens: turn.cacheCreation ?? 0,
        cache_read_input_tokens: turn.cacheRead ?? 0,
      },
      content: turn.prompt ?? "fixture assistant content",
    },
  });
}

function writeTranscript(file: string, turns: TranscriptTurn[]) {
  fs.writeFileSync(file, `${turns.map(transcriptLine).join("\n")}\n`);
}

function transcriptSummary(home: string, account: string) {
  return JSON.parse(fs.readFileSync(path.join(home, ".heddle", "usage", `claude-${account}.turns.json`), "utf8"));
}

function writeRegistry(home: string, claude: unknown[]) {
  fs.writeFileSync(path.join(home, ".heddle", "accounts.json"), JSON.stringify({ claude }));
}

function writeFakeSecurity(home: string, token: string, { marker }: { marker?: string } = {}) {
  const security = path.join(home, "fake-security");
  fs.writeFileSync(
    security,
    `#!/bin/sh\n${marker ? `printf x >> ${JSON.stringify(marker)}\n` : ""}printf '%s\\n' '${JSON.stringify({ claudeAiOauth: { accessToken: token } })}'\n`,
  );
  fs.chmodSync(security, 0o755);
  return security;
}

function writeUnavailableSecurity(home: string, marker: string) {
  const security = path.join(home, "fake-security-unavailable-with-marker");
  fs.writeFileSync(security, `#!/bin/sh\nprintf x >> ${JSON.stringify(marker)}\nexit 1\n`);
  fs.chmodSync(security, 0o755);
  return security;
}

function writeOauthFixture(home: string, percent = 77) {
  const fixture = path.join(home, "oauth-usage.json");
  fs.writeFileSync(fixture, JSON.stringify({ limits: [
    { kind: "five_hour", percent: 12 },
    { kind: "seven_day", percent: 34 },
    { kind: "weekly_scoped", percent, scope: { model: { display_name: "Fable" } } },
    { kind: "weekly_scoped", percent: 56, scope: { model: { display_name: "Opus" } } },
  ] }));
  return fixture;
}

function oauthUsage(home: string, account: string) {
  return JSON.parse(fs.readFileSync(path.join(home, ".heddle", "usage", `claude-${account}.oauth-usage.json`), "utf8"));
}

function contentsIfPresent(file: string) {
  return fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file, "utf8") : "";
}

function expectTokenPrivate(home: string, result: ReturnType<typeof runKeeper>, token: string, account = "acct1") {
  const artifacts = [
    result.stdout,
    result.stderr,
    contentsIfPresent(path.join(home, ".heddle", "window-keeper.log")),
    contentsIfPresent(path.join(home, ".heddle", "usage", `claude-${account}.oauth-usage.json`)),
    contentsIfPresent(path.join(home, ".heddle", "window-keeper.state.json")),
    contentsIfPresent(path.join(home, ".heddle", "oauth-usage-state.json")),
    contentsIfPresent(path.join(home, ".heddle", "transcript-usage-state.json")),
    contentsIfPresent(path.join(home, ".heddle", "transcript-offsets.json")),
  ];
  for (const artifact of artifacts) expect(artifact).not.toContain(token);
}

function runRedirectRefusalFixture(home: string, token: string) {
  const configDir = path.join(home, ".claude-acct1");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, ".credentials.json"), JSON.stringify({ accessToken: token }));
  return spawnSync("python3", ["-c", `
import os, runpy, sys, urllib.request
from email.message import Message
from io import BytesIO
from urllib.response import addinfourl
home, source, config_dir = sys.argv[1:]
os.environ["HOME"] = home
os.environ["HEDDLE_OAUTH_USAGE_URL"] = "https://redirect-origin.test/usage"
os.environ["HEDDLE_OAUTH_CACHE_SECS"] = "0"
keeper = runpy.run_path(source, run_name="oauth_redirect_fixture")
first_hop_headers, redirected_requests = [], []
class RedirectingHTTPS(urllib.request.HTTPSHandler):
    def https_open(self, request):
        if request.full_url == "https://redirect-origin.test/usage":
            first_hop_headers.append(request.get_header("Authorization"))
            headers = Message()
            headers["Location"] = "https://different-origin.test/usage"
            return addinfourl(BytesIO(b"{}"), headers, request.full_url, 302)
        redirected_requests.append(request.full_url)
        return addinfourl(BytesIO(b"{}"), Message(), request.full_url, 200)
real_build_opener = keeper["urllib"].request.build_opener
keeper["urllib"].request.build_opener = lambda *handlers: real_build_opener(RedirectingHTTPS(), *handlers)
keeper["refresh_oauth_usage"]([{"id": "acct1", "configDir": config_dir}], keeper["time"].time())
assert first_hop_headers and not redirected_requests
assert open(os.path.join(home, ".heddle", "usage", "claude-acct1.oauth-usage.json")).read() == '{"fablePct": 33}'
print("redirect refused")
`, home, keeperPath, configDir], { encoding: "utf8" });
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

  it("pings the next account when the stagger slot is due", () => {
    const home = mkHome();
    establishAcct1Window(home);
    fs.writeFileSync(
      path.join(home, ".heddle", "window-keeper.state.json"),
      JSON.stringify({ last_ping_ts: Math.floor(Date.now() / 1000) - 61, last_ping_acct: "acct1" }),
    );
    const result = runKeeper([], home, { HEDDLE_STAGGER_MIN: "1" });
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
    fs.writeFileSync(
      path.join(home, ".heddle", "window-keeper.state.json"),
      JSON.stringify({ last_ping_ts: now - 61, last_ping_acct: "acct1" }),
    );
    const result = runKeeper([], home, { HEDDLE_STAGGER_MIN: "1" });
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

  it("keeps windows alive when HEDDLE_ROTATE_PCT is malformed", () => {
    for (const rotatePct of ["abc", "85.5", ""]) {
      const home = mkHome();
      const result = runKeeper([], home, { HEDDLE_ROTATE_PCT: rotatePct });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("invalid HEDDLE_ROTATE_PCT");
      expect(calls(home)).toHaveLength(1);
    }
  });

  it("clamps HEDDLE_ROTATE_PCT outside 1-100", () => {
    const zeroHome = mkHome();
    seedRotationWindows(zeroHome, { activeUsed: 0 });
    expect(runKeeper([], zeroHome, { HEDDLE_ROTATE_PCT: "0" }).status).toBe(0);
    expect(fs.existsSync(path.join(zeroHome, ".heddle", "rotation-advice.json"))).toBe(false);

    const highHome = mkHome();
    seedRotationWindows(highHome, { activeUsed: 100 });
    expect(runKeeper([], highHome, { HEDDLE_ROTATE_PCT: "250" }).status).toBe(0);
    expect(advice(highHome).thresholdPct).toBe(100);
  });

  it("does not advise from an expired tap window for the busiest account", () => {
    const home = mkHome();
    const { now } = seedRotationWindows(home);
    writeTap(home, "acct1", now + 3, 90, now - 1);

    const result = runKeeper([], home);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(home, ".heddle", "rotation-advice.json"))).toBe(false);
  });

  it("does not choose an expired low-usage target", () => {
    const home = mkHome();
    const now = Math.floor(Date.now() / 1000);
    const resetsAt = now + 3600;
    fs.writeFileSync(
      path.join(home, ".heddle", "accounts.json"),
      JSON.stringify({ claude: [...registry.claude.slice(0, 2), { id: "acct3", configDir: "~/.claude-acct3", loggedIn: true }] }),
    );
    writeTap(home, "acct1", now + 3, 90, resetsAt);
    writeTap(home, "acct2", now + 2, 1, now - 1);
    writeTap(home, "acct3", now + 1, 40, resetsAt);

    const result = runKeeper([], home);
    expect(result.status).toBe(0);
    expect(advice(home).target.id).toBe("acct3");
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

  it("caps rotation advice dedupe entries at 50", () => {
    const home = mkHome();
    const { resetsAt } = seedRotationWindows(home);
    fs.writeFileSync(
      path.join(home, ".heddle", "window-keeper.state.json"),
      JSON.stringify({
        last_ping_ts: 123,
        last_ping_acct: "acct2",
        rotationAdvice: Array.from({ length: 55 }, (_, index) => ({ activeId: `old${index}`, resetsAt: index })),
      }),
    );

    expect(runKeeper([], home).status).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(home, ".heddle", "window-keeper.state.json"), "utf8"));
    expect(state.rotationAdvice).toHaveLength(50);
    expect(state.rotationAdvice[0]).toEqual({ activeId: "old6", resetsAt: 6 });
    expect(state.rotationAdvice).toContainEqual({ activeId: "acct1", resetsAt });
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

  it("does not interpret the fleet post command through a shell", () => {
    const home = mkHome();
    const marker = path.join(home, "fleet-post-ran");
    seedRotationWindows(home);

    const result = runKeeper([], home, {
      HEDDLE_FLEET_POST_CMD: `${path.join(home, "missing-fleet-hook")}; touch ${marker}`,
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("reports an unusable relaunch template without claiming there is no eligible target", () => {
    const home = mkHome();
    seedRotationWindows(home);

    const result = runKeeper([], home, { HEDDLE_RELAUNCH_TEMPLATE: "{acct}" });
    expect(result.status).toBe(0);
    expect(advice(home).target.id).toBe("acct2");
    expect(advice(home).command).toBeNull();
    expect(advice(home).reason).toContain("HEDDLE_RELAUNCH_TEMPLATE");
    expect(result.stdout).not.toContain("Command: no eligible target");
  });

  it("attributes shared transcript turns by owner account and deduplicates symlinked project dirs", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    const resetsAt = now + 6 * 86400;
    writeTranscriptWindow(home, "acct1", resetsAt);
    writeTranscriptWindow(home, "acct2", resetsAt);
    const secretPrompt = "fixture-secret-prompt-must-never-leave-the-reader";
    writeTranscript(path.join(sharedProjects, "shared.jsonl"), [
      { ownerAccountUuid: "uuid-acct1", timestamp: new Date((now - 10) * 1000).toISOString(), model: "claude-fable-5", input: 2, output: 3, prompt: secretPrompt },
      { ownerAccountUuid: "uuid-acct2", timestamp: new Date((now - 9) * 1000).toISOString(), model: "claude-opus-5", input: 4, output: 5, prompt: secretPrompt },
    ]);

    const result = runKeeper([], home);
    expect(result.status).toBe(0);
    expect(calls(home)).toEqual([]);
    expect(transcriptSummary(home, "acct1").byModel).toEqual({
      "claude-fable-5": { input: 2, output: 3, cacheCreation: 0, cacheRead: 0, turns: 1 },
    });
    expect(transcriptSummary(home, "acct2").byModel).toEqual({
      "claude-opus-5": { input: 4, output: 5, cacheCreation: 0, cacheRead: 0, turns: 1 },
    });
    const emitted = `${result.stdout}${result.stderr}${fs.readFileSync(path.join(home, ".heddle", "usage", "claude-acct1.turns.json"), "utf8")}${fs.readFileSync(path.join(home, ".heddle", "usage", "claude-acct2.turns.json"), "utf8")}`;
    expect(emitted).not.toContain(secretPrompt);
  });

  it("rejects an implausible model field so content cannot leak through the one persisted string", () => {
    // The model is the only transcript field persisted as a key. A malformed/adversarial record whose
    // model carries body text must not enter turns.json OR the state file, and must not be counted.
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    writeTranscriptWindow(home, "acct2", now + 6 * 86400);
    const secretModel = "leaked secret prompt smuggled through the model field with spaces";
    writeTranscript(path.join(sharedProjects, "shared.jsonl"), [
      { ownerAccountUuid: "uuid-acct1", timestamp: new Date((now - 10) * 1000).toISOString(), model: secretModel, input: 9, output: 9 },
    ]);
    expect(runKeeper([], home).status).toBe(0);
    expect(transcriptSummary(home, "acct1").byModel).toEqual({}); // implausible model → not counted
    // Crucially, check the STATE file too — the existing privacy test omits it.
    const stateBlob = fs.readFileSync(path.join(home, ".heddle", "transcript-usage-state.json"), "utf8");
    const turnsBlob = fs.readFileSync(path.join(home, ".heddle", "usage", "claude-acct1.turns.json"), "utf8");
    expect(stateBlob).not.toContain(secretModel);
    expect(turnsBlob).not.toContain(secretModel);
  });

  it("runs the pings BEFORE transcript accounting, so a blocking transcript read cannot cost a ping", () => {
    // A hung open() (here a FIFO named like a transcript) is not an exception, so the try/except
    // around accounting cannot save the pings — only running them first does. Proof: the ping anchor
    // exists even though accounting then blocks forever (we kill it with a timeout).
    const mkfifo = spawnSync("mkfifo", ["--help"]);
    if (mkfifo.error) return; // no mkfifo on this platform — skip
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    // NO window for acct1 → it is UNKNOWN and therefore the due ping. (A window would make it "live"
    // = nothing to do, and there would be no ping to observe.)
    expect(spawnSync("mkfifo", [path.join(sharedProjects, "blocking.jsonl")]).status).toBe(0);
    // acct1 has no window anchor → it is the due ping; run with a short kill timeout since the keeper
    // will hang in account_transcripts after pinging.
    spawnSync("python3", [keeperPath], {
      cwd: path.resolve(path.dirname(keeperPath), ".."),
      env: { ...process.env, HOME: home, HEDDLE_CLAUDE_BIN: path.join(home, "fake-claude"), HEDDLE_ROTATE_NOTIFY: "0", CLAUDE_CONFIG_DIR: undefined },
      encoding: "utf8",
      timeout: 4000,
    });
    // The ping ran first: its keeper anchor is on disk despite accounting blocking afterward.
    expect(fs.existsSync(path.join(home, ".heddle", "usage", "claude-acct1.keeper.json"))).toBe(true);
  });

  it("only counts transcript turns inside the current weekly window", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    const resetsAt = now + 6 * 86400;
    writeTranscriptWindow(home, "acct1", resetsAt);
    writeTranscriptWindow(home, "acct2", resetsAt);
    writeTranscript(path.join(sharedProjects, "windowed.jsonl"), [
      { ownerAccountUuid: "uuid-acct1", timestamp: new Date((now - 30) * 1000).toISOString(), model: "claude-opus-5", input: 7 },
      { ownerAccountUuid: "uuid-acct1", timestamp: new Date((now - 8 * 86400) * 1000).toISOString(), model: "claude-fable-5", input: 99 },
    ]);

    expect(runKeeper([], home).status).toBe(0);
    expect(transcriptSummary(home, "acct1").byModel).toEqual({
      "claude-opus-5": { input: 7, output: 0, cacheCreation: 0, cacheRead: 0, turns: 1 },
    });
  });

  it("excludes cache reads from Fable weights and uses null for zero weighted totals", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    const resetsAt = now + 6 * 86400;
    writeTranscriptWindow(home, "acct1", resetsAt);
    writeTranscriptWindow(home, "acct2", resetsAt);
    writeTranscript(path.join(sharedProjects, "weighted.jsonl"), [
      { ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-fable-5", input: 1, output: 9, cacheRead: 10000 },
      { ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-opus-5", input: 10 },
      { ownerAccountUuid: "uuid-acct2", timestamp: new Date(now * 1000).toISOString(), model: "claude-haiku-5", cacheRead: 9999 },
    ]);

    expect(runKeeper([], home).status).toBe(0);
    const weighted = transcriptSummary(home, "acct1");
    expect(weighted.weightedTotal).toBe(20);
    expect(weighted.fableWeighted).toBe(10);
    expect(weighted.fableShare).toBe(0.5);
    expect(weighted.cacheReadTotal).toBe(10000);
    expect(transcriptSummary(home, "acct2")).toMatchObject({ weightedTotal: 0, fableWeighted: 0, fableShare: null, cacheReadTotal: 9999 });
  });

  it("incrementally accumulates transcript turns and is idempotent without new bytes", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    writeTranscriptWindow(home, "acct2", now + 6 * 86400);
    const file = path.join(sharedProjects, "incremental.jsonl");
    writeTranscript(file, [{ ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-opus-5", input: 2 }]);

    expect(runKeeper([], home).status).toBe(0);
    fs.appendFileSync(file, `${transcriptLine({ ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-fable-5", input: 3 })}\n`);
    expect(runKeeper([], home).status).toBe(0);
    expect(transcriptSummary(home, "acct1").weightedTotal).toBe(5);
    expect(runKeeper([], home).status).toBe(0);
    expect(transcriptSummary(home, "acct1").weightedTotal).toBe(5);
  });

  it("re-reads a transcript from zero after truncation", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    writeTranscriptWindow(home, "acct2", now + 6 * 86400);
    const file = path.join(sharedProjects, "truncated.jsonl");
    writeTranscript(file, [{ ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-opus-5", input: 999 }]);
    expect(runKeeper([], home).status).toBe(0);
    writeTranscript(file, [{ ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-fable-5", input: 1 }]);

    expect(runKeeper([], home).status).toBe(0);
    expect(transcriptSummary(home, "acct1").byModel["claude-fable-5"].turns).toBe(1);
  });

  it("leaves a partial trailing transcript line for later completion", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    writeTranscriptWindow(home, "acct2", now + 6 * 86400);
    const file = path.join(sharedProjects, "partial.jsonl");
    fs.writeFileSync(file, transcriptLine({ ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-fable-5", input: 4 }));

    expect(runKeeper([], home).status).toBe(0);
    expect(transcriptSummary(home, "acct1").weightedTotal).toBe(0);
    fs.appendFileSync(file, "\n");
    expect(runKeeper([], home).status).toBe(0);
    expect(transcriptSummary(home, "acct1").weightedTotal).toBe(4);
  });

  it("does not record transcript turns for an account without a seven-day tap window", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    writeTap(home, "acct2", now, 1, now + 3600);
    writeTranscript(path.join(sharedProjects, "unknown-window.jsonl"), [
      { ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-opus-5", input: 2 },
      { ownerAccountUuid: "uuid-acct2", timestamp: new Date(now * 1000).toISOString(), model: "claude-fable-5", input: 4 },
    ]);

    expect(runKeeper([], home).status).toBe(0);
    expect(transcriptSummary(home, "acct1").weightedTotal).toBe(2);
    expect(fs.existsSync(path.join(home, ".heddle", "usage", "claude-acct2.turns.json"))).toBe(false);
  });

  it("respects the global transcript byte budget and resumes the backlog later", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    writeTranscriptWindow(home, "acct2", now + 6 * 86400);
    const first = transcriptLine({ ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-opus-5", input: 2 });
    const second = transcriptLine({ ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-fable-5", input: 3 });
    fs.writeFileSync(path.join(sharedProjects, "budgeted.jsonl"), `${first}\n${second}\n`);

    expect(runKeeper([], home, { HEDDLE_TRANSCRIPT_BYTES: String(Buffer.byteLength(first) + 1) }).status).toBe(0);
    expect(transcriptSummary(home, "acct1").weightedTotal).toBe(2);
    expect(runKeeper([], home).status).toBe(0);
    expect(transcriptSummary(home, "acct1").weightedTotal).toBe(5);
  });

  it("skips an oversized transcript record so later files drain on a later run", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    writeTranscriptWindow(home, "acct2", now + 6 * 86400);
    const oversized = transcriptLine({ ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-opus-5", prompt: "x".repeat(1000) });
    fs.writeFileSync(path.join(sharedProjects, "a-oversized.jsonl"), `${oversized}\n`);
    writeTranscript(path.join(sharedProjects, "z-following.jsonl"), [
      { ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-fable-5", input: 7 },
    ]);

    expect(runKeeper([], home, { HEDDLE_TRANSCRIPT_BYTES: String(Buffer.byteLength(oversized) - 1) }).status).toBe(0);
    expect(runKeeper([], home, { HEDDLE_TRANSCRIPT_BYTES: String(Buffer.byteLength(oversized) - 1) }).status).toBe(0);
    expect(transcriptSummary(home, "acct1").weightedTotal).toBe(7);
  });

  it("counts a normal record left partial by an earlier file's budget, not dropped as oversized", () => {
    // gitar-bot's budget-boundary case: a short read caused by an EARLIER file consuming the run
    // budget must NOT be misread as an oversized record — advancing the offset there would split a
    // normal record and silently drop its turn. It must be left and read whole on a later run.
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    writeTranscriptWindow(home, "acct2", now + 6 * 86400);
    const firstLine = transcriptLine({ ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-fable-5", input: 5 });
    const secondLine = transcriptLine({ ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-fable-5", input: 9, prompt: "x".repeat(1000) });
    fs.writeFileSync(path.join(sharedProjects, "a-first.jsonl"), `${firstLine}\n`);
    fs.writeFileSync(path.join(sharedProjects, "b-second.jsonl"), `${secondLine}\n`);
    // Budget leaves the whole first file plus only a PARTIAL second record — its newline sits just past.
    const budget = Buffer.byteLength(firstLine) + 1 + (Buffer.byteLength(secondLine) - 5);
    expect(Buffer.byteLength(secondLine) < budget).toBe(true); // second record is normal, not oversized
    expect(runKeeper([], home, { HEDDLE_TRANSCRIPT_BYTES: String(budget) }).status).toBe(0);
    expect(runKeeper([], home, { HEDDLE_TRANSCRIPT_BYTES: String(budget) }).status).toBe(0);
    // Both turns counted: 5 (first) + 9 (second, read whole on the second run) = 14. Under the old
    // misclassification the second was split and dropped, leaving 5.
    expect(transcriptSummary(home, "acct1").weightedTotal).toBe(14);
  });

  it("restarts at zero when a truncated transcript regrows past a stale offset", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    writeTranscriptWindow(home, "acct2", now + 6 * 86400);
    const file = path.join(sharedProjects, "regrown.jsonl");
    writeTranscript(file, [{ ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-opus-5", input: 1 }]);
    expect(runKeeper([], home).status).toBe(0);
    writeTranscript(file, [{ ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-fable-5", input: 2, prompt: "x".repeat(1000) }]);

    expect(runKeeper([], home).status).toBe(0);
    expect(transcriptSummary(home, "acct1").byModel).toEqual({
      "claude-fable-5": { input: 2, output: 0, cacheCreation: 0, cacheRead: 0, turns: 1 },
    });
  });

  it("persists each transcript file offset and counts together in one state object", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    writeTranscriptWindow(home, "acct2", now + 6 * 86400);
    const file = path.join(sharedProjects, "atomic-state.jsonl");
    writeTranscript(file, [{ ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-opus-5", input: 3 }]);

    expect(runKeeper([], home).status).toBe(0);
    const state = JSON.parse(fs.readFileSync(path.join(home, ".heddle", "transcript-usage-state.json"), "utf8"));
    expect(state.files[fs.realpathSync(file)]).toMatchObject({ offset: fs.statSync(file).size, accounts: {
      acct1: { "claude-opus-5": { input: 3, turns: 1 } },
    } });
    expect(fs.existsSync(path.join(home, ".heddle", "transcript-offsets.json"))).toBe(false);
  });

  it("withholds transcript accounting for an already-ended weekly window", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now - 1);
    writeTranscript(path.join(sharedProjects, "stale-window.jsonl"), [
      { ownerAccountUuid: "uuid-acct1", timestamp: new Date((now - 60) * 1000).toISOString(), model: "claude-opus-5", input: 5 },
    ]);

    expect(runKeeper([], home).status).toBe(0);
    expect(fs.existsSync(path.join(home, ".heddle", "usage", "claude-acct1.turns.json"))).toBe(false);
  });

  it("does not count a future-dated transcript turn before the weekly reset", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    writeTranscript(path.join(sharedProjects, "future-turn.jsonl"), [
      { ownerAccountUuid: "uuid-acct1", timestamp: new Date((now + 3600) * 1000).toISOString(), model: "claude-opus-5", input: 5 },
    ]);

    expect(runKeeper([], home).status).toBe(0);
    expect(transcriptSummary(home, "acct1").weightedTotal).toBe(0);
  });

  it("excludes isSidechain transcript turns from account totals", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    writeTranscript(path.join(sharedProjects, "sidechain.jsonl"), [
      { ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-opus-5", input: 5, isSidechain: true },
    ]);

    expect(runKeeper([], home).status).toBe(0);
    expect(transcriptSummary(home, "acct1").weightedTotal).toBe(0);
  });

  it("does not double-count transcript bytes across sequential accounting runs", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    writeTranscript(path.join(sharedProjects, "sequential-lock.jsonl"), [
      { ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-opus-5", input: 5 },
    ]);

    expect(runKeeper([], home).status).toBe(0);
    expect(runKeeper([], home).status).toBe(0);
    expect(transcriptSummary(home, "acct1").weightedTotal).toBe(5);
  });

  it("continues attribution when another account has an unreadable UUID config", () => {
    const home = mkHome();
    const { accounts, sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    fs.writeFileSync(path.join(accounts[1].configDir, ".claude.json"), "{");
    writeTranscript(path.join(sharedProjects, "malformed-config.jsonl"), [
      { ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-opus-5", input: 5 },
    ]);

    expect(runKeeper([], home).status).toBe(0);
    expect(transcriptSummary(home, "acct1").weightedTotal).toBe(5);
  });

  it("keeps other accounts' counts and offsets when one weekly window rolls over", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    writeTranscriptWindow(home, "acct2", now + 6 * 86400);
    const file = path.join(sharedProjects, "rollover.jsonl");
    writeTranscript(file, [
      { ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-opus-5", input: 1 },
      { ownerAccountUuid: "uuid-acct2", timestamp: new Date(now * 1000).toISOString(), model: "claude-fable-5", input: 2 },
    ]);
    expect(runKeeper([], home).status).toBe(0);
    const before = JSON.parse(fs.readFileSync(path.join(home, ".heddle", "transcript-usage-state.json"), "utf8"));
    writeTranscriptWindow(home, "acct1", now + 13 * 86400);

    expect(runKeeper([], home).status).toBe(0);
    const after = JSON.parse(fs.readFileSync(path.join(home, ".heddle", "transcript-usage-state.json"), "utf8"));
    expect(transcriptSummary(home, "acct1").weightedTotal).toBe(0);
    expect(transcriptSummary(home, "acct2").weightedTotal).toBe(2);
    expect(after.files[fs.realpathSync(file)].offset).toBe(before.files[fs.realpathSync(file)].offset);
  });

  it("clears stale contributions when a weekly window appears for the first time", () => {
    const home = mkHome();
    const { sharedProjects } = setupTranscriptAccounts(home);
    const now = Math.floor(Date.now() / 1000);
    writeTranscriptWindow(home, "acct1", now + 6 * 86400);
    // acct2 has no window yet on the first run; write a file with turns for both accounts
    writeTranscript(path.join(sharedProjects, "no-window.jsonl"), [
      { ownerAccountUuid: "uuid-acct1", timestamp: new Date(now * 1000).toISOString(), model: "claude-opus-5", input: 1 },
      { ownerAccountUuid: "uuid-acct2", timestamp: new Date(now * 1000).toISOString(), model: "claude-fable-5", input: 5 },
    ]);
    expect(runKeeper([], home).status).toBe(0);
    // acct2 has no window so no turns file is emitted
    expect(fs.existsSync(path.join(home, ".heddle", "usage", "claude-acct2.turns.json"))).toBe(false);

    // acct2 window now appears; write a new file with a fresh turn so the offset can advance
    writeTranscript(path.join(sharedProjects, "with-window.jsonl"), [
      { ownerAccountUuid: "uuid-acct2", timestamp: new Date(now * 1000).toISOString(), model: "claude-fable-5", input: 7 },
    ]);
    writeTranscriptWindow(home, "acct2", now + 6 * 86400);
    expect(runKeeper([], home).status).toBe(0);
    // Only the new turn is attributed; prior scanned turns are past their offset.
    // The important guarantee: stale contributions are cleared so the window starts clean.
    expect(transcriptSummary(home, "acct2").weightedTotal).toBe(7);
    // Two full keeper subprocess runs; under a saturated machine (parallel cargo) this sits right at
    // vitest's 5s default and flakes (green in isolation and on re-run — Agent R, 2026-08-18). A
    // generous per-test budget removes the flake without touching the global default.
  }, 20000);

  it("writes exact Fable OAuth usage without leaking the access token", () => {
    const home = mkHome();
    const token = "FAKE-TOKEN-HED150-PRIVATE";
    writeRegistry(home, [{ id: "acct1", configDir: null, loggedIn: true }]);
    const fixture = writeOauthFixture(home);
    const result = runKeeper([], home, {
      HEDDLE_SECURITY_BIN: writeFakeSecurity(home, token),
      HEDDLE_OAUTH_USAGE_URL: `file://${fixture}`,
    });

    expect(result.status).toBe(0);
    expect(oauthUsage(home, "acct1")).toMatchObject({
      fablePct: 77,
      fiveHourPct: 12,
      sevenDayPct: 34,
      byModel: { Fable: 77, Opus: 56 },
      source: "oauth-usage",
    });
    expectTokenPrivate(home, result, token);
  });

  it("uses the five-minute OAuth usage cache without refetching", () => {
    const home = mkHome();
    const token = "FAKE-TOKEN-HED150-CACHE";
    writeRegistry(home, [{ id: "acct1", configDir: null, loggedIn: true }]);
    const fixture = writeOauthFixture(home);
    const env = {
      HEDDLE_SECURITY_BIN: writeFakeSecurity(home, token),
      HEDDLE_OAUTH_USAGE_URL: `file://${fixture}`,
    };
    expect(runKeeper([], home, env).status).toBe(0);
    const first = oauthUsage(home, "acct1");
    fs.unlinkSync(fixture);

    const result = runKeeper([], home, env);
    expect(result.status).toBe(0);
    expect(oauthUsage(home, "acct1")).toEqual(first);
    expectTokenPrivate(home, result, token);
  });

  it("reads a non-default account OAuth token from its credentials file", () => {
    const home = mkHome();
    const token = "FAKE-TOKEN-HED150-NONDEFAULT";
    const configDir = path.join(home, ".claude-acct2");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
    writeRegistry(home, [{ id: "acct2", configDir, loggedIn: true }]);
    const fixture = writeOauthFixture(home);
    const securityMarker = path.join(home, "security-called");
    const result = runKeeper([], home, {
      HEDDLE_SECURITY_BIN: writeFakeSecurity(home, "KEYCHAIN-MUST-NOT-BE-READ", { marker: securityMarker }),
      HEDDLE_OAUTH_USAGE_URL: `file://${fixture}`,
    });

    expect(result.status).toBe(0);
    expect(oauthUsage(home, "acct2").fablePct).toBe(77);
    expect(fs.existsSync(securityMarker)).toBe(false);
    expectTokenPrivate(home, result, token, "acct2");
  });

  it("reads OAuth usage from flat top-level credentials", () => {
    const home = mkHome();
    const token = "FAKE-TOKEN-HED150-FLAT";
    const configDir = path.join(home, ".claude-acct2");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, ".credentials.json"), JSON.stringify({ accessToken: token }));
    writeRegistry(home, [{ id: "acct2", configDir, loggedIn: true }]);
    const result = runKeeper([], home, { HEDDLE_OAUTH_USAGE_URL: `file://${writeOauthFixture(home)}` });

    expect(result.status).toBe(0);
    expect(oauthUsage(home, "acct2").fablePct).toBe(77);
    expectTokenPrivate(home, result, token, "acct2");
  });

  it("refuses a cross-origin OAuth redirect without issuing a second request", () => {
    const home = mkHome();
    const token = "FAKE-TOKEN-HED150-REDIRECT";
    writeRegistry(home, [{ id: "acct1", configDir: null, loggedIn: true }]);
    fs.writeFileSync(path.join(home, ".heddle", "usage", "claude-acct1.oauth-usage.json"), '{"fablePct": 33}');
    const result = runRedirectRefusalFixture(home, token);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("redirect refused");
    expect(oauthUsage(home, "acct1")).toEqual({ fablePct: 33 });
    expect(fs.existsSync(path.join(home, ".heddle", "oauth-usage-state.json"))).toBe(false);
    expectTokenPrivate(home, result, token);
  });

  it("writes only finite in-range OAuth percentages as strict JSON", () => {
    const home = mkHome();
    const token = "FAKE-TOKEN-HED150-FINITE";
    const fixture = path.join(home, "oauth-nonfinite.json");
    fs.writeFileSync(fixture, '{"limits":[{"kind":"five_hour","percent":NaN},{"kind":"seven_day","percent":150},{"kind":"weekly_scoped","percent":-1,"scope":{"model":{"display_name":"Fable"}}}]}');
    writeRegistry(home, [{ id: "acct1", configDir: null, loggedIn: true }]);
    const result = runKeeper([], home, {
      HEDDLE_SECURITY_BIN: writeFakeSecurity(home, token),
      HEDDLE_OAUTH_USAGE_URL: `file://${fixture}`,
    });

    expect(result.status).toBe(0);
    expect(oauthUsage(home, "acct1")).toMatchObject({ fablePct: null, fiveHourPct: null, sevenDayPct: null, byModel: {} });
    expect(() => JSON.parse(contentsIfPresent(path.join(home, ".heddle", "usage", "claude-acct1.oauth-usage.json")))).not.toThrow();
    expectTokenPrivate(home, result, token);
  });

  it("fails closed when HEDDLE_SECURITY_BIN is set but not executable", () => {
    const home = mkHome();
    writeRegistry(home, [{ id: "acct1", configDir: null, loggedIn: true }]);
    const result = runKeeper([], home, {
      HEDDLE_SECURITY_BIN: path.join(home, "nonexistent-security"),
      HEDDLE_OAUTH_USAGE_URL: `file://${writeOauthFixture(home)}`,
    });

    expect(result.status).toBe(0);
    // An invalid override must NOT silently fall back to the real keychain: no token is read, so no
    // OAuth artifact is written, and the reason is logged (shutil.which returns None before any
    // subprocess runs, so the live keychain is never touched).
    expect(fs.existsSync(path.join(home, ".heddle", "usage", "claude-acct1.oauth-usage.json"))).toBe(false);
    expect(result.stdout).toContain("HEDDLE_SECURITY_BIN not executable");
  });

  it("captures the exact Fable percent from weekly_scoped when limits is an empty list", () => {
    const home = mkHome();
    const token = "FAKE-TOKEN-HED150-EMPTYLIMITS";
    const fixture = path.join(home, "oauth-emptylimits.json");
    fs.writeFileSync(fixture, JSON.stringify({ limits: [], weekly_scoped: { percent: 61, scope: { model: { display_name: "Fable" } } } }));
    writeRegistry(home, [{ id: "acct1", configDir: null, loggedIn: true }]);
    const result = runKeeper([], home, {
      HEDDLE_SECURITY_BIN: writeFakeSecurity(home, token),
      HEDDLE_OAUTH_USAGE_URL: `file://${fixture}`,
    });

    expect(result.status).toBe(0);
    // An empty `limits: []` alongside a populated weekly_scoped must not drop the exact Fable value.
    expect(oauthUsage(home, "acct1")).toMatchObject({ fablePct: 61 });
    expectTokenPrivate(home, result, token);
  });

  it("backs off OAuth refresh after a persistent usage-write failure", () => {
    const home = mkHome();
    const token = "FAKE-TOKEN-HED150-WRITEFAIL";
    const marker = path.join(home, "security-calls");
    writeRegistry(home, [{ id: "acct1", configDir: null, loggedIn: true }]);
    // Make the artifact path un-writable: a directory where the .json file must be written.
    fs.mkdirSync(path.join(home, ".heddle", "usage", "claude-acct1.oauth-usage.json"), { recursive: true });
    const env = {
      HEDDLE_SECURITY_BIN: writeFakeSecurity(home, token, { marker }),
      HEDDLE_OAUTH_USAGE_URL: `file://${writeOauthFixture(home)}`,
      HEDDLE_OAUTH_CACHE_SECS: "0",
    };

    const first = runKeeper([], home, env);
    expect(first.status).toBe(0);
    // The write failed, so a backoff attempt is recorded (a persistent local failure is non-transient).
    const state = JSON.parse(fs.readFileSync(path.join(home, ".heddle", "oauth-usage-state.json"), "utf8"));
    expect(state.attempts?.acct1?.lastAttemptAt).toBeGreaterThan(0);
    const callsAfterFirst = fs.readFileSync(marker, "utf8").length;

    // An immediate second run is inside the backoff window, so it does NOT re-fetch (no keychain call).
    const second = runKeeper([], home, env);
    expect(second.status).toBe(0);
    expect(fs.readFileSync(marker, "utf8").length).toBe(callsAfterFirst);
    expectTokenPrivate(home, first, token);
  });

  it("continues OAuth refresh after a malformed account entry", () => {
    const home = mkHome();
    const token = "FAKE-TOKEN-HED150-MALFORMED";
    writeRegistry(home, [
      { id: "acct1", configDir: null, loggedIn: true },
      { id: { malformed: true }, configDir: null, loggedIn: true },
    ]);
    const result = runKeeper([], home, {
      HEDDLE_SECURITY_BIN: writeFakeSecurity(home, token),
      HEDDLE_OAUTH_USAGE_URL: `file://${writeOauthFixture(home)}`,
    });

    expect(result.status).toBe(0);
    expect(oauthUsage(home, "acct1").fablePct).toBe(77);
    expect(result.stdout).toContain("[oauth] account refresh failed");
    expectTokenPrivate(home, result, token);
  });

  it("keeps pings running and keeps tokens private when OAuth usage fetching fails", () => {
    const home = mkHome();
    const token = "FAKE-TOKEN-HED150-FAILED-FETCH";
    writeRegistry(home, [{ id: "acct1", configDir: null, loggedIn: true }]);
    const result = runKeeper([], home, {
      HEDDLE_SECURITY_BIN: writeFakeSecurity(home, token),
      HEDDLE_OAUTH_USAGE_URL: `file://${path.join(home, "missing-oauth-usage.json")}`,
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(home, ".heddle", "usage", "claude-acct1.keeper.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".heddle", "usage", "claude-acct1.oauth-usage.json"))).toBe(false);
    expectTokenPrivate(home, result, token);
  });

  it("retries transient OAuth fetch failures on the next run without a credential backoff", () => {
    const home = mkHome();
    const token = "FAKE-TOKEN-HED150-TRANSIENT";
    const marker = path.join(home, "security-attempts");
    writeRegistry(home, [{ id: "acct1", configDir: null, loggedIn: true }]);
    const env = {
      HEDDLE_SECURITY_BIN: writeFakeSecurity(home, token, { marker }),
      HEDDLE_OAUTH_USAGE_URL: `file://${path.join(home, "missing-oauth-usage.json")}`,
    };
    expect(runKeeper([], home, env).status).toBe(0);
    expect(contentsIfPresent(marker)).toBe("x");

    const result = runKeeper([], home, env);
    expect(result.status).toBe(0);
    expect(contentsIfPresent(marker)).toBe("xx");
    expect(fs.existsSync(path.join(home, ".heddle", "oauth-usage-state.json"))).toBe(false);
    expectTokenPrivate(home, result, token);
  });

  it("backs off missing OAuth credentials for an hour", () => {
    const home = mkHome();
    const marker = path.join(home, "credential-attempts");
    writeRegistry(home, [{ id: "acct1", configDir: null, loggedIn: true }]);
    const env = {
      HEDDLE_SECURITY_BIN: writeUnavailableSecurity(home, marker),
      HEDDLE_OAUTH_USAGE_URL: `file://${writeOauthFixture(home)}`,
    };
    expect(runKeeper([], home, env).status).toBe(0);
    expect(contentsIfPresent(marker)).toBe("x");
    expect(runKeeper([], home, env).status).toBe(0);
    expect(contentsIfPresent(marker)).toBe("x");
    expect(JSON.parse(contentsIfPresent(path.join(home, ".heddle", "oauth-usage-state.json"))).attempts.acct1).toHaveProperty("lastAttemptAt");
  });

  it("refuses a file OAuth URL when the explicit insecure test flag is absent", () => {
    const home = mkHome();
    const token = "FAKE-TOKEN-HED150-SCHEME";
    writeRegistry(home, [{ id: "acct1", configDir: null, loggedIn: true }]);
    const result = runKeeper([], home, {
      HEDDLE_SECURITY_BIN: writeFakeSecurity(home, token),
      HEDDLE_OAUTH_ALLOW_INSECURE_URL: "0",
      HEDDLE_OAUTH_USAGE_URL: `file://${writeOauthFixture(home)}`,
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(home, ".heddle", "usage", "claude-acct1.oauth-usage.json"))).toBe(false);
    expectTokenPrivate(home, result, token);
  });

  it("uses string backoff keys for numeric OAuth account ids", () => {
    const home = mkHome();
    const marker = path.join(home, "numeric-id-security");
    writeRegistry(home, [{ id: 42, configDir: null, loggedIn: true }]);
    fs.writeFileSync(path.join(home, ".heddle", "oauth-usage-state.json"), JSON.stringify({ attempts: { "42": { lastAttemptAt: Math.floor(Date.now() / 1000) } } }));
    const result = runKeeper([], home, {
      HEDDLE_SECURITY_BIN: writeUnavailableSecurity(home, marker),
      HEDDLE_OAUTH_USAGE_URL: `file://${writeOauthFixture(home)}`,
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("accepts digit-bearing OAuth display names while rejecting unsafe names", () => {
    const home = mkHome();
    const token = "FAKE-TOKEN-HED150-DISPLAY";
    const fixture = path.join(home, "oauth-display-names.json");
    fs.writeFileSync(fixture, JSON.stringify({ limits: [
      { kind: "weekly_scoped", percent: 44, scope: { model: { display_name: "Opus 4" } } },
      { kind: "weekly_scoped", percent: 55, scope: { model: { display_name: `Fable-${token}` } } },
      { kind: "weekly_scoped", percent: 66, scope: { model: { display_name: "Bad\u0001Name" } } },
      { kind: "weekly_scoped", percent: 77, scope: { model: { display_name: "x".repeat(65) } } },
    ] }));
    writeRegistry(home, [{ id: "acct1", configDir: null, loggedIn: true }]);
    const result = runKeeper([], home, {
      HEDDLE_SECURITY_BIN: writeFakeSecurity(home, token),
      HEDDLE_OAUTH_USAGE_URL: `file://${fixture}`,
    });

    expect(result.status).toBe(0);
    expect(oauthUsage(home, "acct1").byModel).toEqual({ "Opus 4": 44 });
    expectTokenPrivate(home, result, token);
  });

  it("skips OAuth refresh when another run holds its flock", async () => {
    const home = mkHome();
    const token = "FAKE-TOKEN-HED150-LOCK";
    const marker = path.join(home, "oauth-lock-security");
    const ready = path.join(home, "oauth-lock-ready");
    const lock = path.join(home, ".heddle", "oauth-usage.lock");
    const holder = spawn("python3", ["-c", `
import fcntl, sys, time
lock, ready = sys.argv[1:]
with open(lock, "a") as f:
    fcntl.flock(f, fcntl.LOCK_EX)
    open(ready, "w").close()
    time.sleep(10)
`, lock, ready], { stdio: "ignore" });
    for (let attempt = 0; attempt < 100 && !fs.existsSync(ready); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    try {
      writeRegistry(home, [{ id: "acct1", configDir: null, loggedIn: true }]);
      const result = runKeeper([], home, {
        HEDDLE_SECURITY_BIN: writeFakeSecurity(home, token, { marker }),
        HEDDLE_OAUTH_USAGE_URL: `file://${writeOauthFixture(home)}`,
      });

      expect(result.status).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
      expect(result.stdout).toContain("[oauth] refresh skipped; another run holds the lock");
      expectTokenPrivate(home, result, token);
    } finally {
      holder.kill();
    }
  }, 20000);

  it("continues pings when transcript accounting fails", () => {
    const home = mkHome();
    fs.mkdirSync(path.join(home, ".heddle", "transcript-offsets.json"));

    const result = runKeeper([], home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[transcripts] accounting failed:");
    expect(calls(home)).toHaveLength(1);
  });
});
