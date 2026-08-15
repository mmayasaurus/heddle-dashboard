import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const tapPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/heddle-usage-tap.mjs");
const homes: string[] = [];
const registry = {
  claude: [
    { id: "primary", configDir: null, loggedIn: true },
    { id: "acct2", configDir: "~/.claude-acct2", loggedIn: true },
    { id: "../../pwn", configDir: "~/evil", loggedIn: true },
  ],
};
const payload = {
  model: { id: "claude-fable-5", display_name: "Fable" },
  rate_limits: {
    five_hour: { used_percentage: 42.5, resets_at: 1786000000 },
    seven_day: { used_percentage: 12, resets_at: 1786400000 },
  },
  note: "ünïcode ⟢ ok",
};
const payloadBytes = Buffer.from(`${JSON.stringify(payload)}\n`);

function mkHome(withRegistry = true): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "heddle-test-"));
  homes.push(home);
  const heddleDir = path.join(home, ".heddle");
  fs.mkdirSync(heddleDir, { recursive: true });
  if (withRegistry) fs.writeFileSync(path.join(heddleDir, "accounts.json"), JSON.stringify(registry));
  return home;
}

function runTap(input: Buffer, home: string, overrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [tapPath], { cwd: path.resolve(path.dirname(tapPath), ".."), env, input });
}

function expectPassthrough(result: ReturnType<typeof runTap>) {
  expect(result.status).toBe(0);
  expect(result.stdout).toEqual(payloadBytes);
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("heddle-usage-tap", () => {
  it("passes the payload through byte-for-byte", () => {
    expectPassthrough(runTap(payloadBytes, mkHome()));
  });

  it("captures the provider and registry-default account when CLAUDE_CONFIG_DIR is unset", () => {
    const home = mkHome();
    expectPassthrough(runTap(payloadBytes, home));

    const usage = path.join(home, ".heddle", "usage");
    const accountCapture = JSON.parse(fs.readFileSync(path.join(usage, "claude-primary.json"), "utf8"));
    expect(fs.existsSync(path.join(usage, "claude.json"))).toBe(true);
    expect(accountCapture).toMatchObject({
      account: "primary",
      model: "claude-fable-5",
      rate_limits: { five_hour: { used_percentage: 42.5, resets_at: 1786000000 } },
    });
    expect(accountCapture.capturedAt).toEqual(expect.any(Number));
  });

  it("maps an expanded configured account directory to its registry account", () => {
    const home = mkHome();
    expectPassthrough(runTap(payloadBytes, home, { CLAUDE_CONFIG_DIR: path.join(home, ".claude-acct2") }));
    expect(fs.existsSync(path.join(home, ".heddle", "usage", "claude-acct2.json"))).toBe(true);
  });

  it("sanitizes an account id before using it in a capture filename", () => {
    const home = mkHome();
    expectPassthrough(runTap(payloadBytes, home, { CLAUDE_CONFIG_DIR: path.join(home, "evil") }));

    const usage = path.join(home, ".heddle", "usage");
    expect(fs.existsSync(path.join(usage, "claude-.._.._pwn.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, "pwn.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".heddle", "pwn.json"))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(home), "pwn.json"))).toBe(false);
    expect(fs.readdirSync(usage).every((entry) => entry.startsWith("claude"))).toBe(true);
  });

  it("uses an unknown account filename for an unregistered config directory", () => {
    const home = mkHome();
    expectPassthrough(runTap(payloadBytes, home, { CLAUDE_CONFIG_DIR: path.join(home, "somewhere-else") }));
    expect(fs.existsSync(path.join(home, ".heddle", "usage", "claude-unknown-somewhere-else.json"))).toBe(true);
  });

  it("does not create captures for invalid JSON input", () => {
    const home = mkHome();
    const input = Buffer.from("not json {{{");
    const result = runTap(input, home);
    expect(result.status).toBe(0);
    expect(result.stdout).toEqual(input);
    expect(fs.existsSync(path.join(home, ".heddle", "usage"))).toBe(false);
  });

  it("captures the provider even if the account registry is missing", () => {
    const home = mkHome(false);
    expectPassthrough(runTap(payloadBytes, home));
    expect(fs.existsSync(path.join(home, ".heddle", "usage", "claude.json"))).toBe(true);
  });
});
