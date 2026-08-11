//! Status bridge for charmbracelet/crush through **shadow configuration injection**.
//!
//! Crush differs from other agents in two important ways:
//! 1. Its only hook is `PreToolUse`, which exposes working state and top-level `session_id` but no
//!    authoritative turn-end/error waiting state. `screenDetect.ts::detectCrush` detects idle from the TUI.
//! 2. Hooks must live in `crush.json`, but `CRUSH_GLOBAL_CONFIG` can select another global directory. At
//!    launch, clone the user's real configuration, merge our hook into `<data_dir>/crush/crush.json`, and
//!    point only this process at it. User files remain untouched, provider/model/API settings are preserved,
//!    and every launch reflects current configuration. `CRUSH_GLOBAL_DATA` remains unset, so session data
//!    and `--session` resume continue using Crush's normal shared data store.
//!
//! **Critical correctness rule**: unlike Antigravity, returning `{"decision":"allow"}` from PreToolUse
//! bypasses Crush's own permission prompt. The observer therefore exits successfully with empty stdout,
//! officially meaning no opinion. It observes working and captures `session_id` without allowing or denying.
//!
//! `PreToolUse` maps to existing `working` handling. server.rs parses and persists `session_id` through
//! `parse_session_id` and Crush-enabled `on_session_id`.
//!
//! Tradeoffs: idle relies on screen detection; approval becomes asking only when detectCrush recognizes the
//! prompt; relative custom hook paths may break when cloned under `<data_dir>/crush/`, though absolute/PATH
//! provider and MCP commands remain valid; Crush cannot fork; and without a user-submit hook, first-message
//! automatic renaming is unavailable, leaving names as `Crush N`.

use std::path::{Path, PathBuf};

/// Namespaced entry in `hooks.PreToolUse`; reinstall removes old same-name entries before appending to avoid
/// duplicates and stale script paths.
const HOOK_NAME: &str = "vlx-term-status";

/// Static POSIX PreToolUse script. Missing VelaTerm variables consume stdin and exit successfully with empty
/// output. curl has a three-second limit and all failures succeed so hooks cannot disrupt Crush. Never return
/// `{"decision":"allow"}`; empty stdout means no opinion and preserves normal permission handling.
const SH_SCRIPT: &str = r#"#!/bin/sh
# vlx-term status bridge hook (auto-installed by vlx-term; safe to delete).
# Only active in crush sessions launched by vlx-term (reads VLX_* env vars).
# Observe-only: exit 0 with EMPTY stdout = "no opinion"; crush runs its normal permission flow.
if [ -z "$VLX_SPAWN_URL" ] || [ -z "$VLX_SESSION_ID" ] || [ -z "$VLX_TOKEN" ]; then
  cat >/dev/null 2>&1
  exit 0
fi
curl -s -m 3 -X POST -H "Content-Type: application/json" --data-binary @- \
  "$VLX_SPAWN_URL/hook/$VLX_SESSION_ID?t=$VLX_TOKEN&e=working" >/dev/null 2>&1
exit 0
"#;

/// Windows PowerShell hook with the same empty-output semantics as `SH_SCRIPT`.
const PS1_SCRIPT: &str = r#"# vlx-term status bridge hook (auto-installed by vlx-term; safe to delete).
# Only active in crush sessions launched by vlx-term (reads VLX_* env vars).
$body = [Console]::In.ReadToEnd()
if ($env:VLX_SPAWN_URL -and $env:VLX_SESSION_ID -and $env:VLX_TOKEN) {
  try {
    Invoke-RestMethod -Method Post -ContentType 'application/json' -TimeoutSec 3 -Body $body `
      -Uri "$($env:VLX_SPAWN_URL)/hook/$($env:VLX_SESSION_ID)?t=$($env:VLX_TOKEN)&e=working" | Out-Null
  } catch {}
}
# Emit nothing: exit 0 + empty stdout = crush treats as "no opinion", normal permission flow.
"#;

/// Shadow configuration directory selected by `CRUSH_GLOBAL_CONFIG`: `<data_dir>/crush`.
pub fn config_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("crush")
}

/// Shadow configuration file: `<data_dir>/crush/crush.json`.
fn config_path(data_dir: &Path) -> PathBuf {
    config_dir(data_dir).join("crush.json")
}

/// Hook script path: `<data_dir>/crush/hook.sh`, or `hook.ps1` on Windows.
fn hook_script_path(data_dir: &Path) -> PathBuf {
    let name = if cfg!(windows) { "hook.ps1" } else { "hook.sh" };
    config_dir(data_dir).join(name)
}

/// Command field string. Crush passes payload through stdin, so no event argument is needed. Unix invokes
/// the executable shebang script directly; Windows uses `powershell -File` with a quoted path.
fn hook_command(script: &Path) -> String {
    if cfg!(windows) {
        format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
            script.display()
        )
    } else {
        script.display().to_string()
    }
}

/// PreToolUse entry omitting matcher to cover all tools, using a namespaced name for deduplication and a
/// generous timeout beyond curl's own limit to prevent a hung script from blocking tool calls.
fn hook_entry(script: &Path) -> serde_json::Value {
    serde_json::json!({
        "name": HOOK_NAME,
        "command": hook_command(script),
        "timeout": 5
    })
}

/// Merge the hook into a cloned Crush configuration in place, replacing same-name PreToolUse entries and
/// preserving all other configuration.
///
/// Structural guards prefer no injection over damaged settings: root must be an object; missing hooks is
/// created but a nonobject errors; missing PreToolUse is created but a nonarray errors.
fn merge_into(root: &mut serde_json::Value, script: &Path) -> Result<(), String> {
    let obj = root
        .as_object_mut()
        .ok_or("crush.json root is not a JSON object")?;
    let hooks = obj.entry("hooks").or_insert_with(|| serde_json::json!({}));
    let hooks_obj = hooks
        .as_object_mut()
        .ok_or("crush.json `hooks` is not a JSON object")?;
    let pre = hooks_obj
        .entry("PreToolUse")
        .or_insert_with(|| serde_json::json!([]));
    let arr = pre
        .as_array_mut()
        .ok_or("crush.json `hooks.PreToolUse` is not an array")?;
    // Remove same-name entries and stale paths before appending the current entry.
    arr.retain(|e| e.get("name").and_then(|n| n.as_str()) != Some(HOOK_NAME));
    arr.push(hook_entry(script));
    Ok(())
}

/// Read-only source path for the user's real global configuration: user-set `CRUSH_GLOBAL_CONFIG`, then
/// `$XDG_CONFIG_HOME/crush`, then `~/.config/crush`, matching Crush on Unix. Windows uses the last best-effort.
fn user_config_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CRUSH_GLOBAL_CONFIG") {
        let p = PathBuf::from(dir);
        if !p.as_os_str().is_empty() {
            return Some(p.join("crush.json"));
        }
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let p = PathBuf::from(xdg);
        if !p.as_os_str().is_empty() {
            return Some(p.join("crush").join("crush.json"));
        }
    }
    crate::host::home_dir().map(|h| h.join(".config").join("crush").join("crush.json"))
}

/// Parse user configuration as a cloning base. Missing or blank content becomes `{}`; invalid JSON returns
/// Err rather than injecting into corrupt data, allowing Crush to start with its own configuration.
fn parse_user_config(existing: Option<&str>) -> Result<serde_json::Value, String> {
    match existing {
        Some(text) if !text.trim().is_empty() => serde_json::from_str(text).map_err(|_| {
            "user crush.json is not valid JSON; not injecting (crush runs as-is)".to_string()
        }),
        _ => Ok(serde_json::json!({})),
    }
}

/// Read the real global configuration through `user_config_path`; a missing file means no configuration.
fn read_user_config() -> Result<serde_json::Value, String> {
    let existing = user_config_path().and_then(|p| std::fs::read_to_string(p).ok());
    parse_user_config(existing.as_deref())
}

/// Install the hook script, preserving matching content/mtime and setting Unix mode 0o755.
fn write_script(script: &Path) -> Result<(), String> {
    let body = if cfg!(windows) { PS1_SCRIPT } else { SH_SCRIPT };
    let current = std::fs::read_to_string(script)
        .map(|s| s == body)
        .unwrap_or(false);
    if !current {
        if let Some(parent) = script.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create crush config directory: {e}"))?;
        }
        std::fs::write(script, body)
            .map_err(|e| format!("Failed to write crush hook script: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("Failed to set crush hook script executable bit: {e}"))?;
        }
    }
    Ok(())
}

/// Write a file only when content differs, preserving mtime otherwise.
fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    let same = std::fs::read_to_string(path)
        .map(|s| s == content)
        .unwrap_or(false);
    if !same {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create crush config directory: {e}"))?;
        }
        std::fs::write(path, content).map_err(|e| format!("Failed to write crush.json: {e}"))?;
    }
    Ok(())
}

/// Install the script, clone user crush.json with our hook into `<data_dir>/crush/crush.json`, and return
/// `<data_dir>/crush` for `CRUSH_GLOBAL_CONFIG`.
///
/// Called lazily on every launch so the clone follows current user settings. Matching files are not rewritten.
///
/// Unwritable data, invalid JSON, or malformed structure returns Err for logging. Crush starts without the
/// override using its own configuration, losing authoritative working/session ID but retaining screen fallback.
pub fn install(data_dir: &Path) -> Result<PathBuf, String> {
    let script = hook_script_path(data_dir);
    let config = config_path(data_dir);
    write_script(&script)?;
    let mut root = read_user_config()?;
    merge_into(&mut root, &script)?;
    let content = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("Failed to serialize crush.json: {e}"))?;
    write_if_changed(&config, &content)?;
    Ok(config_dir(data_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vlx-crush-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn install_writes_script_and_config_with_our_hook() {
        let data_dir = tmp_dir("fresh");
        let dir = install(&data_dir).expect("installation should succeed");
        assert_eq!(dir, config_dir(&data_dir));

        // The installed Unix script is executable, emits e=working, and never returns decision allow.
        let script = std::fs::read_to_string(hook_script_path(&data_dir)).unwrap();
        assert!(
            script.contains("VLX_SESSION_ID"),
            "the script should read VLX_SESSION_ID to decide whether it is enabled"
        );
        assert!(script.contains("e=working"), "the script should report working");
        assert!(!script.contains("decision"), "the script only observes and never returns an allow/deny decision");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(hook_script_path(&data_dir))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o111, 0o111, "the script should be executable");
        }

        // crush.json contains our matcher-free PreToolUse entry for all tools.
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(config_path(&data_dir)).unwrap())
                .unwrap();
        let entry = &v["hooks"]["PreToolUse"][0];
        assert_eq!(entry["name"], HOOK_NAME);
        assert!(
            entry.get("matcher").is_none(),
            "the matcher is omitted so it matches every tool"
        );
        assert!(
            entry["command"].as_str().unwrap().contains("hook"),
            "command points at the hook script"
        );

        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn install_is_idempotent() {
        let data_dir = tmp_dir("idem");
        install(&data_dir).unwrap();
        let cfg_mtime = std::fs::metadata(config_path(&data_dir))
            .unwrap()
            .modified()
            .unwrap();
        let sh_mtime = std::fs::metadata(hook_script_path(&data_dir))
            .unwrap()
            .modified()
            .unwrap();
        install(&data_dir).unwrap();
        assert_eq!(
            std::fs::metadata(config_path(&data_dir))
                .unwrap()
                .modified()
                .unwrap(),
            cfg_mtime,
            "crush.json should not be rewritten when the contents are identical"
        );
        assert_eq!(
            std::fs::metadata(hook_script_path(&data_dir))
                .unwrap()
                .modified()
                .unwrap(),
            sh_mtime,
            "the script should not be rewritten when the contents are identical"
        );
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn merge_preserves_user_settings_and_hooks() {
        // Preserve user provider/model settings and their PreToolUse hook, appending ours afterward.
        let mut root: serde_json::Value = serde_json::json!({
            "$schema": "https://charm.land/crush.json",
            "models": { "large": "anthropic/claude" },
            "hooks": {
                "PreToolUse": [ { "name": "user-guard", "matcher": "^bash$", "command": "/my/guard.sh" } ]
            }
        });
        merge_into(&mut root, Path::new("/data/crush/hook.sh")).unwrap();

        // User settings remain unchanged.
        assert_eq!(root["models"]["large"], "anthropic/claude");
        assert_eq!(root["$schema"], "https://charm.land/crush.json");
        // Preserve the user's hook.
        let arr = root["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(
            arr.iter().any(|e| e["name"] == "user-guard"),
            "the user's own hooks should be preserved"
        );
        // Append our hook after it.
        assert!(
            arr.iter().any(|e| e["name"] == HOOK_NAME),
            "the vlx hook should be appended"
        );
        assert_eq!(arr.len(), 2);
    }

    #[test]
    fn merge_replaces_stale_vlx_entry() {
        // Replace an old VelaTerm entry and stale script path rather than accumulating duplicates.
        let mut root: serde_json::Value = serde_json::json!({
            "hooks": { "PreToolUse": [
                { "name": HOOK_NAME, "command": "/old/data/crush/hook.sh" }
            ] }
        });
        merge_into(&mut root, Path::new("/new/data/crush/hook.sh")).unwrap();
        let arr = root["hooks"]["PreToolUse"].as_array().unwrap();
        let ours: Vec<_> = arr.iter().filter(|e| e["name"] == HOOK_NAME).collect();
        assert_eq!(ours.len(), 1, "entries with this name should be unique, with the old one replaced");
        assert!(
            ours[0]["command"].as_str().unwrap().contains("/new/"),
            "it should point at the new script path"
        );
        assert!(
            !ours[0]["command"].as_str().unwrap().contains("/old/"),
            "the old path should be removed"
        );
    }

    #[test]
    fn merge_creates_hooks_when_missing() {
        // Create hooks when absent from user configuration.
        let mut root = serde_json::json!({ "models": { "large": "x" } });
        merge_into(&mut root, Path::new("/d/hook.sh")).unwrap();
        assert_eq!(root["hooks"]["PreToolUse"][0]["name"], HOOK_NAME);
    }

    #[test]
    fn parse_user_config_missing_and_empty_is_object() {
        assert!(parse_user_config(None).unwrap().is_object());
        assert!(parse_user_config(Some("   ")).unwrap().is_object());
    }

    #[test]
    fn parse_user_config_malformed_is_err() {
        // Invalid JSON returns Err without injection or modification.
        assert!(parse_user_config(Some("{ not json")).is_err());
    }

    #[test]
    fn merge_refuses_non_object_root() {
        let mut arr = serde_json::json!([1, 2, 3]);
        assert!(
            merge_into(&mut arr, Path::new("/d/hook.sh")).is_err(),
            "a root that is not an object should be rejected"
        );
    }

    #[test]
    fn merge_refuses_wrong_typed_hooks() {
        // A nonarray hooks.PreToolUse returns Err without damage.
        let mut root = serde_json::json!({ "hooks": { "PreToolUse": { "bad": true } } });
        assert!(merge_into(&mut root, Path::new("/d/hook.sh")).is_err());
    }
}
