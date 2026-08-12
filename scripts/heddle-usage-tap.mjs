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
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
      writeFileSync(
        join(dir, `${provider}.json`),
        JSON.stringify({
          model,
          rate_limits: rl,
          capturedAt: Math.floor(Date.now() / 1000),
        }),
      );
    }
  } catch {
    /* never fail the statusline */
  }
});
