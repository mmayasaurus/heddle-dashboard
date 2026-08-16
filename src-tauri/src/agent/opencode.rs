//! Extraction and discovery of the opencode status-bridge plugin.
//!
//! vlx-term bundles an opencode plugin via compile-time `include_str!` and extracts it to `opencode/` under the
//! application data directory at startup. When launching an opencode session, it injects
//! `OPENCODE_CONFIG_CONTENT={"plugin":["<absolute plugin path>"]}` (see `agent/inject.rs` and `pty/manager.rs`),
//! causing opencode to load the plugin by its local absolute path.
//!
//! The plugin POSTs events such as `session.status`, `session.idle`, and `permission.updated` to the local hook
//! service using injected `VLX_SESSION_ID`/`VLX_TOKEN`/`VLX_SPAWN_URL`, giving opencode sessions authoritative
//! activity state. See `resources/vlx-opencode-notify.js` for the source.

use std::path::{Path, PathBuf};

/// Plugin source embedded at compile time and distributed with the binary, requiring no external file.
const PLUGIN: &str = include_str!("../../resources/vlx-opencode-notify.js");
/// Extracted filename.
const PLUGIN_NAME: &str = "vlx-opencode-notify.js";

/// Absolute extracted path: `<data_dir>/opencode/vlx-opencode-notify.js`.
pub fn plugin_path(data_dir: &Path) -> PathBuf {
    data_dir.join("opencode").join(PLUGIN_NAME)
}

/// Extract the opencode plugin to `<data_dir>/opencode/` and return its path.
///
/// Overwrite on every startup so the plugin tracks the application version.
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
        let tmp = std::env::temp_dir().join(format!("vlx-oc-plugin-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);

        let path = install(&tmp).expect("writing out the plugin should succeed");
        assert_eq!(path, plugin_path(&tmp));

        let written = std::fs::read_to_string(&path).expect("the plugin should be readable again");
        assert_eq!(written, PLUGIN, "the contents should be the inlined source");
        // Coarsely verify that the plugin exports the event hook and reports as expected, guarding against an accidentally empty source.
        assert!(written.contains("session.idle"), "the plugin should map session.idle");
        assert!(
            written.contains("VLX_SESSION_ID"),
            "the plugin should read VLX_SESSION_ID to decide whether it is enabled"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
