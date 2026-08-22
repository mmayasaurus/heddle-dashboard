// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "heddle-usage-tap.mjs");

describe("heddle usage tap", () => {
  let tmpHome;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "heddle-tap-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function runTap(input, claudeConfigDir) {
    const env = { ...process.env, HOME: tmpHome };
    if (claudeConfigDir === undefined) {
      delete env.CLAUDE_CONFIG_DIR;
    } else {
      env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    }

    try {
      return execFileSync(process.execPath, [scriptPath], {
        input,
        encoding: "utf8",
        env,
      });
    } catch (error) {
      throw new Error(
        `heddle usage tap exited nonzero: ${error.message}${error.stderr ? "\nstderr: " + error.stderr : ""}`,
      );
    }
  }

  function usageDir() {
    return join(tmpHome, ".heddle", "usage");
  }

  function expectNoUsageFiles() {
    if (existsSync(usageDir())) {
      expect(readdirSync(usageDir())).toEqual([]);
    }
  }

  function payloadFor(model) {
    return {
      model: { id: model },
      rate_limits: {
        primary: { used_percent: 20, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      },
    };
  }

  function readUsage(fileName) {
    return JSON.parse(readFileSync(join(usageDir(), fileName), "utf8"));
  }

  it("passes valid JSON through byte-for-byte", () => {
    const input = JSON.stringify(payloadFor("claude-sonnet-4"));

    expect(runTap(input)).toBe(input);
  });

  it("passes invalid JSON through without writing usage files", () => {
    const input = "not json{{";

    expect(runTap(input)).toBe(input);
    expectNoUsageFiles();
  });

  it("passes empty input through without writing usage files", () => {
    expect(runTap("")).toBe("");
    expectNoUsageFiles();
  });

  it("triages providers and records the supplied rate limits", () => {
    const cases = [
      ["claude-sonnet-4", "claude.json"],
      ["gpt-4o", "codex.json"],
      ["o1-preview", "codex.json"],
      ["codex-mini", "codex.json"],
      ["chatgpt-4o", "codex.json"],
      ["gemini-1.5", "other.json"],
    ];

    for (const [model, fileName] of cases) {
      rmSync(usageDir(), { recursive: true, force: true });
      const payload = payloadFor(model);
      const input = JSON.stringify(payload);
      const before = Math.floor(Date.now() / 1000);

      expect(runTap(input)).toBe(input);

      expect(readdirSync(usageDir()).sort()).toEqual([fileName]);
      const captured = readUsage(fileName);
      const after = Math.floor(Date.now() / 1000);
      expect(captured.model).toBe(model);
      expect(captured.rate_limits).toEqual(payload.rate_limits);
      expect(Number.isInteger(captured.capturedAt)).toBe(true);
      expect(captured.capturedAt).toBeGreaterThanOrEqual(before);
      expect(captured.capturedAt).toBeLessThanOrEqual(after);
    }
  });

  it("does not capture when either required signal is missing", () => {
    const modelOnly = { model: { id: "claude-sonnet-4" } };
    const rateLimitsOnly = { rate_limits: payloadFor("ignored").rate_limits };

    for (const payload of [modelOnly, rateLimitsOnly]) {
      const input = JSON.stringify(payload);
      expect(runTap(input)).toBe(input);
      expectNoUsageFiles();
    }
  });

  it("writes both provider and per-account files for a matching config directory", () => {
    const heddleDir = join(tmpHome, ".heddle");
    mkdirSync(heddleDir, { recursive: true });
    // A config dir under the per-test temp home, so the fixture is cross-platform (no hardcoded /tmp)
    // and the accounts.json entry, the CLAUDE_CONFIG_DIR we pass, and the expected capture all match.
    const acctCfgDir = join(tmpHome, "acct3-cfg");
    writeFileSync(
      join(heddleDir, "accounts.json"),
      JSON.stringify({ claude: [{ id: "acct3", configDir: acctCfgDir }] }),
    );
    const payload = payloadFor("claude-sonnet-4");
    const input = JSON.stringify(payload);
    const before = Math.floor(Date.now() / 1000);

    expect(runTap(input, acctCfgDir)).toBe(input);
    const after = Math.floor(Date.now() / 1000);
    const expectedCapture = {
      model: payload.model.id,
      rate_limits: payload.rate_limits,
      capturedAt: expect.any(Number),
      account: "acct3",
      configDir: acctCfgDir,
    };

    for (const fileName of ["claude.json", "claude-acct3.json"]) {
      const captured = readUsage(fileName);
      expect(captured).toEqual(expectedCapture);
      expect(Number.isInteger(captured.capturedAt)).toBe(true);
      expect(captured.capturedAt).toBeGreaterThanOrEqual(before);
      expect(captured.capturedAt).toBeLessThanOrEqual(after);
    }
  });

  it("captures without an account when accounts.json is absent", () => {
    const payload = payloadFor("claude-sonnet-4");
    const input = JSON.stringify(payload);

    expect(runTap(input)).toBe(input);
    expect(readUsage("claude.json").account).toBeNull();
    expect(readdirSync(usageDir())).toEqual(["claude.json"]);
  });

  it("passes through valid input when capture setup fails", () => {
    writeFileSync(join(tmpHome, ".heddle"), "not a directory");
    const input = JSON.stringify(payloadFor("claude-sonnet-4"));

    expect(runTap(input)).toBe(input);
  });
});
