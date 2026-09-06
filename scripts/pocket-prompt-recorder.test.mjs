// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawn } from "node:child_process";

const recorder = fileURLToPath(new URL("./pocket-prompt-recorder.mjs", import.meta.url));

function runRecorder(input, promptsDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [recorder], {
      env: { ...process.env, POCKET_PROMPTS_DIR: promptsDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe("pocket-prompt-recorder", () => {
  it("records a PermissionRequest as a one-element pocket envelope", async () => {
    const promptsDir = await mkdtemp(join(tmpdir(), "pocket-prompts-"));
    const input = JSON.stringify({
      hook_event_name: "PermissionRequest",
      session_id: "session-123",
      prompt_id: "prompt-456",
      tool_name: "Bash",
      tool_use_id: "tool-789",
      tool_input: { command: "  git   status\n--short  " },
    });

    const result = await runRecorder(input, promptsDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(await readFile(join(promptsDir, "session-123.json"), "utf8"));
    expect(envelope.length).toBe(1);
    expect(envelope[0].id).toBe("prompt-456");
    expect(envelope[0].category).toBe("permission");
    expect(typeof envelope[0].ts).toBe("number");
    expect(envelope[0].source.session).toBe("session-123");
    expect(envelope[0].body).toBe("git status --short");
  });

  it("silently ignores malformed hook input", async () => {
    const promptsDir = await mkdtemp(join(tmpdir(), "pocket-prompts-"));
    const result = await runRecorder("not json", promptsDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(await readdir(promptsDir)).toEqual([]);
  });

  it("does not let a traversal session id escape the prompts directory", async () => {
    const promptsDir = await mkdtemp(join(tmpdir(), "pocket-prompts-"));
    const result = await runRecorder(JSON.stringify({
      hook_event_name: "PermissionRequest",
      session_id: "../outside",
      prompt_id: "prompt-456",
      tool_name: "Read",
      tool_use_id: "tool-789",
      tool_input: {},
    }), promptsDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(await readdir(promptsDir)).toEqual([".._outside.json"]);
  });

  it("falls back to tool_use_id for the id when prompt_id is absent", async () => {
    const promptsDir = await mkdtemp(join(tmpdir(), "pocket-prompts-"));
    const result = await runRecorder(JSON.stringify({
      hook_event_name: "PermissionRequest",
      session_id: "session-xyz",
      tool_name: "Bash",
      tool_use_id: "tool-abc",
      tool_input: { command: "ls" },
    }), promptsDir);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(await readFile(join(promptsDir, "session-xyz.json"), "utf8"));
    expect(envelope[0].id).toBe("tool-abc");
    expect(envelope[0].source.session).toBe("session-xyz");
  });
});
