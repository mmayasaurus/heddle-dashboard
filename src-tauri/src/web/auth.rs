//! Web-service authentication: password login, session-token gating, per-run pairing token, and devices.
//!
//! - Passwords are held only as salted SHA-256 hashes in memory, with a new random salt per process.
//! - Successful HTTP login creates a random in-memory session token returned in JSON. Clients present it
//!   through `Authorization: Bearer` or WebSocket `?token=`. Cookies were removed because domain-wide,
//!   port-agnostic sharing caused windows to overwrite one another's credentials.
//! - Each service start creates a new shared pairing-admission token embedded in pairing links; restarting
//!   invalidates old links with the previous AuthState.
//! - Clients self-report device ID and name during handshake for an in-memory display registry. Rotation
//!   replaces the shared token and requires every device to reconnect.

use std::collections::HashSet;
use std::sync::Mutex;

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::Ctx;

/// Registered device self-reported during handshake and kept in memory for display only.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    pub device_id: String,
    pub name: String,
    pub first_seen_at: u64,
    pub last_seen_at: u64,
}

/// Current Unix time in seconds.
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub struct AuthState {
    inner: Mutex<Inner>,
}

struct Inner {
    salt: String,
    hash: String,
    /// HTTP session tokens used by plaintext and legacy authentication paths.
    tokens: HashSet<String>,
    /// Shared admission token for this run, embedded in pairing links and replaced by `rotate`.
    pairing_token: String,
    /// In-memory display registry of client-reported devices.
    devices: Vec<DeviceEntry>,
    /// Blocked device IDs. E2EE handshake rejects reconnection, and heartbeat disconnects active matches.
    /// This in-memory set is cleared with the registry on rotation or restart.
    blocked: HashSet<String>,
}

impl AuthState {
    /// Create an in-memory salted password hash, a fresh pairing token, and an empty registry. Each service
    /// start constructs a new AuthState, naturally invalidating the previous run's token.
    pub fn new(password: &str) -> Self {
        let salt = Uuid::new_v4().to_string();
        let hash = hash_pw(&salt, password);
        Self {
            inner: Mutex::new(Inner {
                salt,
                hash,
                tokens: HashSet::new(),
                pairing_token: new_token(),
                devices: Vec::new(),
                blocked: HashSet::new(),
            }),
        }
    }

    fn verify(&self, password: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        let got = hash_pw(&inner.salt, password);
        constant_time_eq(got.as_bytes(), inner.hash.as_bytes())
    }

    /// Verify the password against the hash shared by HTTP login and E2EE's second factor.
    pub fn verify_password(&self, password: &str) -> bool {
        self.verify(password)
    }

    /// Pairing token for this run, embedded in links and checked during handshake.
    pub fn pairing_token(&self) -> String {
        self.inner.lock().unwrap().pairing_token.clone()
    }

    /// Verify a pairing token against the current value in constant time.
    pub fn validate_pairing_token(&self, token: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        constant_time_eq(token.as_bytes(), inner.pairing_token.as_bytes())
    }

    /// Rotate the pairing token and clear devices, effectively replacing links for everyone. Existing
    /// connections retain negotiated keys; the new token blocks only new and reconnecting clients. Restart
    /// the service to disconnect all clients immediately.
    pub fn rotate_pairing_token(&self) -> String {
        let mut inner = self.inner.lock().unwrap();
        inner.pairing_token = new_token();
        inner.devices.clear();
        // Full reset: invalidate old links, require every device to pair again, and clear the blocklist.
        inner.blocked.clear();
        inner.pairing_token.clone()
    }

    /// Register or update a device after handshake, using placeholders for missing self-reported fields.
    pub fn register_device(&self, device_id: Option<&str>, name: Option<&str>) {
        let id = device_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("(unknown)")
            .to_string();
        let nm = name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Browser")
            .to_string();
        let now = now_secs();
        let mut inner = self.inner.lock().unwrap();
        if let Some(d) = inner.devices.iter_mut().find(|d| d.device_id == id) {
            d.last_seen_at = now;
            d.name = nm;
        } else {
            inner.devices.push(DeviceEntry {
                device_id: id,
                name: nm,
                first_seen_at: now,
                last_seen_at: now,
            });
        }
    }

    /// List devices registered during this run, distinguished by self-reported identifiers.
    pub fn list_devices(&self) -> Vec<DeviceEntry> {
        self.inner.lock().unwrap().devices.clone()
    }

    /// Block a device by ID and remove it from the display registry. [`is_blocked`] rejects its E2EE
    /// handshake even with valid credentials, while heartbeat disconnects an existing connection. Other
    /// devices are unaffected. Return whether it was registered. IDs are self-reported and spoofable.
    pub fn block_device(&self, device_id: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        inner.blocked.insert(device_id.to_string());
        let before = inner.devices.len();
        inner.devices.retain(|d| d.device_id != device_id);
        inner.devices.len() < before
    }

    /// Whether a device ID is blocked, shared by handshake rejection and heartbeat eviction.
    pub fn is_blocked(&self, device_id: &str) -> bool {
        self.inner.lock().unwrap().blocked.contains(device_id)
    }

    fn mint(&self) -> String {
        let token = Uuid::new_v4().to_string();
        self.inner.lock().unwrap().tokens.insert(token.clone());
        token
    }

    fn check(&self, token: &str) -> bool {
        self.inner.lock().unwrap().tokens.contains(token)
    }

    /// Validate a raw session token for WebSocket `?token=` authentication. Browser WebSocket APIs cannot
    /// set custom headers, so this checks the same login-issued value stored in the token set.
    pub fn token_valid(&self, token: &str) -> bool {
        self.check(token)
    }

    fn revoke(&self, token: &str) {
        self.inner.lock().unwrap().tokens.remove(token);
    }
}

/// Generate an unpredictable token by joining two simple UUID strings.
fn new_token() -> String {
    Uuid::new_v4().simple().to_string() + &Uuid::new_v4().simple().to_string()
}

fn hash_pw(salt: &str, password: &str) -> String {
    let mut h = Sha256::new();
    h.update(salt.as_bytes());
    h.update(password.as_bytes());
    hex(&h.finalize())
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Constant-time comparison for equal-length values to avoid hash timing side channels.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Extract a session token only from `Authorization: Bearer`. Cookies were removed on 2026-07-03; each
/// window holds and presents its own credential through sessionStorage or mobile memory, eliminating
/// cross-window overwrites and WKWebView cookie timing issues. Browser WebSockets use `?token=` because
/// their API cannot set custom headers.
pub(super) fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    let auth = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let t = auth.strip_prefix("Bearer ")?.trim();
    if t.is_empty() {
        return None;
    }
    Some(t.to_string())
}

/// Unified authentication gate for `/ws` and data endpoints.
pub fn is_authed(ctx: &Ctx, headers: &HeaderMap) -> bool {
    token_from_headers(headers)
        .map(|t| ctx.auth.check(&t))
        .unwrap_or(false)
}

#[derive(serde::Deserialize)]
pub struct LoginBody {
    password: String,
}

/// Verify login password, issue a token, and return it in a JSON body as `{"token":"…"}`.
///
/// The token is the sole credential. Web clients keep it in per-window sessionStorage and mobile clients
/// in memory, presenting it in WebSocket URLs or HTTP headers. No cookie is issued.
pub async fn login(State(ctx): State<Ctx>, Json(body): Json<LoginBody>) -> impl IntoResponse {
    if !ctx.auth.verify(&body.password) {
        return (StatusCode::UNAUTHORIZED, "Wrong password").into_response();
    }
    let token = ctx.auth.mint();
    Json(serde_json::json!({ "token": token })).into_response()
}

/// Check whether the current request is authenticated when the frontend enters the page.
pub async fn me(State(ctx): State<Ctx>, headers: HeaderMap) -> impl IntoResponse {
    if is_authed(&ctx, &headers) {
        StatusCode::OK
    } else {
        StatusCode::UNAUTHORIZED
    }
}

/// Log out by revoking the bearer token. Each window clears its local copy; sessionStorage also expires
/// when the window closes.
pub async fn logout(State(ctx): State<Ctx>, headers: HeaderMap) -> impl IntoResponse {
    if let Some(t) = token_from_headers(&headers) {
        ctx.auth.revoke(&t);
    }
    "ok".into_response()
}

#[cfg(test)]
mod tests {
    use super::AuthState;

    #[test]
    fn password_verify_and_token_lifecycle() {
        let auth = AuthState::new("s3cret");
        // Password verification.
        assert!(auth.verify("s3cret"));
        assert!(!auth.verify("wrong"));
        assert!(!auth.verify(""));

        // Session-token lifecycle: issue, validate, revoke, invalidate.
        let token = auth.mint();
        assert!(auth.check(&token));
        assert!(!auth.check("not-a-token"));
        auth.revoke(&token);
        assert!(!auth.check(&token));
    }

    #[test]
    fn pairing_token_rotate_and_device_registry() {
        let auth = AuthState::new("pw");
        // The run's pairing token is stable and verifiable.
        let tok = auth.pairing_token();
        assert!(auth.validate_pairing_token(&tok));
        assert!(!auth.validate_pairing_token("nope"));

        // Register two devices.
        auth.register_device(Some("dev-a"), Some("Mac"));
        auth.register_device(Some("dev-b"), Some("Phone"));
        assert_eq!(auth.list_devices().len(), 2);
        // Registering the same ID updates rather than duplicates it.
        auth.register_device(Some("dev-a"), Some("Mac mini"));
        assert_eq!(auth.list_devices().len(), 2);

        // Rotation invalidates the old token and clears the registry.
        let tok2 = auth.rotate_pairing_token();
        assert_ne!(tok, tok2);
        assert!(!auth.validate_pairing_token(&tok));
        assert!(auth.validate_pairing_token(&tok2));
        assert_eq!(auth.list_devices().len(), 0);
    }

    #[test]
    fn block_device_blocks_and_rotate_clears() {
        let auth = AuthState::new("pw");
        auth.register_device(Some("dev-a"), Some("Mac"));
        auth.register_device(Some("dev-b"), Some("Phone"));

        // Neither device is initially blocked.
        assert!(!auth.is_blocked("dev-a"));
        assert!(!auth.is_blocked("dev-b"));

        // Blocking dev-a returns true, adds it to the blocklist, removes it from display, and spares dev-b.
        assert!(auth.block_device("dev-a"));
        assert!(auth.is_blocked("dev-a"));
        assert!(!auth.is_blocked("dev-b"));
        assert_eq!(auth.list_devices().len(), 1);
        assert_eq!(auth.list_devices()[0].device_id, "dev-b");

        // Blocking an unknown ID returns false but still rejects future handshakes using it.
        assert!(!auth.block_device("dev-x"));
        assert!(auth.is_blocked("dev-x"));

        // Rotation fully resets the blocklist as well.
        auth.rotate_pairing_token();
        assert!(!auth.is_blocked("dev-a"));
        assert!(!auth.is_blocked("dev-x"));
    }
}
