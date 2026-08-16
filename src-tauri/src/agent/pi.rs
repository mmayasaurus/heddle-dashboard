//! Extraction and discovery of the Pi status-bridge extension.
//!
//! vlx-term bundles a Pi extension via compile-time `include_str!`. When launching a Pi session, it extracts the
//! extension to `pi/` under the application data directory and loads it once with command-line
//! `-e <absolute extension path>` (see the Pi branch in `agent/inject.rs` and `pty/manager.rs`). Pi's built-in jiti
//! transpiles `.ts` on demand, so no build step is required.
//!
//! The extension POSTs Pi lifecycle events (`input`, `agent_start`, `agent_end`, and `session_start`) to the local
//! hook service using injected `VLX_SESSION_ID`/`VLX_TOKEN`/`VLX_SPAWN_URL`, giving Pi sessions authoritative
//! activity state. See `resources/vlx-pi-notify.ts` for the source.
//!
//! Use command-line `-e` instead of writing the user's global extension directory (`~/.pi/agent/extensions/`).
//! `-e` is the official per-launch mechanism, scoped cleanly to one process with no uninstall logic and no effect
//! on Pi instances the user launches independently.

use std::path::{Path, PathBuf};

/// Extension source embedded at compile time and distributed with the binary, requiring no external file.
const PLUGIN: &str = include_str!("../../resources/vlx-pi-notify.ts");
/// Extracted filename.
const PLUGIN_NAME: &str = "vlx-pi-notify.ts";

/// Absolute extracted extension path: `<data_dir>/pi/vlx-pi-notify.ts`.
pub fn plugin_path(data_dir: &Path) -> PathBuf {
    data_dir.join("pi").join(PLUGIN_NAME)
}

/// Extract the Pi extension to `<data_dir>/pi/` and return its path.
///
/// Overwrite on every startup so the extension tracks the application version.
pub fn install(data_dir: &Path) -> std::io::Result<PathBuf> {
    let path = plugin_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, PLUGIN)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_writes_plugin_at_expected_path() {
        let tmp = std::env::temp_dir().join(format!("vlx-pi-plugin-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);

        let path = install(&tmp).expect("writing out the extension should succeed");
        assert_eq!(path, plugin_path(&tmp));

        let written =
            std::fs::read_to_string(&path).expect("the extension should be readable again");
        assert_eq!(written, PLUGIN, "the contents should be the inlined source");
        // Coarsely verify that the extension exports lifecycle hooks and reports as expected, guarding against an accidentally empty source.
        assert!(
            written.contains("agent_end"),
            "the extension should map agent_end"
        );
        assert!(
            written.contains("VLX_SESSION_ID"),
            "the extension should read VLX_SESSION_ID to decide whether it is enabled"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
