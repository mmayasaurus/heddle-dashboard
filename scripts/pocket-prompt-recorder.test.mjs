import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

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

test("records a PermissionRequest as a one-element pocket envelope", async () => {
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
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(await readFile(join(promptsDir, "session-123.json"), "utf8"));
  assert.equal(envelope.length, 1);
  assert.equal(envelope[0].id, "prompt-456");
  assert.equal(envelope[0].category, "permission");
  assert.equal(typeof envelope[0].ts, "number");
  assert.equal(envelope[0].source.session, "session-123");
  assert.equal(envelope[0].body, "git status --short");
});

test("silently ignores malformed hook input", async () => {
  const promptsDir = await mkdtemp(join(tmpdir(), "pocket-prompts-"));
  const result = await runRecorder("not json", promptsDir);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(await readdir(promptsDir), []);
});

test("does not let a traversal session id escape the prompts directory", async () => {
  const promptsDir = await mkdtemp(join(tmpdir(), "pocket-prompts-"));
  const result = await runRecorder(JSON.stringify({
    hook_event_name: "PermissionRequest",
    session_id: "../outside",
    prompt_id: "prompt-456",
    tool_name: "Read",
    tool_use_id: "tool-789",
    tool_input: {},
  }), promptsDir);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.deepEqual(await readdir(promptsDir), [".._outside.json"]);
});
