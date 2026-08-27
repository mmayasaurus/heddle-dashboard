#!/usr/bin/env node
// heddle usage tap — a PURE PASSTHROUGH capture of the Claude Code statusline payload.
//
// It sits in front of the real statusline renderer (claude-hud). It reads the JSON payload Claude
// Code pipes in, writes it straight back to stdout UNCHANGED (so claude-hud sees byte-identical
// input and renders exactly as before), and — best-effort, never blocking — records the current
// rate-limit state to ~/.heddle/usage/<provider>.json for the heddle Fleet drawer to read.
//
// Design rules (this runs on every statusline render, for every agent):
//   1. Passthrough is written FIRST and always; the capture is wrapped so it can never fail the HUD.
//   2. Zero mutation of the payload. claude-hud behavior is identical with or without this tap.
//   3. resets_at is epoch SECONDS (matches Claude Code + claude-hud's `new Date(v*1000)`).
import { mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

function expandHome(path) {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function resolvedConfigDir(path) {
  return path ? resolve(expandHome(path)) : null;
}

function safeAccountSegment(account) {
  return String(account).replace(/[^A-Za-z0-9._-]/g, "_");
}

function safeSessionSegment(session) {
  return String(session).replace(/[^A-Za-z0-9._-]/g, "_");
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  raw += c;
});
process.stdin.on("end", () => {
  // 1) Passthrough first — claude-hud must be unaffected.
  process.stdout.write(raw);
  // 2) Best-effort capture. Any error here is swallowed; the statusline already got its input.
  try {
    const p = JSON.parse(raw);
    const rl = p && p.rate_limits;
    const model = (p && p.model && (p.model.id || p.model.display_name)) || "";
    if (rl && model) {
      try {
        const provider = /^claude/i.test(model)
          ? "claude"
          : /^(gpt|o\d|codex|chatgpt)/i.test(model)
            ? "codex"
            : "other";
        const dir = join(homedir(), ".heddle", "usage");
        mkdirSync(dir, { recursive: true });
        // Per-ACCOUNT keying (2026-08-15): the statusline runs inside the session, so it inherits
        // CLAUDE_CONFIG_DIR. Map it to the account id from ~/.heddle/accounts.json (configDir match;
        // unset/default → the entry with configDir null). Writes BOTH the legacy per-provider file
        // (drawer compat) and claude-<acctId>.json (per-account caps for the keeper + router).
        let acct = null;
        try {
          const reg = JSON.parse(readFileSync(join(homedir(), ".heddle", "accounts.json"), "utf8"));
          const cfg = resolvedConfigDir(process.env.CLAUDE_CONFIG_DIR);
          const accounts = reg[provider] || [];
          const hit = accounts.find((a) => resolvedConfigDir(a.configDir) === cfg);
          acct = hit ? hit.id : (cfg ? "unknown-" + basename(cfg) : (accounts.find((a) => a.configDir == null)?.id ?? "default"));
        } catch { acct = null; }
        const payload = JSON.stringify({
          model,
          rate_limits: rl,
          capturedAt: Math.floor(Date.now() / 1000),
          account: acct,
          configDir: process.env.CLAUDE_CONFIG_DIR || null,
        });
        writeFileSync(join(dir, `${provider}.json`), payload);
        if (acct) writeFileSync(join(dir, `${provider}-${safeAccountSegment(acct)}.json`), payload);
      } catch {
        /* rate-limit capture is best-effort; never blocks the session capture or the HUD */
      }
    }

    // Per-session HUD capture for the fleet roster (HED-381/HED-57). This is best-effort and
    // independent of rate-limit capture; HED-382's roster.rs reader consumes it additively and
    // treats aged captures as stale.
    if (typeof p?.session_id === "string" && p.session_id.length > 0) {
      const sessionId = p.session_id;
      const session = { sessionId, capturedAt: Math.floor(Date.now() / 1000) };
      session.cwd = typeof p.cwd === "string"
        ? p.cwd
        : (typeof p.workspace?.current_dir === "string" ? p.workspace.current_dir : null);
      if (typeof p.workspace?.project_dir === "string") session.projectDir = p.workspace.project_dir;
      const displayName = typeof p.model?.display_name === "string" && p.model.display_name.trim()
        ? p.model.display_name
        : null;
      const modelId = typeof p.model?.id === "string" && p.model.id.trim() ? p.model.id : null;
      const sessionModel = displayName ?? modelId;
      if (sessionModel != null) session.model = sessionModel;
      if (modelId != null) session.modelId = modelId;
      const context = p.context_window;
      if (Number.isFinite(context?.used_percentage)) {
        session.contextPct = Math.round(Math.min(100, Math.max(0, context.used_percentage)));
      } else if (context?.context_window_size > 0 && Number.isFinite(context?.total_input_tokens)) {
        session.contextPct = Math.round(Math.min(100, Math.max(0, 100 * context.total_input_tokens / context.context_window_size)));
      }
      if (Number.isFinite(context?.context_window_size) && context.context_window_size > 0) {
        session.contextWindowSize = context.context_window_size;
      }
      if (typeof p.transcript_path === "string") session.transcriptPath = p.transcript_path;
      if (typeof p.version === "string") session.version = p.version;

      const dir = join(homedir(), ".heddle", "sessions");
      const safe = safeSessionSegment(sessionId);
      const base = safe === sessionId ? safe : `${safe}-${shortHash(sessionId)}`;
      const file = join(dir, `${base}.json`);
      const tempFile = `${file}.tmp-${process.pid}`;
      mkdirSync(dir, { recursive: true });
      try {
        writeFileSync(tempFile, JSON.stringify(session));
        renameSync(tempFile, file);
      } catch {
        try { unlinkSync(tempFile); } catch { /* best-effort cleanup */ }
      }
    }
  } catch {
    /* never fail the statusline */
  }
});
