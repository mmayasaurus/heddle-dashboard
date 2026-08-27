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
import { createHash } from "node:crypto";

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

  describe("per-session capture", () => {
    function sessionsDir() {
      return join(tmpHome, ".heddle", "sessions");
    }

    function sessionFiles() {
      return existsSync(sessionsDir()) ? readdirSync(sessionsDir()).sort() : [];
    }

    function readSession(fileName) {
      return JSON.parse(readFileSync(join(sessionsDir(), fileName), "utf8"));
    }

    function sessionFileName(sessionId) {
      const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
      const base = safe === sessionId
        ? safe
        : `${safe}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 8)}`;
      return `${base}.json`;
    }

    it("preserves byte-identical passthrough when a session id is present", () => {
      const payload = {
        session_id: "session-byte-identical",
        cwd: "/repo",
        model: { id: "claude-sonnet-4", display_name: "Claude Sonnet 4" },
        context_window: { used_percentage: 42, context_window_size: 200000 },
      };
      const input = JSON.stringify(payload);

      expect(runTap(input)).toBe(input);
      expect(sessionFiles()).toEqual(["session-byte-identical.json"]);
      expect(readSession("session-byte-identical.json").sessionId).toBe(payload.session_id);
    });

    it("writes the documented session fields with a sanitized filename", () => {
      const sessionId = "session/alpha";
      const payload = {
        session_id: sessionId,
        cwd: "/repo/current",
        workspace: { project_dir: "/repo" },
        model: { id: "claude-sonnet-4", display_name: "Claude Sonnet 4" },
        context_window: { used_percentage: 42.5, context_window_size: 200000 },
        transcript_path: "/tmp/transcript.jsonl",
        version: "1.0.0",
      };

      const input = JSON.stringify(payload);
      const before = Math.floor(Date.now() / 1000);
      expect(runTap(input)).toBe(input);
      const after = Math.floor(Date.now() / 1000);
      const fileName = sessionFileName(sessionId);
      expect(sessionFiles()).toEqual([fileName]);
      const captured = readSession(fileName);
      expect(captured).toEqual({
        sessionId,
        cwd: "/repo/current",
        projectDir: "/repo",
        model: "Claude Sonnet 4",
        modelId: "claude-sonnet-4",
        contextPct: 42.5,
        contextWindowSize: 200000,
        transcriptPath: "/tmp/transcript.jsonl",
        version: "1.0.0",
        capturedAt: expect.any(Number),
      });
      expect(Number.isInteger(captured.capturedAt)).toBe(true);
      expect(captured.capturedAt).toBeGreaterThanOrEqual(before);
      expect(captured.capturedAt).toBeLessThanOrEqual(after);
      expect(Object.keys(captured).sort()).toEqual([
        "capturedAt", "contextPct", "contextWindowSize", "cwd", "model", "modelId",
        "projectDir", "sessionId", "transcriptPath", "version",
      ]);
    });

    it("derives or omits context percentage as appropriate", () => {
      const fallback = {
        session_id: "fallback",
        context_window: { total_input_tokens: 100001, context_window_size: 200000 },
      };
      const unavailable = { session_id: "unavailable", context_window: { context_window_size: 0 } };

      runTap(JSON.stringify(fallback));
      runTap(JSON.stringify(unavailable));

      expect(readSession("fallback.json").contextPct).toBe(50);
      expect(readSession("unavailable.json")).not.toHaveProperty("contextPct");
    });

    it("clamps direct context percentage and omits empty model values", () => {
      runTap(JSON.stringify({
        session_id: "clamped-high",
        model: { id: "", display_name: "  " },
        context_window: { used_percentage: 101 },
      }));
      runTap(JSON.stringify({
        session_id: "clamped-low",
        model: { id: "model-id", display_name: "" },
        context_window: { used_percentage: -1 },
      }));

      expect(readSession("clamped-high.json")).toMatchObject({ contextPct: 100 });
      expect(readSession("clamped-high.json")).not.toHaveProperty("model");
      expect(readSession("clamped-high.json")).not.toHaveProperty("modelId");
      expect(readSession("clamped-low.json")).toMatchObject({ contextPct: 0, model: "model-id", modelId: "model-id" });
    });

    it("omits null optional sources while retaining a null cwd", () => {
      const input = JSON.stringify({
        session_id: "null-optional-sources",
        workspace: { project_dir: null },
        model: { id: null, display_name: null },
        transcript_path: null,
        version: null,
        context_window: { context_window_size: null },
      });

      expect(runTap(input)).toBe(input);
      const captured = readSession("null-optional-sources.json");
      for (const key of ["projectDir", "model", "modelId", "transcriptPath", "version", "contextWindowSize"]) {
        expect(key in captured).toBe(false);
      }
      expect(captured.cwd).toBeNull();
      const documentedKeys = new Set(["sessionId", "cwd", "projectDir", "model", "modelId", "contextPct", "contextWindowSize", "transcriptPath", "version", "capturedAt"]);
      expect(Object.keys(captured).every((key) => documentedKeys.has(key))).toBe(true);
      expect(Object.entries(captured).filter(([key, value]) => key !== "cwd" && value === null)).toEqual([]);
    });

    it("writes no session file without a session id while rate-limit capture keeps its own rule", () => {
      const rateLimitPayload = payloadFor("claude-sonnet-4");
      const withLimits = JSON.stringify(rateLimitPayload);
      const withoutLimits = JSON.stringify({ model: { id: "claude-sonnet-4" } });

      expect(runTap(withLimits)).toBe(withLimits);
      expect(sessionFiles()).toEqual([]);
      expect(readUsage("claude.json").rate_limits).toEqual(rateLimitPayload.rate_limits);
      rmSync(usageDir(), { recursive: true, force: true });
      expect(runTap(withoutLimits)).toBe(withoutLimits);
      expect(sessionFiles()).toEqual([]);
      expectNoUsageFiles();
    });

    it("keeps raw unsafe session ids in JSON while containing the file in sessions", () => {
      const sessionId = "../nested/session";
      runTap(JSON.stringify({ session_id: sessionId }));

      const fileName = sessionFileName(sessionId);
      expect(sessionFiles()).toEqual([fileName]);
      expect(readSession(fileName).sessionId).toBe(sessionId);
    });

    it("passes malformed JSON through without a session file", () => {
      const input = "not json{{";

      expect(runTap(input)).toBe(input);
      expect(sessionFiles()).toEqual([]);
    });

    it("passes non-object JSON and invalid session ids through without a session file", () => {
      for (const input of [
        JSON.stringify({ session_id: "" }),
        JSON.stringify({ session_id: 123 }),
        JSON.stringify({ session_id: ["x"] }),
        "null",
        "[]",
      ]) {
        expect(runTap(input)).toBe(input);
        expect(sessionFiles()).toEqual([]);
      }
    });

    it("coexists with rate-limit capture", () => {
      const payload = { ...payloadFor("claude-sonnet-4"), session_id: "both" };
      const input = JSON.stringify(payload);

      expect(runTap(input)).toBe(input);
      expect(readdirSync(usageDir())).toEqual(["claude.json"]);
      expect(sessionFiles()).toEqual(["both.json"]);
      const usage = readUsage("claude.json");
      expect(usage.rate_limits).toEqual(payload.rate_limits);
      expect(usage).not.toHaveProperty("sessionId");
    });

    it("leaves only the final JSON file after an atomic session write", () => {
      runTap(JSON.stringify({ session_id: "atomic" }));

      expect(sessionFiles()).toEqual(["atomic.json"]);
      expect(readdirSync(sessionsDir())).toEqual(["atomic.json"]);
      expect(readdirSync(sessionsDir()).some((entry) => /\.tmp-/.test(entry))).toBe(false);
    });

    it("writes distinct filenames for distinct ids that sanitize to the same segment", () => {
      const sessionIds = ["a/b", "a_b"];
      for (const sessionId of sessionIds) runTap(JSON.stringify({ session_id: sessionId }));

      const files = sessionFiles();
      expect(files).toHaveLength(2);
      expect(files).toContain(sessionFileName("a/b"));
      expect(files).toContain(sessionFileName("a_b"));
      expect(files.map((fileName) => readSession(fileName).sessionId).sort()).toEqual(sessionIds.sort());
    });
  });
});
