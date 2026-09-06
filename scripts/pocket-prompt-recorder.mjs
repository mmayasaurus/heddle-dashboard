// Observational PermissionRequest recorder for the pocket console. It exits 0 with no stdout, so it
// can never block a decision; the launcher activates it only through a --settings overlay (off by default).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

let temporaryPath;

try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (input.hook_event_name !== "PermissionRequest") process.exit(0);
  if (typeof input.session_id !== "string" || !input.session_id) process.exit(0);

  const safeSessionId = input.session_id.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!safeSessionId || safeSessionId === "." || safeSessionId === "..") process.exit(0);

  const promptsDir = process.env.POCKET_PROMPTS_DIR || path.join(os.homedir(), ".heddle/push/prompts");
  fs.mkdirSync(promptsDir, { recursive: true });

  const toolInput = input.tool_input ?? {};
  const summary = input.tool_name === "Bash"
    ? toolInput.command
    : input.tool_name === "Edit" || input.tool_name === "Write"
      ? toolInput.file_path
      : JSON.stringify(toolInput);
  const body = String(summary ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const ts = Math.floor(Date.now() / 1000);
  // The hooks docs list prompt_id for PermissionRequest; fall back to tool_use_id, then a
  // session+timestamp id, so a build that omits prompt_id still records (never an empty feed) and the
  // host/PWA always have a stable non-empty string id to key and dedup on.
  const id =
    (typeof input.prompt_id === "string" && input.prompt_id) ||
    (typeof input.tool_use_id === "string" && input.tool_use_id) ||
    `${input.session_id}:${ts}`;
  const envelope = [{
    id,
    category: "permission",
    priority: "urgent",
    title: typeof input.tool_name === "string" ? input.tool_name : "",
    body,
    deepLink: `session:${input.session_id}`,
    source: {
      session: input.session_id,
      agent: process.env.HEDDLE_AGENT || null,
      account: null,
      issue: null,
    },
    ts,
    state: "pending",
    kind: "permission-request",
    toolName: typeof input.tool_name === "string" ? input.tool_name : "",
    toolUseId: typeof input.tool_use_id === "string" ? input.tool_use_id : "",
  }];

  const finalPath = path.join(promptsDir, `${safeSessionId}.json`);
  temporaryPath = path.join(promptsDir, `${safeSessionId}.json.${process.pid}.tmp`);
  fs.writeFileSync(temporaryPath, JSON.stringify(envelope));
  fs.renameSync(temporaryPath, finalPath);
} catch {
  if (temporaryPath) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {}
  }
}

process.exit(0);
