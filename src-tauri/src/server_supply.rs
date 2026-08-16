//! Client-side vela-server supply for GUI builds. Download the version/platform artifact from R2,
//! verify its minisign signature and SHA-256, then cache it locally.
//!
//! Trust is rooted in the embedded minisign public key shared with automatic updates, not the manifest
//! or network. Only signed artifacts enter the cache and they may be verified again before use.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use serde::Deserialize;

/// Distribution root shared with the updater.
const DL_BASE: &str = "https://dl.velaterm.com";

/// Embedded minisign public key, which must match `plugins.updater.pubkey` in tauri.conf.json because
/// publish-server.sh signs vela-server with the updater key. Tauri wraps the two-line minisign public-key
/// file in base64. Update this constant whenever the updater key rotates.
const TAURI_PUBKEY_B64: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDg3QkY3RjE5NjU5NEIzN0YKUldSL3M1UmxHWCsvaDF4bkdReURmL2FLV2ZRbDU1V0xyRGV0dHZwQnBibWxPU3pGdXRjc2x4eCsK";

/// server-manifest.json containing one `{url, sha256, signature}` entry per platform.
#[derive(Debug, Deserialize)]
pub struct ServerManifest {
    pub version: String,
    pub platforms: HashMap<String, PlatformEntry>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct PlatformEntry {
    pub url: String,
    pub sha256: String,
    /// Base64 Tauri `.sig` content wrapping a minisign signature file.
    pub signature: String,
}

/// Map remote OS/architecture to the platform key shared with publish-server.sh and updater_target_key.
/// os ∈ {linux,macos,windows}，arch ∈ {x86_64,aarch64}。
pub fn platform_key(os: &str, arch: &str) -> String {
    let os_key = match os {
        "macos" => "darwin",
        other => other, // Linux and Windows remain unchanged.
    };
    format!("{os_key}-{arch}")
}

/// Cache path: `<app_data_dir>/server-cache/<version>/<platform>/vela-server`.
pub fn cache_path(app_data_dir: &Path, version: &str, platkey: &str) -> PathBuf {
    app_data_dir
        .join("server-cache")
        .join(version)
        .join(platkey)
        .join("vela-server")
}

/// Adjacent `vela-server.sig` path for offline re-verification.
fn cache_sig_path(bin: &Path) -> PathBuf {
    let mut p = bin.as_os_str().to_os_string();
    p.push(".sig");
    PathBuf::from(p)
}

/// Parse the embedded key as a minisign PublicKey.
fn public_key() -> Result<minisign_verify::PublicKey, String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(TAURI_PUBKEY_B64.trim())
        .map_err(|e| format!("builtin public key base64 decode failed: {e}"))?;
    let text =
        String::from_utf8(decoded).map_err(|e| format!("builtin public key is not UTF-8: {e}"))?;
    // Select the first nonempty, non-comment line containing the `RW...` key.
    let key_line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.to_ascii_lowercase().starts_with("untrusted comment"))
        .ok_or("builtin public key file has no key line")?;
    minisign_verify::PublicKey::from_base64(key_line)
        .map_err(|e| format!("failed to parse minisign public key: {e}"))
}

/// Verify data against the manifest's base64 minisign signature using the embedded key.
pub fn verify_signature(data: &[u8], sig_b64: &str) -> Result<(), String> {
    let pk = public_key()?;
    let sig_decoded = base64::engine::general_purpose::STANDARD
        .decode(sig_b64.trim())
        .map_err(|e| format!("signature base64 decode failed: {e}"))?;
    let sig_text =
        String::from_utf8(sig_decoded).map_err(|e| format!("signature is not UTF-8: {e}"))?;
    let sig = minisign_verify::Signature::decode(&sig_text)
        .map_err(|e| format!("failed to parse minisign signature: {e}"))?;
    pk.verify(data, &sig, false)
        .map_err(|e| format!("signature verification failed: {e}"))
}

/// Compute lowercase hexadecimal SHA-256 for bytes.
pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(data);
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// Fetch server-manifest.json for a version.
pub fn fetch_manifest(version: &str) -> Result<ServerManifest, String> {
    // HED-42: heddle never contacts the upstream distribution host while SSH remote is disabled.
    if !crate::ssh_remote::SSH_REMOTE_ENABLED {
        return Err(crate::ssh_remote::SSH_REMOTE_DISABLED_MSG.to_string());
    }
    let url = format!("{DL_BASE}/server/{version}/server-manifest.json");
    let body = ureq::get(&url)
        .timeout(Duration::from_secs(30))
        .call()
        .map_err(|e| format!("failed to fetch server manifest ({url}): {e}"))?
        .into_string()
        .map_err(|e| format!("failed to read server manifest: {e}"))?;
    serde_json::from_str(&body).map_err(|e| format!("failed to parse server manifest: {e}"))
}

/// Download URL bytes and report received/Content-Length percentages from 0 through 100. Without
/// Content-Length, emit no percentage so the caller retains indeterminate stage text.
fn download(url: &str, on_pct: &dyn Fn(u8)) -> Result<Vec<u8>, String> {
    let resp = ureq::get(url)
        .timeout(Duration::from_secs(180))
        .call()
        .map_err(|e| format!("download failed ({url}): {e}"))?;
    let total: Option<usize> = resp
        .header("Content-Length")
        .and_then(|v| v.trim().parse().ok())
        .filter(|n: &usize| *n > 0);
    let mut reader = resp.into_reader();
    let mut buf: Vec<u8> = Vec::with_capacity(total.unwrap_or(0));
    let mut chunk = [0u8; 64 * 1024];
    let mut last_pct: i16 = -1;
    if total.is_some() {
        on_pct(0);
        last_pct = 0;
    }
    loop {
        let n = reader
            .read(&mut chunk)
            .map_err(|e| format!("failed to read downloaded content: {e}"))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(t) = total {
            let pct = ((buf.len() as u64 * 100) / t as u64).min(100) as i16;
            if pct != last_pct {
                last_pct = pct;
                on_pct(pct as u8);
            }
        }
    }
    Ok(buf)
}

/// Ensure a valid vela-server for the version/platform exists locally and return its path. Reuse a
/// verified cache entry; otherwise fetch the manifest and artifact, verify signature and SHA-256,
/// then atomically cache the binary and signature. Cache hits do not call `on_pct`.
pub fn ensure_supplied(
    app_data_dir: &Path,
    version: &str,
    platkey: &str,
    on_pct: &dyn Fn(u8),
) -> Result<PathBuf, String> {
    // HED-42: refuse before touching the cache or the network while SSH remote is disabled.
    if !crate::ssh_remote::SSH_REMOTE_ENABLED {
        return Err(crate::ssh_remote::SSH_REMOTE_DISABLED_MSG.to_string());
    }
    let bin = cache_path(app_data_dir, version, platkey);

    // Fast path: verify the cached binary with its adjacent signature, avoiding a manifest request.
    // A valid signature already proves the binary has not changed.
    if bin.is_file() {
        if let Ok(data) = std::fs::read(&bin) {
            if let Ok(sig_b64) = std::fs::read_to_string(cache_sig_path(&bin)) {
                if verify_signature(&data, sig_b64.trim()).is_ok() {
                    return Ok(bin);
                }
            }
        }
    }

    // Slow path: fetch manifest, select platform, download, verify twice, and persist.
    let manifest = fetch_manifest(version)?;
    if manifest.version != version {
        return Err(format!(
            "manifest version mismatch: expected {version}, got {}",
            manifest.version
        ));
    }
    let entry = manifest
        .platforms
        .get(platkey)
        .ok_or_else(|| format!("server-manifest has no vela-server for platform {platkey} (not published for this platform?)"))?;

    let data = download(&entry.url, on_pct)?;
    // Verify signature for authenticity/integrity, then compare SHA-256 used by the remote path.
    verify_signature(&data, &entry.signature)?;
    let got = sha256_hex(&data);
    if !got.eq_ignore_ascii_case(&entry.sha256) {
        return Err(format!(
            "downloaded content SHA-256 does not match manifest: expected {}, got {got}",
            entry.sha256
        ));
    }

    // Write to a temporary file and rename atomically so partial data cannot appear cached.
    if let Some(dir) = bin.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("failed to create cache dir: {e}"))?;
    }
    let tmp = bin.with_extension("tmp");
    std::fs::write(&tmp, &data).map_err(|e| format!("failed to write cache temp file: {e}"))?;
    std::fs::rename(&tmp, &bin).map_err(|e| format!("failed to place cache file: {e}"))?;
    // Store the signature for offline re-verification.
    std::fs::write(cache_sig_path(&bin), entry.signature.trim())
        .map_err(|e| format!("failed to write cache signature: {e}"))?;
    // Set the Unix executable bit for a consistent local cache, even though the file is uploaded remotely.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&bin) {
            let mut perm = meta.permissions();
            perm.set_mode(0o755);
            let _ = std::fs::set_permissions(&bin, perm);
        }
    }

    Ok(bin)
}

/// Return the cached vela-server and SHA-256 for SSH upload and remote validity checks.
pub fn cached_sha256(bin: &Path) -> Result<String, String> {
    let data = std::fs::read(bin).map_err(|e| format!("failed to read cached binary: {e}"))?;
    Ok(sha256_hex(&data))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// HED-42: while SSH remote is disabled, neither entry point may reach the network or the cache —
    /// they must refuse immediately with the user-facing message (no `dl.velaterm.com` contact).
    #[test]
    fn disabled_ssh_remote_refuses_before_any_io() {
        if crate::ssh_remote::SSH_REMOTE_ENABLED {
            return; // Re-enabled build: the guard is intentionally inert.
        }
        let msg = crate::ssh_remote::SSH_REMOTE_DISABLED_MSG;
        assert_eq!(fetch_manifest("0.0.0-test").unwrap_err(), msg);
        // A non-existent app data dir proves nothing was touched: an I/O attempt would fail differently.
        let bogus = std::path::Path::new("/nonexistent/heddle-hed42-test");
        let pct_calls = std::cell::Cell::new(0u32);
        let r = ensure_supplied(bogus, "0.0.0-test", "darwin-aarch64", &|_| {
            pct_calls.set(pct_calls.get() + 1)
        });
        assert_eq!(r.unwrap_err(), msg);
        assert_eq!(
            pct_calls.get(),
            0,
            "no download progress may be reported while disabled"
        );
    }

    #[test]
    fn platform_key_maps_os() {
        assert_eq!(platform_key("linux", "x86_64"), "linux-x86_64");
        assert_eq!(platform_key("macos", "aarch64"), "darwin-aarch64");
        // Intel Mac artifact published alongside darwin-aarch64 since 2026-07-02.
        assert_eq!(platform_key("macos", "x86_64"), "darwin-x86_64");
        assert_eq!(platform_key("windows", "x86_64"), "windows-x86_64");
    }

    #[test]
    fn cache_path_shape() {
        let p = cache_path(Path::new("/data"), "0.1.73", "linux-x86_64");
        assert!(p.ends_with("server-cache/0.1.73/linux-x86_64/vela-server"));
    }

    #[test]
    fn sha256_hex_known_vector() {
        // Standard SHA-256 vector for an empty string.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn manifest_parses() {
        let json = r#"{"version":"0.1.73","pub_date":"x","platforms":{
            "linux-x86_64":{"url":"https://x/vela-server","sha256":"ab","signature":"c2ln"}}}"#;
        let m: ServerManifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.version, "0.1.73");
        let e = m.platforms.get("linux-x86_64").unwrap();
        assert_eq!(e.sha256, "ab");
    }

    #[test]
    fn builtin_public_key_parses() {
        // Ensure minisign-verify parses the embedded key, catching base64 transcription errors.
        assert!(public_key().is_ok(), "the built-in public key should parse");
    }
}
