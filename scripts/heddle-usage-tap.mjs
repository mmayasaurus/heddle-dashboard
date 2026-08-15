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
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
        const cfg = process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : null;
        const hit = (reg[provider] || []).find((a) => (a.configDir ? resolve(a.configDir) : null) === cfg);
        acct = hit ? hit.id : (cfg ? "unknown-" + cfg.split("/").pop() : "acct1");
      } catch { acct = null; }
      const payload = JSON.stringify({
        model,
        rate_limits: rl,
        capturedAt: Math.floor(Date.now() / 1000),
        account: acct,
        configDir: process.env.CLAUDE_CONFIG_DIR || null,
      });
      writeFileSync(join(dir, `${provider}.json`), payload);
      if (acct) writeFileSync(join(dir, `${provider}-${acct}.json`), payload);
    }
  } catch {
    /* never fail the statusline */
  }
});
