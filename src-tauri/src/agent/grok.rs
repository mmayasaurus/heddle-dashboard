//! Grok Build lifecycle-hook integration.
//!
//! Grok discovers user-level hooks only from fixed files under `GROK_HOME`/`~/.grok`; it has no
//! per-launch inline hook flag. Install one dedicated, namespaced file and leave every user-owned
//! hook untouched. Commands invoke the current heddle executable, which reads the dynamic
//! `VLX_*` values inherited by Grok and quietly no-ops in ordinary, unmanaged Grok sessions.

use std::path::{Path, PathBuf};

const HOOKS_FILE: &str = "vlx-term.json";

/// Grok hook installation audit. Never log hook content, executable paths, tokens, or session data.
pub fn audit_install(status: &str, duration_ms: u128) {
    let now = time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
    let level = if status == "failed" { "WARN" } else { "INFO" };
    eprintln!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02} [{:<5}] [system] event=grok_hook_install step=hooks method=namespaced_file inputCount=1 outputCount={} status={} durationMs={}",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        level,
        if status == "success" { 1 } else { 0 },
        status,
        duration_ms,
    );
}

fn grok_home() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("GROK_HOME") {
        return Some(PathBuf::from(home));
    }
    crate::host::home_dir().map(|home| home.join(".grok"))
}

fn hooks_path() -> Option<PathBuf> {
    grok_home().map(|home| home.join("hooks").join(HOOKS_FILE))
}

/// Quote an executable path for the platform shell used by Grok command hooks.
fn hook_command(exe: &Path, state: &str) -> String {
    #[cfg(windows)]
    {
        // A double quote is not legal in a Windows file name, so wrapping is sufficient for cmd/PowerShell.
        format!("\"{}\" --grok-hook {state}", exe.display())
    }
    #[cfg(not(windows))]
    {
        let quoted = exe.to_string_lossy().replace('\'', "'\\''");
        format!("'{quoted}' --grok-hook {state}")
    }
}

fn handler(exe: &Path, state: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "command",
        "command": hook_command(exe, state),
        "timeout": 5
    })
}

fn group(exe: &Path, state: &str) -> serde_json::Value {
    serde_json::json!([{ "hooks": [handler(exe, state)] }])
}

/// Generate Grok's official hook schema.
///
/// `PostToolUse` is deliberately omitted: `PreToolUse` already establishes working state, while a
/// separately spawned post-tool callback can race with `Stop` and restore stale working state.
pub fn hooks_json(exe: &Path) -> String {
    let value = serde_json::json!({
        "hooks": {
            // Startup captures Grok's sessionId without inventing a completed-turn state.
            "SessionStart": group(exe, "boot"),
            "UserPromptSubmit": group(exe, "working"),
            "PreToolUse": group(exe, "working"),
            // Notification covers interactive permission/elicitation prompts on compatible builds.
            "Notification": [{
                "matcher": "permission_prompt|elicitation_dialog",
                "hooks": [handler(exe, "asking")]
            }],
            // A denied permission still requires user action even if no Notification preceded it.
            "PermissionDenied": group(exe, "asking"),
            "Stop": group(exe, "waiting"),
            "StopFailure": group(exe, "idle"),
            "SessionEnd": group(exe, "idle")
        }
    });
    serde_json::to_string_pretty(&value).expect("static Grok hook JSON must serialize")
}

/// Lazily install/update only `~/.grok/hooks/vlx-term.json`.
pub fn install(exe: &Path) -> Result<PathBuf, String> {
    let path = hooks_path().ok_or("Failed to resolve Grok home directory")?;
    install_at(exe, &path)
}

fn install_at(exe: &Path, path: &Path) -> Result<PathBuf, String> {
    let content = hooks_json(exe);
    if std::fs::read_to_string(path).ok().as_deref() == Some(content.as_str()) {
        return Ok(path.to_path_buf());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Grok hooks directory: {e}"))?;
    }
    std::fs::write(path, content).map_err(|e| format!("Failed to write Grok hooks: {e}"))?;
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_json_maps_complete_lifecycle_without_post_tool_race() {
        let exe = Path::new("/Applications/Vela Term/velaterm");
        let value: serde_json::Value =
            serde_json::from_str(&hooks_json(exe)).expect("hooks JSON should parse");
        let hooks = value["hooks"].as_object().expect("hooks object");
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "Notification",
            "PermissionDenied",
            "Stop",
            "StopFailure",
            "SessionEnd",
        ] {
            assert!(hooks.contains_key(event), "missing {event}");
        }
        assert!(!hooks.contains_key("PostToolUse"));
        assert_eq!(hooks["UserPromptSubmit"][0]["hooks"][0]["type"], "command");
        assert!(hooks["UserPromptSubmit"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("--grok-hook working"));
        assert_eq!(
            hooks["Notification"][0]["matcher"],
            "permission_prompt|elicitation_dialog"
        );
    }

    #[test]
    fn install_is_idempotent_and_updates_executable_path() {
        let root = std::env::temp_dir().join(format!("vlx-grok-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let target = root.join("hooks").join(HOOKS_FILE);
        let first = Path::new("/old/vlx-term");
        install_at(first, &target).expect("initial install");
        let mtime = std::fs::metadata(&target).unwrap().modified().unwrap();
        install_at(first, &target).expect("idempotent install");
        assert_eq!(
            mtime,
            std::fs::metadata(&target).unwrap().modified().unwrap()
        );

        let second = Path::new("/new/vlx-term");
        install_at(second, &target).expect("upgrade install");
        assert!(std::fs::read_to_string(&target)
            .unwrap()
            .contains("/new/vlx-term"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
