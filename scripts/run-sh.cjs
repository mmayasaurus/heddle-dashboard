#!/usr/bin/env node
// run-sh.cjs — Thin cross-platform launcher for scripts/<name>.sh, used by package.json dev:* / release commands.
//
// All development/release logic lives in one Bash script shared by macOS, Linux, and Windows Git Bash. On
// Windows, invoking `bash scripts/xxx.sh` is unreliable because `bash` on system PATH is often the **WSL launcher**
// at C:\Windows\System32\bash.exe (or WindowsApps), not Git Bash, and fails outright without a WSL distribution.
// Node is always present when pnpm runs, so this launcher explicitly finds Git Bash's bash.exe, bypasses the WSL
// shim, and runs the shared .sh. macOS/Linux simply use bash from PATH.
//
// This is not a separate Windows implementation: all platforms run the same Bash script; Node only locates the correct interpreter.
//
// Usage: node scripts/run-sh.cjs <script-in-scripts-dir.sh> [args...]
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const [script, ...rest] = process.argv.slice(2);
if (!script) {
  console.error("usage: node scripts/run-sh.cjs <script.sh> [args...]");
  process.exit(2);
}
const scriptPath = path.join(__dirname, script);
if (!fs.existsSync(scriptPath)) {
  console.error(`[run-sh] Script does not exist: ${scriptPath}`);
  process.exit(2);
}

// Locate Bash: use PATH outside Windows; on Windows, find Git Bash explicitly and avoid WSL's bash.exe.
function findBash() {
  if (process.platform !== "win32") return "bash";

  const roots = [
    process.env.GIT_INSTALL_ROOT, // Let users specify the Git installation root explicitly.
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ].filter(Boolean);

  const candidates = [];
  for (const r of roots) {
    // GIT_INSTALL_ROOT points directly to Git; other candidates are <root>\Git\.... Try both layouts.
    candidates.push(path.join(r, "bin", "bash.exe"));
    candidates.push(path.join(r, "usr", "bin", "bash.exe"));
    candidates.push(path.join(r, "Git", "bin", "bash.exe"));
    candidates.push(path.join(r, "Git", "usr", "bin", "bash.exe"));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }

  // Fallback: derive it from `where git` (…\Git\cmd\git.exe → …\Git\bin\bash.exe).
  try {
    const r = spawnSync("where", ["git"], { encoding: "utf8" });
    const line = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (line) {
      const gitRoot = path.dirname(path.dirname(line)); // …\Git
      const b = path.join(gitRoot, "bin", "bash.exe");
      if (fs.existsSync(b)) return b;
    }
  } catch { /* ignore */ }

  return null;
}

const bash = findBash();
if (!bash) {
  console.error("[run-sh] Could not find Git Bash's bash.exe (the bash on the system PATH is the WSL shim, which does not work here).");
  console.error("         Install Git for Windows: https://git-scm.com/download/win");
  console.error("         Or set GIT_INSTALL_ROOT to your Git installation directory.");
  process.exit(1);
}

// Pass the script path with forward slashes, which Git Bash parses most reliably; forward all other arguments verbatim.
const res = spawnSync(bash, [scriptPath.replace(/\\/g, "/"), ...rest], { stdio: "inherit" });
if (res.error) {
  console.error(`[run-sh] Failed to start bash: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status == null ? 1 : res.status);
