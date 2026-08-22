#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minted_token_verifies_and_wrong_token_is_rejected() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let (token, config) = mint_token_in(dir.path()).expect("mint token");

        assert!(verify_token_in(&config, &token));
        assert!(!verify_token_in(&config, "not-the-minted-token"));
    }

    #[test]
    fn config_round_trips() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let (_, written) = mint_token_in(dir.path()).expect("mint token");
        let loaded = load_config_from(dir.path()).expect("load config");

        assert_eq!(loaded.token_sha256, written.token_sha256);
        assert_eq!(loaded.port, DEFAULT_PORT);
        assert_eq!(loaded.created_at, written.created_at);
    }
}
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const DEFAULT_PORT: u16 = 8800;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PocketConfig {
    pub token_sha256: String,
    pub port: u16,
    pub created_at: u64,
}

pub fn mint_token() -> Result<String, String> {
    let (token, _) = mint_token_in(&config_dir()?)?;
    Ok(token)
}

pub fn load_config() -> Result<PocketConfig, String> {
    load_config_from(&config_dir()?)
}

pub fn is_enabled() -> bool {
    load_config().is_ok()
}

pub fn verify_token(presented: &str) -> bool {
    match load_config() {
        Ok(config) => verify_token_in(&config, presented),
        Err(_) => false,
    }
}

fn config_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".heddle").join("pocket"))
        .ok_or_else(|| "could not resolve the home directory for pocket console config".to_string())
}

fn config_path(dir: &Path) -> PathBuf {
    dir.join("config.json")
}

fn mint_token_in(dir: &Path) -> Result<(String, PocketConfig), String> {
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    set_dir_permissions(dir)?;

    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("could not generate device token: {e}"))?;
    let token = hex(&bytes);
    let config = PocketConfig {
        token_sha256: hash_token(&token),
        port: DEFAULT_PORT,
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("system clock is before Unix epoch: {e}"))?
            .as_secs(),
    };
    let path = config_path(dir);
    let json = serde_json::to_vec_pretty(&config)
        .map_err(|e| format!("could not encode pocket console config: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    set_file_permissions(&path)?;
    Ok((token, config))
}

fn load_config_from(dir: &Path) -> Result<PocketConfig, String> {
    let path = config_path(dir);
    let json = fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    serde_json::from_slice(&json).map_err(|e| format!("could not parse {}: {e}", path.display()))
}

fn verify_token_in(config: &PocketConfig, presented: &str) -> bool {
    constant_time_eq(hash_token(presented).as_bytes(), config.token_sha256.as_bytes())
}

fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex(&hasher.finalize())
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in a.iter().zip(b.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

#[cfg(unix)]
fn set_dir_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("could not set private permissions on {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn set_dir_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn set_file_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("could not set private permissions on {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn set_file_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}
