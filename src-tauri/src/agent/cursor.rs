//! Generation and installation of status-bridge hooks for Cursor CLI (`cursor-agent`).
//!
//! Cursor hooks support only fixed configuration files at project, user, or enterprise locations. There
//! is no diskless injection equivalent to Claude `--settings` or OpenCode `OPENCODE_CONFIG_CONTENT`, and
//! three tested `--plugin-dir` layouts failed to activate hooks. To avoid modifying repositories, merge
//! into the user-level `~/.cursor/hooks.json` with the user's consent:
//!
//! - Install a static script at `~/.cursor/vlx-term/hook.sh` in its own namespace.
//! - Merge references into `~/.cursor/hooks.json`, replacing only entries whose command contains
//!   `vlx-term/hook.sh` and preserving all user hooks. Refuse malformed object/array structures rather
//!   than risk damaging configuration.
//! - The static script reads injected `VLX_SESSION_ID`, `VLX_TOKEN`, and `VLX_SPAWN_URL`, forwards stdin
//!   unchanged to `/hook/<sid>?t=<token>&e=<event>`, and keeps dynamic ports/tokens in the environment.
//! - In unmanaged Cursor sessions with missing variables, it quietly returns `{}` as a no-op.
//! - Installation is lazy and occurs only when the user actually launches a Cursor session.
//!
//! Event-to-state mapping, verified in interactive CLI mode. Payloads include the conversation/session
//! chat ID used by `--resume`:
//! - `beforeSubmitPrompt` with submitted prompt text → working.
//! - `stop` on completed, aborted, or error → waiting.
//! - `sessionStart` → `boot`, which leaves status unchanged but lets the server capture a resume anchor.
//!
//! Permission-decision hooks such as `beforeShellExecution` and `beforeMCPExecution` are intentionally
//! omitted because their stdout controls approval and an observational `{}` could interfere. Cursor
//! therefore remains working while awaiting permission, with neutral screen detection as fallback.

use std::path::{Path, PathBuf};

/// Marker identifying heddle entries in hooks.json by command substring.
const MARKER: &str = "vlx-term/hook.sh";

/// Static POSIX hook script where `$1` is working, waiting, or boot. Missing variables consume stdin and
/// return `{}` successfully. curl is limited to three seconds and all failures exit successfully so the
/// hook cannot disrupt Cursor. The final `{}` is Cursor's empty continue response.
const HOOK_SCRIPT: &str = r#"#!/bin/sh
# heddle status-bridge hook, installed and updated automatically and safe to delete at any time.
# Active only in Cursor sessions launched by heddle; missing VLX_* variables make it a no-op.
if [ -z "$VLX_SPAWN_URL" ] || [ -z "$VLX_SESSION_ID" ] || [ -z "$VLX_TOKEN" ]; then
  cat >/dev/null 2>&1
  echo '{}'
  exit 0
fi
curl -s -m 3 -X POST -H "Content-Type: application/json" --data-binary @- \
  "$VLX_SPAWN_URL/hook/$VLX_SESSION_ID?t=$VLX_TOKEN&e=$1" >/dev/null 2>&1
echo '{}'
exit 0
"#;

/// Cursor configuration root: `~/.cursor`.
fn cursor_home() -> Option<PathBuf> {
    crate::host::home_dir().map(|h| h.join(".cursor"))
}

/// Hook script path: `<cursor_home>/vlx-term/hook.sh`, isolated from Cursor-owned files.
fn hook_script_path() -> Option<PathBuf> {
    cursor_home().map(|h| h.join("vlx-term").join("hook.sh"))
}

/// User-level global hooks configuration: `<cursor_home>/hooks.json`.
fn hooks_json_path() -> Option<PathBuf> {
    cursor_home().map(|h| h.join("hooks.json"))
}

/// `(Cursor event name, status event)` pairs to register.
const EVENTS: [(&str, &str); 3] = [
    ("sessionStart", "boot"),
    ("beforeSubmitPrompt", "working"),
    ("stop", "waiting"),
];

/// Build an entry pointing to the hook script: `{"command": "<absolute script path> <event>"}`.
fn hook_entry(script: &Path, event: &str) -> serde_json::Value {
    serde_json::json!({ "command": format!("{} {event}", script.display()) })
}

/// Merge heddle entries into the hooks.json root object in place.
///
/// Create the root, `hooks`, and event arrays as needed; return Err without writing when an existing
/// value has another type. Within each event, replace old commands containing `vlx-term/hook.sh` with
/// the current entry while preserving user-owned entries unchanged.
fn merge_into(root: &mut serde_json::Value, script: &Path) -> Result<(), String> {
    let obj = root
        .as_object_mut()
        .ok_or("hooks.json root is not a JSON object")?;
    // Cursor requires a top-level version; preserve an existing value and add 1 only when missing.
    obj.entry("version").or_insert(serde_json::Value::from(1));
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("hooks.json field 'hooks' is not an object")?;
    for (event, status) in EVENTS {
        let arr = hooks
            .entry(event)
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .ok_or_else(|| format!("hooks.json field hooks.{event} is not an array"))?;
        arr.retain(|e| {
            !e.get("command")
                .and_then(|c| c.as_str())
                .is_some_and(|c| c.contains(MARKER))
        });
        arr.push(hook_entry(script, status));
    }
    Ok(())
}

/// Install the hook script, merge `~/.cursor/hooks.json`, and return the configuration path.
///
/// Idempotent: preserve mtime when script and configuration match. Missing home, permissions, or malformed
/// configuration returns Err for logging; Cursor still starts with neutral screen detection only.
pub fn install() -> Result<PathBuf, String> {
    let script = hook_script_path().ok_or("Failed to resolve user home directory")?;
    let hooks = hooks_json_path().ok_or("Failed to resolve user home directory")?;
    install_at(&script, &hooks)
}

/// As `install`, with explicit target paths for tests.
fn install_at(script: &Path, hooks_json: &Path) -> Result<PathBuf, String> {
    // 1. Preserve matching script contents; make newly written scripts executable.
    let script_current = std::fs::read_to_string(script)
        .map(|s| s == HOOK_SCRIPT)
        .unwrap_or(false);
    if !script_current {
        if let Some(parent) = script.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create script directory: {e}"))?;
        }
        std::fs::write(script, HOOK_SCRIPT)
            .map_err(|e| format!("Failed to write hook script: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("Failed to set script executable bit: {e}"))?;
        }
    }

    // 2. Read hooks.json or an empty object, merge, and preserve matching content. Never touch invalid JSON.
    let existing = std::fs::read_to_string(hooks_json).ok();
    let mut root: serde_json::Value = match &existing {
        Some(text) => serde_json::from_str(text).map_err(|_| {
            "~/.cursor/hooks.json is not valid JSON; not written (please check manually)"
                .to_string()
        })?,
        None => serde_json::json!({}),
    };
    merge_into(&mut root, script)?;
    let content = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("Failed to serialize hooks.json: {e}"))?;
    if existing.as_deref() != Some(content.as_str()) {
        if let Some(parent) = hooks_json.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create .cursor directory: {e}"))?;
        }
        std::fs::write(hooks_json, &content)
            .map_err(|e| format!("Failed to write hooks.json: {e}"))?;
    }
    Ok(hooks_json.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("vlx-cursor-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn fresh_install_writes_script_and_hooks() {
        let dir = tmp_dir("fresh");
        let script = dir.join("vlx-term/hook.sh");
        let hooks = dir.join("hooks.json");

        install_at(&script, &hooks).expect("installation should succeed");

        // The script has matching content and is executable.
        assert_eq!(std::fs::read_to_string(&script).unwrap(), HOOK_SCRIPT);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&script).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "the script should be executable");
        }

        // hooks.json has version 1 and one script command with event name for each of three events.
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&hooks).unwrap()).unwrap();
        assert_eq!(v["version"], 1);
        let cmd_of = |ev: &str| v["hooks"][ev][0]["command"].as_str().unwrap().to_string();
        assert!(cmd_of("sessionStart").ends_with(" boot"));
        assert!(cmd_of("beforeSubmitPrompt").ends_with(" working"));
        assert!(cmd_of("stop").ends_with(" waiting"));
        assert!(cmd_of("stop").contains(MARKER));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_is_idempotent() {
        let dir = tmp_dir("idem");
        let script = dir.join("vlx-term/hook.sh");
        let hooks = dir.join("hooks.json");

        install_at(&script, &hooks).unwrap();
        let mtime1 = std::fs::metadata(&hooks).unwrap().modified().unwrap();
        let smtime1 = std::fs::metadata(&script).unwrap().modified().unwrap();
        install_at(&script, &hooks).unwrap();
        assert_eq!(
            std::fs::metadata(&hooks).unwrap().modified().unwrap(),
            mtime1,
            "hooks.json should not be rewritten when the contents are identical"
        );
        assert_eq!(
            std::fs::metadata(&script).unwrap().modified().unwrap(),
            smtime1,
            "the script should not be rewritten when the contents are identical"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_preserves_user_entries_and_replaces_stale_vlx_entries() {
        let dir = tmp_dir("merge");
        let script = dir.join("vlx-term/hook.sh");
        let hooks = dir.join("hooks.json");

        // Seed user hooks, one old heddle entry, and a user-owned top-level field.
        std::fs::write(
            &hooks,
            r#"{
  "version": 1,
  "custom": "keep-me",
  "hooks": {
    "stop": [
      { "command": "/Users/me/my-own-hook.sh" },
      { "command": "/old/path/vlx-term/hook.sh stale-event" }
    ],
    "afterFileEdit": [ { "command": "/Users/me/format.sh" } ]
  }
}"#,
        )
        .unwrap();

        install_at(&script, &hooks).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&hooks).unwrap()).unwrap();

        // User content remains unchanged.
        assert_eq!(v["custom"], "keep-me");
        assert_eq!(
            v["hooks"]["afterFileEdit"][0]["command"],
            "/Users/me/format.sh"
        );
        let stop = v["hooks"]["stop"].as_array().unwrap();
        assert!(
            stop.iter()
                .any(|e| e["command"] == "/Users/me/my-own-hook.sh"),
            "the user's own stop entries should be preserved"
        );
        // The old entry is replaced by one current entry pointing to the new script and waiting event.
        let vlx: Vec<_> = stop
            .iter()
            .filter(|e| e["command"].as_str().unwrap().contains(MARKER))
            .collect();
        assert_eq!(vlx.len(), 1, "the vlx entries should be deduplicated to one");
        assert!(vlx[0]["command"].as_str().unwrap().ends_with(" waiting"));
        assert!(vlx[0]["command"]
            .as_str()
            .unwrap()
            .starts_with(&script.display().to_string()));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_refuses_to_clobber_invalid_json() {
        let dir = tmp_dir("invalid");
        let script = dir.join("vlx-term/hook.sh");
        let hooks = dir.join("hooks.json");
        std::fs::write(&hooks, "{ not json").unwrap();

        assert!(install_at(&script, &hooks).is_err(), "invalid JSON should be refused rather than written");
        assert_eq!(
            std::fs::read_to_string(&hooks).unwrap(),
            "{ not json",
            "the original file should be left untouched"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_refuses_malformed_structure() {
        let dir = tmp_dir("malform");
        let script = dir.join("vlx-term/hook.sh");
        let hooks = dir.join("hooks.json");
        // Reject a string-valued hooks field without changing the file.
        let original = r#"{"version":1,"hooks":"oops"}"#;
        std::fs::write(&hooks, original).unwrap();

        assert!(install_at(&script, &hooks).is_err());
        assert_eq!(std::fs::read_to_string(&hooks).unwrap(), original);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_respects_existing_version() {
        // Preserve the user's version 2 rather than resetting it to 1.
        let mut root = serde_json::json!({ "version": 2 });
        merge_into(&mut root, Path::new("/x/vlx-term/hook.sh")).unwrap();
        assert_eq!(root["version"], 2);
    }
}
