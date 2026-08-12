//! Kimi Code CLI status bridge.
//!
//! Kimi's official hooks currently read only `~/.kimi-code/config.toml` and offer no per-launch inline
//! configuration. On the user's first Kimi session, append a clearly delimited heddle block and write a static
//! forwarding script to `~/.kimi-code/vlx-term/hook.sh`. The block stores no port, token, or session ID. The script
//! reads only `VLX_*` variables inherited by the managed process and no-ops when `kimi` runs in an ordinary terminal.

use std::path::{Path, PathBuf};

const BLOCK_BEGIN: &str = "# >>> heddle Kimi status hooks >>>";
const BLOCK_END: &str = "# <<< heddle Kimi status hooks <<<";

const HOOK_SCRIPT: &str = r#"#!/bin/sh
# heddle Kimi status bridge. Active only in Kimi sessions launched by heddle.
[ -n "$VLX_SPAWN_URL" ] && [ -n "$VLX_SESSION_ID" ] && [ -n "$VLX_TOKEN" ] || exit 0
event="$1"
curl -s -m 3 -X POST -H "Content-Type: application/json" --data-binary @- \
  "$VLX_SPAWN_URL/hook/$VLX_SESSION_ID?t=$VLX_TOKEN&e=$event" >/dev/null 2>&1
exit 0
"#;

/// Kimi hook configuration audit: record only phase, result, and duration, never configuration, paths, tokens, or session content.
pub fn audit_install(status: &str, duration_ms: u128) {
    let now = time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
    let level = if status == "failed" { "WARN" } else { "INFO" };
    eprintln!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02} [{:<5}] [system] event=kimi_hook_install step=hooks method=config_merge inputCount=1 outputCount={} status={} durationMs={}",
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

fn kimi_home() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("KIMI_CODE_HOME") {
        return Some(PathBuf::from(home));
    }
    crate::host::home_dir().map(|home| home.join(".kimi-code"))
}

fn hook_rule(script: &Path, source_event: &str, target_event: &str) -> String {
    // POSIX single quoting prevents the hook shell from reevaluating paths containing spaces, `$`, backticks, or quotes.
    let path = script.to_string_lossy().replace('\'', "'\\''");
    let command = format!("sh '{path}' {target_event}");
    let quoted = serde_json::to_string(&command).expect("hook command serialization must succeed");
    format!("[[hooks]]\nevent = \"{source_event}\"\ncommand = {quoted}\ntimeout = 5\n")
}

fn config_block(script: &Path) -> String {
    let mut out = format!("{BLOCK_BEGIN}\n");
    for (source, target) in [
        ("SessionStart", "boot"),
        ("UserPromptSubmit", "kimi_working"),
        ("PreToolUse", "kimi_working"),
        ("PostToolUse", "kimi_working"),
        ("PermissionResult", "kimi_working"),
        ("PermissionRequest", "kimi_asking"),
        ("Stop", "kimi_waiting"),
        ("StopFailure", "kimi_idle"),
        ("Interrupt", "kimi_idle"),
    ] {
        out.push_str(&hook_rule(script, source, target));
    }
    out.push_str(BLOCK_END);
    out.push('\n');
    out
}

fn merge_block(existing: &str, block: &str) -> Result<String, String> {
    match (existing.find(BLOCK_BEGIN), existing.find(BLOCK_END)) {
        (Some(start), Some(end)) if end >= start => {
            let tail = end + BLOCK_END.len();
            let mut merged = String::with_capacity(existing.len() + block.len());
            merged.push_str(&existing[..start]);
            merged.push_str(block);
            merged.push_str(existing[tail..].trim_start_matches(['\r', '\n']));
            Ok(merged)
        }
        (None, None) => {
            let mut merged = existing.trim_end().to_string();
            if !merged.is_empty() {
                merged.push_str("\n\n");
            }
            merged.push_str(block);
            Ok(merged)
        }
        _ => Err("Kimi config contains an incomplete heddle hook marker block".to_string()),
    }
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Kimi config directory: {e}"))?;
    }
    std::fs::write(path, content).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

/// Install/upgrade the script and dedicated hooks block. Validate with `toml_edit` before and after writing; never overwrite invalid configuration.
pub fn install() -> Result<PathBuf, String> {
    let home = kimi_home().ok_or("Failed to resolve Kimi Code home directory")?;
    let script = home.join("vlx-term").join("hook.sh");
    write_if_changed(&script, HOOK_SCRIPT)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&script)
            .map_err(|e| format!("Failed to inspect Kimi hook script: {e}"))?
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions)
            .map_err(|e| format!("Failed to make Kimi hook script executable: {e}"))?;
    }

    let config = home.join("config.toml");
    let existing = match std::fs::read_to_string(&config) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("Failed to read Kimi config: {e}")),
    };
    if !existing.trim().is_empty() {
        existing
            .parse::<toml_edit::DocumentMut>()
            .map_err(|e| format!("Kimi config is invalid; refusing to modify it: {e}"))?;
    }
    let merged = merge_block(&existing, &config_block(&script))?;
    merged
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("Generated Kimi config is invalid; refusing to write it: {e}"))?;
    write_if_changed(&config, &merged)?;
    Ok(config)
}
