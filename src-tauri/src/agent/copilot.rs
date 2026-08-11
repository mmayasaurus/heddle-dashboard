//! Generate and install GitHub Copilot CLI status-bridge hooks.
//!
//! Copilot hooks load only from fixed configuration directories and have no nonpersistent inline
//! injection like Claude `--settings` or OpenCode `OPENCODE_CONFIG_CONTENT`. Redirecting COPILOT_HOME
//! would also move authentication and history, so use a minimally invasive user-level hook file:
//!
//! - Write only `~/.copilot/hooks/vlx-term.json` (respecting COPILOT_HOME), leaving user files untouched.
//! - Static Bash/PowerShell commands read injected session variables, build the hook URL, and forward
//!   stdin payload unchanged. Dynamic ports/tokens stay in the environment, so startup needs no rewrite.
//! - Outside a vlx-managed session, missing variables make the hook exit successfully without effects.
//! - Install lazily only when the user actually starts a Copilot session.
//!
//! Event-to-state mapping aligned with Claude hook semantics and Copilot camelCase names:
//! - `userPromptSubmitted` / `preToolUse` / `postToolUse` → working
//! - `agentStop` (turn complete) -> waiting
//! - `permissionRequest` -> asking; an auto-approved request is immediately followed by working preToolUse
//! - `errorOccurred` → waiting
//! - `sessionStart` -> boot, carrying Copilot's session ID for a future `--resume=<id>` without state change

use std::path::{Path, PathBuf};

/// Namespaced output filename that cannot conflict with user hook files.
const HOOKS_FILE: &str = "vlx-term.json";

/// Copilot configuration root: COPILOT_HOME or ~/.copilot.
fn copilot_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("COPILOT_HOME") {
        return Some(PathBuf::from(h));
    }
    crate::host::home_dir().map(|h| h.join(".copilot"))
}

/// Hook target path: `<copilot_home>/hooks/vlx-term.json`.
pub fn hooks_path() -> Option<PathBuf> {
    copilot_home().map(|h| h.join("hooks").join(HOOKS_FILE))
}

/// Generate a command hook that reports one event.
///
/// Bash sends only with all three VLX variables, forwards stdin unchanged via `--data-binary @-`,
/// limits the request to three seconds, and always exits zero so hook failure cannot interrupt Copilot.
/// PowerShell implements the same semantics for Windows.
fn hook_entry(event: &str) -> serde_json::Value {
    let bash = format!(
        "[ -n \"$VLX_SPAWN_URL\" ] && [ -n \"$VLX_SESSION_ID\" ] && [ -n \"$VLX_TOKEN\" ] || exit 0; \
         curl -s -m 3 -X POST -H \"Content-Type: application/json\" --data-binary @- \
         \"$VLX_SPAWN_URL/hook/$VLX_SESSION_ID?t=$VLX_TOKEN&e={event}\" >/dev/null 2>&1; exit 0"
    );
    let powershell = format!(
        "if ($env:VLX_SPAWN_URL -and $env:VLX_SESSION_ID -and $env:VLX_TOKEN) {{ \
         try {{ $b = [Console]::In.ReadToEnd(); \
         Invoke-RestMethod -Method Post -ContentType 'application/json' -TimeoutSec 3 -Body $b \
         -Uri \"$($env:VLX_SPAWN_URL)/hook/$($env:VLX_SESSION_ID)?t=$($env:VLX_TOKEN)&e={event}\" \
         | Out-Null }} catch {{}} }}; exit 0"
    );
    serde_json::json!({
        "type": "command",
        "bash": bash,
        "powershell": powershell,
        "timeoutSec": 5
    })
}

/// Generate pretty-printed hook JSON for easy user inspection.
pub fn hooks_json() -> String {
    let v = serde_json::json!({
        "version": 1,
        "hooks": {
            "sessionStart": [hook_entry("boot")],
            "userPromptSubmitted": [hook_entry("working")],
            "preToolUse": [hook_entry("working")],
            "postToolUse": [hook_entry("working")],
            "permissionRequest": [hook_entry("asking")],
            "agentStop": [hook_entry("waiting")],
            "errorOccurred": [hook_entry("waiting")]
        }
    });
    serde_json::to_string_pretty(&v).expect("serializing static JSON should not fail")
}

/// Install the hook file and return its path.
///
/// Idempotently preserve mtime when content matches and overwrite changed mappings after upgrades.
/// Missing home or permissions return Err for logging only; Copilot still starts with screen inference.
pub fn install() -> Result<PathBuf, String> {
    let path = hooks_path().ok_or("Failed to resolve user home directory")?;
    install_at(&path)
}

/// Like install, with an explicit target path for tests.
fn install_at(path: &Path) -> Result<PathBuf, String> {
    let content = hooks_json();
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == content {
            return Ok(path.to_path_buf());
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create hooks directory: {e}"))?;
    }
    std::fs::write(path, &content).map_err(|e| format!("Failed to write copilot hooks: {e}"))?;
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hooks_json_is_valid_and_maps_events() {
        let v: serde_json::Value = serde_json::from_str(&hooks_json()).expect("should be valid JSON");
        assert_eq!(v["version"], 1);
        let hooks = v["hooks"].as_object().unwrap();
        // Every event is present.
        for ev in [
            "sessionStart",
            "userPromptSubmitted",
            "preToolUse",
            "postToolUse",
            "permissionRequest",
            "agentStop",
            "errorOccurred",
        ] {
            assert!(hooks.contains_key(ev), "{ev} should be configured");
        }
        // Correct mapping: submit/tool to working, stop/error to waiting, permission to asking, startup to boot.
        let event_of = |key: &str| {
            let bash = hooks[key][0]["bash"].as_str().unwrap();
            bash.split("&e=")
                .nth(1)
                .unwrap()
                .split('"')
                .next()
                .unwrap()
                .to_string()
        };
        assert_eq!(event_of("userPromptSubmitted"), "working");
        assert_eq!(event_of("preToolUse"), "working");
        assert_eq!(event_of("postToolUse"), "working");
        assert_eq!(event_of("agentStop"), "waiting");
        assert_eq!(event_of("errorOccurred"), "waiting");
        assert_eq!(event_of("permissionRequest"), "asking");
        assert_eq!(event_of("sessionStart"), "boot");
        // Hook commands read VLX variables, no-op when absent, and always exit zero on failure.
        let bash = hooks["agentStop"][0]["bash"].as_str().unwrap();
        assert!(bash.contains("VLX_SPAWN_URL") && bash.contains("VLX_SESSION_ID"));
        assert!(bash.starts_with("[ -n"), "the variable guard should come first");
        assert!(bash.ends_with("exit 0"), "it should fall back to exit 0");
        // Forward stdin unchanged because session-ID capture depends on it.
        assert!(bash.contains("--data-binary @-"));
    }

    #[test]
    fn install_is_idempotent_and_updates_on_change() {
        let tmp = std::env::temp_dir().join(format!("vlx-copilot-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let target = tmp.join("hooks").join(HOOKS_FILE);

        // First installation writes the file.
        let p = install_at(&target).expect("installation should succeed");
        assert_eq!(p, target);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), hooks_json());

        // Identical content does not rewrite or change mtime.
        let mtime1 = std::fs::metadata(&target).unwrap().modified().unwrap();
        install_at(&target).unwrap();
        let mtime2 = std::fs::metadata(&target).unwrap().modified().unwrap();
        assert_eq!(mtime1, mtime2, "identical contents should not be rewritten");

        // Replace outdated or accidentally modified content with the current version.
        std::fs::write(&target, "{}").unwrap();
        install_at(&target).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), hooks_json());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
