//! Generation and installation of Cline CLI (`cline`) status-bridge hook scripts.
//!
//! Cline registers executable scripts by placing them in a directory with filenames matching hook
//! names. It also accepts a runtime hooks directory through `CLINE_HOOKS_DIR`, equivalent to
//! `--hooks-dir`, merged with global and project hooks. This makes Cline the least invasive agent:
//! heddle installs scripts under its own `<data_dir>/cline/hooks/`, like the OpenCode plugin, and
//! `pty/manager.rs` adds `CLINE_HOOKS_DIR=<that directory>` when launching a Cline session.
//!
//! - **No user configuration is written**: heddle never touches `~/.cline` or merges user hook files.
//!   `CLINE_HOOKS_DIR` exists only in sessions launched by heddle, so unmanaged Cline processes never
//!   see these scripts. VLX_* guards remain in each script in case users configure the directory manually.
//! - Scripts are **fully static**, one per event with a fixed `e=` value. They read the injected
//!   `VLX_SESSION_ID`, `VLX_TOKEN`, and `VLX_SPAWN_URL`, forward stdin unchanged with
//!   `curl --data-binary @-` to `/hook/<sid>?t=<token>&e=<event>`, then return `{}`. Dynamic ports and
//!   tokens remain in the environment, so files need no launch-time rewrites and match across builds.
//!
//! Event-to-state mapping installs only six scripts. PreToolUse/PostToolUse would spawn a process for
//! every tool call without improving state detection; PreCompact/SessionShutdown do not reflect work:
//! - `TaskStart` / `TaskResume` → `boot`: no state change, but the server captures Cline's taskId from
//!   the body as the next `--id <id>` resume anchor, available immediately when the session opens.
//! - `UserPromptSubmit`, whose payload includes the submitted text, → working.
//! - `TaskComplete` / `TaskError` → waiting.
//! - User-initiated `TaskCancel` → `idle`, a silent waiting state correction without notification.
//!
//! Known tradeoff, matching Cursor: Cline has no hooks for awaiting approval or asking a mid-turn
//! question, so the status remains working in those cases. `detectCline` in `screenDetect.ts` provides
//! a neutral screen-based fallback; add TUI-specific rules only if real sessions often remain stuck.
//!
//! **Windows**: Cline now supports `.ps1` hooks, pending real-device validation. Depending on
//! `cfg!(windows)`, install either `.sh` on Unix or `.ps1` on Windows, never both; duplicate base names
//! with both extensions would register and emit each event twice.

use std::path::{Path, PathBuf};

/// Registered `(hook filename stem, status event e= value)` pairs. The stem is Cline's hook name;
/// the platform-specific extension is appended separately.
const EVENTS: [(&str, &str); 6] = [
    ("TaskStart", "boot"),
    ("TaskResume", "boot"),
    ("UserPromptSubmit", "working"),
    ("TaskComplete", "waiting"),
    ("TaskError", "waiting"),
    ("TaskCancel", "idle"),
];

/// Static POSIX hook template; `__EVENT__` is replaced with each script's `e=` value.
/// - Missing variables indicate an unmanaged session: consume stdin, return `{}`, and exit successfully.
/// - curl has a three-second limit and failures exit successfully so hooks cannot disrupt Cline itself.
/// - Always return `{}` because Cline reads stdout as the optional hook response.
const SH_TEMPLATE: &str = r#"#!/bin/sh
# vlx-term status bridge hook (auto-installed by vlx-term; safe to delete).
# Only active in cline sessions launched by vlx-term (reads VLX_* env vars).
if [ -z "$VLX_SPAWN_URL" ] || [ -z "$VLX_SESSION_ID" ] || [ -z "$VLX_TOKEN" ]; then
  cat >/dev/null 2>&1
  echo '{}'
  exit 0
fi
curl -s -m 3 -X POST -H "Content-Type: application/json" --data-binary @- \
  "$VLX_SPAWN_URL/hook/$VLX_SESSION_ID?t=$VLX_TOKEN&e=__EVENT__" >/dev/null 2>&1
echo '{}'
exit 0
"#;

/// Windows PowerShell hook template with the same semantics as `SH_TEMPLATE`. Read all stdin as the
/// body, forward it with `Invoke-RestMethod`, and quietly return `{}` on failure or missing variables.
const PS1_TEMPLATE: &str = r#"# vlx-term status bridge hook (auto-installed by vlx-term; safe to delete).
# Only active in cline sessions launched by vlx-term (reads VLX_* env vars).
$body = [Console]::In.ReadToEnd()
if ($env:VLX_SPAWN_URL -and $env:VLX_SESSION_ID -and $env:VLX_TOKEN) {
  try {
    Invoke-RestMethod -Method Post -ContentType 'application/json' -TimeoutSec 3 -Body $body `
      -Uri "$($env:VLX_SPAWN_URL)/hook/$($env:VLX_SESSION_ID)?t=$($env:VLX_TOKEN)&e=__EVENT__" | Out-Null
  } catch {}
}
Write-Output '{}'
"#;

/// Generate the POSIX hook script for an event by baking its `e=` value into the template.
fn sh_script(event: &str) -> String {
    SH_TEMPLATE.replace("__EVENT__", event)
}

/// Generate the PowerShell hook script for an event by baking its `e=` value into the template.
fn ps1_script(event: &str) -> String {
    PS1_TEMPLATE.replace("__EVENT__", event)
}

/// Hooks directory: `<data_dir>/cline/hooks/`.
pub fn hooks_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("cline").join("hooks")
}

/// Platform-specific script filename for an event: `.ps1` on Windows or `.sh` on Unix.
fn script_name(event: &str) -> String {
    if cfg!(windows) {
        format!("{event}.ps1")
    } else {
        format!("{event}.sh")
    }
}

/// Platform-specific script contents for an event: PowerShell on Windows or POSIX sh on Unix.
fn script_body(event: &str) -> String {
    if cfg!(windows) {
        ps1_script(event)
    } else {
        sh_script(event)
    }
}

/// Install the six hook scripts under `<data_dir>/cline/hooks/` and return that directory.
///
/// Idempotent: preserve mtime when contents match; set Unix files executable with mode 0o755.
/// Permission and other failures return Err for logging. Cline still launches, falling back to neutral
/// screen detection without authoritative state events.
pub fn install(data_dir: &Path) -> Result<PathBuf, String> {
    let dir = hooks_dir(data_dir);
    install_at(&dir)
}

/// As `install`, but with an explicit target directory for tests.
fn install_at(dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create cline hooks directory: {e}"))?;
    for (event, ev) in EVENTS {
        let path = dir.join(script_name(event));
        let content = script_body(ev);
        // Preserve matching files and their mtime; overwrite scripts changed by a heddle upgrade.
        let current = std::fs::read_to_string(&path)
            .map(|s| s == content)
            .unwrap_or(false);
        if !current {
            std::fs::write(&path, &content)
                .map_err(|e| format!("Failed to write cline hook script: {e}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| format!("Failed to set hook script executable bit: {e}"))?;
            }
        }
    }
    Ok(dir.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vlx-cline-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn fresh_install_writes_six_scripts_with_correct_events() {
        let root = tmp_dir("fresh");
        let dir = install(&root).expect("writing out the scripts should succeed");
        assert_eq!(dir, hooks_dir(&root));

        // Install all six scripts with their corresponding e= values.
        let expect: [(&str, &str); 6] = [
            ("TaskStart", "boot"),
            ("TaskResume", "boot"),
            ("UserPromptSubmit", "working"),
            ("TaskComplete", "waiting"),
            ("TaskError", "waiting"),
            ("TaskCancel", "idle"),
        ];
        for (event, ev) in expect {
            let p = dir.join(script_name(event));
            let body = std::fs::read_to_string(&p).unwrap_or_else(|_| panic!("{event} should have been written out"));
            assert!(body.contains(&format!("&e={ev}")), "{event} should report e={ev}");
            // Verify the variable guard, forwarding logic, and `{}` response to catch empty scripts.
            assert!(body.contains("VLX_SPAWN_URL"), "{event} should guard on the variable");
            assert!(body.contains("VLX_SESSION_ID"), "{event} should carry the session id");
            assert!(
                body.contains("--data-binary @-") || body.contains("ReadToEnd"),
                "{event} should forward stdin verbatim"
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&p).unwrap().permissions().mode();
                assert_eq!(mode & 0o111, 0o111, "the {event} script should be executable");
            }
        }

        // Install only this platform's extension to prevent duplicate event registration.
        let entries: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries.len(), 6, "expected exactly six scripts, got: {entries:?}");
        let ext = if cfg!(windows) { ".ps1" } else { ".sh" };
        let other = if cfg!(windows) { ".sh" } else { ".ps1" };
        assert!(entries.iter().all(|n| n.ends_with(ext)), "all of them should be {ext}");
        assert!(
            !entries.iter().any(|n| n.ends_with(other)),
            "{other} should not be written out"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_is_idempotent() {
        let root = tmp_dir("idem");
        let dir = install(&root).unwrap();
        let sample = dir.join(script_name("TaskComplete"));
        let mtime1 = std::fs::metadata(&sample).unwrap().modified().unwrap();
        install(&root).unwrap();
        let mtime2 = std::fs::metadata(&sample).unwrap().modified().unwrap();
        assert_eq!(mtime1, mtime2, "the scripts should not be rewritten when the contents are identical");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_rewrites_on_content_change() {
        // Restore current content over an old or accidentally modified script.
        let root = tmp_dir("rewrite");
        let dir = install(&root).unwrap();
        let sample = dir.join(script_name("TaskError"));
        std::fs::write(&sample, "stale").unwrap();
        install(&root).unwrap();
        let body = std::fs::read_to_string(&sample).unwrap();
        assert_ne!(body, "stale", "the latest script should be written back over it");
        assert!(body.contains("&e=waiting"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
