//! Generation and installation of status-bridge hooks for Google Antigravity CLI (`agy`).
//!
//! Antigravity hooks support only fixed global/project JSON files, with no inline or runtime-directory
//! injection like Claude, OpenCode, or Cline. To avoid modifying repositories, merge into the global user
//! `hooks.json`, as with Cursor:
//!
//! - Install a static script under `~/.gemini/vlx-term/`, using hook.ps1 on Windows.
//! - Replace only the namespaced top-level `vlx-term-status` group in global hooks.json, preserving all user
//!   groups and refusing a nonobject root. The static script reads injected VLX_* values, forwards stdin to
//!   `/hook/<sid>?t=<token>&e=<state>`, and returns `{"decision":"allow"}` so observation never blocks tools.
//! - Missing variables in unmanaged sessions produce a harmless allow response.
//! - Install lazily only when an Antigravity session actually launches.
//!
//! Register only turn-level lifecycle checkpoints: PreInvocation → working, PostInvocation → waiting, and
//! Stop → waiting as a turn-end fallback. Tool-level hooks would spawn scripts without improving state.
//!
//! Invocation events use the verified flat `[{"type":"command","command":"<script> <state>"}]` form
//! without matcher or nested hooks, matching the production Orca integration. Only tool events use wrappers.
//!
//! Each payload carries top-level `session_id`, the `--conversation=<id>` resume anchor persisted by server.rs.
//!
//! Antigravity has no safely observable approval lifecycle hook because those hooks decide allow/deny/ask.
//! Permission prompts therefore remain working, with neutral screen detection as fallback.
//!
//! Device verification confirmed `~/.gemini/config/hooks.json` from embedded docs and Orca's installation;
//! the older community path is invalid. Flat matcher-free invocation events coexist through namespacing.
//! Exact Pre/PostInvocation granularity still needs a logged-in conversation check; Stop and working-state
//! debouncing mitigate either behavior.

use std::path::{Path, PathBuf};

/// Namespaced top-level hooks.json group; all other groups remain untouched.
const GROUP: &str = "vlx-term-status";

/// Static POSIX script where `$1` is working/waiting. Missing variables and curl failures consume input,
/// return allow, and exit successfully so hooks cannot disrupt Antigravity.
const SH_SCRIPT: &str = r#"#!/bin/sh
# vlx-term status bridge hook (auto-installed by vlx-term; safe to delete).
# Only active in Antigravity (agy) sessions launched by vlx-term (reads VLX_* env vars).
if [ -z "$VLX_SPAWN_URL" ] || [ -z "$VLX_SESSION_ID" ] || [ -z "$VLX_TOKEN" ]; then
  cat >/dev/null 2>&1
  echo '{"decision":"allow"}'
  exit 0
fi
curl -s -m 3 -X POST -H "Content-Type: application/json" --data-binary @- \
  "$VLX_SPAWN_URL/hook/$VLX_SESSION_ID?t=$VLX_TOKEN&e=$1" >/dev/null 2>&1
echo '{"decision":"allow"}'
exit 0
"#;

/// Windows PowerShell script matching SH_SCRIPT, with state in `$args[0]`.
const PS1_SCRIPT: &str = r#"# vlx-term status bridge hook (auto-installed by vlx-term; safe to delete).
# Only active in Antigravity (agy) sessions launched by vlx-term (reads VLX_* env vars).
param([string]$Event)
$body = [Console]::In.ReadToEnd()
if ($env:VLX_SPAWN_URL -and $env:VLX_SESSION_ID -and $env:VLX_TOKEN) {
  try {
    Invoke-RestMethod -Method Post -ContentType 'application/json' -TimeoutSec 3 -Body $body `
      -Uri "$($env:VLX_SPAWN_URL)/hook/$($env:VLX_SESSION_ID)?t=$($env:VLX_TOKEN)&e=$Event" | Out-Null
  } catch {}
}
Write-Output '{"decision":"allow"}'
"#;

/// `(Antigravity event, status e= value)` pairs to register.
const EVENTS: [(&str, &str); 3] = [
    ("PreInvocation", "working"),
    ("PostInvocation", "waiting"),
    ("Stop", "waiting"),
];

/// Gemini configuration root: `~/.gemini`.
fn gemini_home() -> Option<PathBuf> {
    crate::host::home_dir().map(|h| h.join(".gemini"))
}

/// Hook script path under `~/.gemini/vlx-term/`, using hook.ps1 on Windows.
fn hook_script_path() -> Option<PathBuf> {
    let name = if cfg!(windows) { "hook.ps1" } else { "hook.sh" };
    gemini_home().map(|h| h.join("vlx-term").join(name))
}

/// Verified global hooks path: `~/.gemini/config/hooks.json`. Embedded docs and Orca confirm it; the older
/// community-reported antigravity-cli path is not recognized and is never written.
fn hooks_json_path() -> Option<PathBuf> {
    gemini_home().map(|h| h.join("config").join("hooks.json"))
}

/// Build the hooks.json command: execute the shebang script directly on Unix or quoted `powershell -File`
/// for a Windows `.ps1` path.
fn hook_command(script: &Path, event: &str) -> String {
    if cfg!(windows) {
        format!(
            "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\" {event}",
            script.display()
        )
    } else {
        format!("{} {event}", script.display())
    }
}

/// Construct our flat event group without nested hooks, matcher, or redundant JSON timeout.
fn build_group(script: &Path) -> serde_json::Value {
    let mut group = serde_json::Map::new();
    for (event, status) in EVENTS {
        group.insert(
            event.to_string(),
            serde_json::json!([
                {
                    "type": "command",
                    "command": hook_command(script, status)
                }
            ]),
        );
    }
    serde_json::Value::Object(group)
}

/// Merge only `root["vlx-term-status"]` in place, preserving other groups; reject a nonobject root.
fn merge_into(root: &mut serde_json::Value, script: &Path) -> Result<(), String> {
    let obj = root
        .as_object_mut()
        .ok_or("hooks.json root is not a JSON object")?;
    obj.insert(GROUP.to_string(), build_group(script));
    Ok(())
}

/// Install the hook script, merge global hooks.json, and return its path.
///
/// Idempotently preserve matching content/mtime. Missing home, permissions, or malformed JSON returns Err
/// for logging; Antigravity still starts with screen-detected state only.
pub fn install() -> Result<PathBuf, String> {
    let script = hook_script_path().ok_or("Failed to resolve user home directory")?;
    let hooks = hooks_json_path().ok_or("Failed to resolve user home directory")?;
    install_at(&script, &hooks)
}

/// As `install`, with explicit target paths for tests.
fn install_at(script: &Path, hooks_json: &Path) -> Result<PathBuf, String> {
    // 1. Preserve matching script content and make Unix files executable.
    let body = if cfg!(windows) { PS1_SCRIPT } else { SH_SCRIPT };
    let script_current = std::fs::read_to_string(script)
        .map(|s| s == body)
        .unwrap_or(false);
    if !script_current {
        if let Some(parent) = script.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create script directory: {e}"))?;
        }
        std::fs::write(script, body).map_err(|e| format!("Failed to write hook script: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("Failed to set script executable bit: {e}"))?;
        }
    }

    // 2. Read hooks.json or an empty object, merge, and write only changes; reject invalid JSON unchanged.
    merge_one(script, hooks_json)?;
    Ok(hooks_json.to_path_buf())
}

/// Read, merge, and write one hooks.json only on change; reject invalid JSON without overwriting.
fn merge_one(script: &Path, hooks_json: &Path) -> Result<(), String> {
    let existing = std::fs::read_to_string(hooks_json).ok();
    let mut root: serde_json::Value = match &existing {
        Some(text) if !text.trim().is_empty() => serde_json::from_str(text).map_err(|_| {
            format!(
                "{} is not valid JSON; not written (please check manually)",
                hooks_json.display()
            )
        })?,
        _ => serde_json::json!({}),
    };
    merge_into(&mut root, script)?;
    let content = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("Failed to serialize hooks.json: {e}"))?;
    if existing.as_deref() != Some(content.as_str()) {
        if let Some(parent) = hooks_json.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create hooks.json directory: {e}"))?;
        }
        std::fs::write(hooks_json, &content)
            .map_err(|e| format!("Failed to write hooks.json: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("vlx-antigravity-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn fresh_install_writes_script_and_group() {
        let dir = tmp_dir("fresh");
        let script = dir.join("vlx-term/hook.sh");
        let hooks = dir.join("config/hooks.json");

        install_at(&script, &hooks).expect("installation should succeed");

        // The script is installed and executable on Unix.
        assert!(std::fs::read_to_string(&script)
            .unwrap()
            .contains("VLX_SESSION_ID"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&script).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "the script should be executable");
        }

        // hooks.json contains our group and three flat event mappings.
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&hooks).unwrap()).unwrap();
        let pre = v[GROUP]["PreInvocation"][0]["command"].as_str().unwrap();
        let post = v[GROUP]["PostInvocation"][0]["command"].as_str().unwrap();
        let stop = v[GROUP]["Stop"][0]["command"].as_str().unwrap();
        assert!(
            pre.ends_with(" working"),
            "PreInvocation should report working: {pre}"
        );
        assert!(
            post.ends_with(" waiting"),
            "PostInvocation should report waiting: {post}"
        );
        assert!(stop.ends_with(" waiting"), "Stop should report waiting: {stop}");
        assert_eq!(v[GROUP]["PreInvocation"][0]["type"], "command");
        // Invocation events are flat, without nested hooks or matcher, matching Orca production form.
        assert!(
            v[GROUP]["PreInvocation"][0].get("hooks").is_none(),
            "it should not wrap the entries in a hooks sub-array"
        );
        assert!(
            v[GROUP]["PreInvocation"][0].get("matcher").is_none(),
            "invocation-level events carry no matcher"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_is_idempotent() {
        let dir = tmp_dir("idem");
        let script = dir.join("vlx-term/hook.sh");
        let hooks = dir.join("config/hooks.json");

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
    fn merge_preserves_other_top_level_groups() {
        let dir = tmp_dir("preserve");
        let script = dir.join("vlx-term/hook.sh");
        let hooks = dir.join("config/hooks.json");
        std::fs::create_dir_all(hooks.parent().unwrap()).unwrap();
        // Seed user groups and an old heddle group to be replaced as a whole.
        std::fs::write(
            &hooks,
            r#"{
  "user-linter": { "PostToolUse": [ { "matcher": "write", "hooks": [ { "command": "/my/lint.sh" } ] } ] },
  "vlx-term-status": { "PreInvocation": [ { "hooks": [ { "command": "/old/hook.sh working" } ] } ] }
}"#,
        )
        .unwrap();

        install_at(&script, &hooks).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&hooks).unwrap()).unwrap();

        // User groups remain unchanged.
        assert_eq!(
            v["user-linter"]["PostToolUse"][0]["hooks"][0]["command"],
            "/my/lint.sh"
        );
        // Our group now points to the current script and no longer contains the old path.
        let pre = v[GROUP]["PreInvocation"][0]["command"].as_str().unwrap();
        assert!(pre.starts_with(&script.display().to_string()) || pre.contains("hook.sh"));
        assert!(!pre.contains("/old/hook.sh"), "the old vlx group should be replaced wholesale");
        assert!(v[GROUP].get("PostInvocation").is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_refuses_to_clobber_invalid_json() {
        let dir = tmp_dir("invalid");
        let script = dir.join("vlx-term/hook.sh");
        let hooks = dir.join("config/hooks.json");
        std::fs::create_dir_all(hooks.parent().unwrap()).unwrap();
        std::fs::write(&hooks, "{ not json").unwrap();

        // Invalid JSON returns Err and leaves the original file unchanged.
        assert!(install_at(&script, &hooks).is_err(), "invalid JSON should be refused rather than written");
        assert_eq!(
            std::fs::read_to_string(&hooks).unwrap(),
            "{ not json",
            "invalid JSON should be left untouched"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
