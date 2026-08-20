//! Browser remote-access service hosting frontend assets and bridging commands, events, and PTY streams over WebSocket.
//!
//! Runs axum on a Tokio runtime in a dedicated thread, isolated from Tauri's main event loop. A shared `AppCtx`
//! resolves PtyManager, Db, and HookServer and exchanges events, so browser and desktop/headless clients naturally
//! use the same PTY manager and SQLite database (see `host.rs`).
//!
//! - LAN mode binds `0.0.0.0` and authenticates through the password login flow (see `auth`).
//! - `rust-embed` bundles `../dist` for offline release use.
//! - `/ws` multiplexes invokes, events, and PTY traffic (see `ws`).

mod auth;
// desktop_call also uses dispatch, so expose it within the crate rather than keeping it private to web transport.
pub(crate) mod dispatch;
mod e2ee;
mod sniff;
mod tls;
pub mod tunnel;
mod ws;

use std::sync::Mutex;

use axum::extract::State;
use axum::http::{header, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;

use crate::host::AppCtx;

use auth::AuthState;
use base64::Engine;
use std::sync::Arc;

/// Default listening port, overridable by `web_server_start`.
const DEFAULT_PORT: u16 = 8799;

/// Frontend build output at `src-tauri/../dist`, read from disk in debug and embedded in release.
#[derive(rust_embed::Embed)]
#[folder = "../dist"]
struct Assets;

/// Context shared by axum handlers.
#[derive(Clone)]
pub(crate) struct Ctx {
    pub app: AppCtx,
    pub auth: Arc<AuthState>,
    /// Long-lived server E2EE key used for handshake ECDH; its public key is embedded in pairing URLs.
    pub e2ee_keys: Arc<e2ee::ServerKeys>,
    /// Serve mode used by WS to require paired encryption and reject plaintext in network-exposed LanTls mode.
    pub mode: ServeMode,
}

/// Public web-service status returned to the frontend in camelCase.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebServerStatus {
    pub running: bool,
    pub port: Option<u16>,
    /// Primary candidate URL, the first in `urls`, preferring a normal LAN interface.
    pub url: Option<String>,
    /// All candidate URLs across Wi-Fi, Ethernet, and VPN interfaces, with point-to-point tunnels ranked last.
    pub urls: Vec<String>,
    /// Colon-separated uppercase SHA-256 fingerprint of the self-signed certificate for host verification; None when stopped.
    pub fingerprint: Option<String>,
}

impl WebServerStatus {
    fn stopped() -> Self {
        Self {
            running: false,
            port: None,
            url: None,
            urls: Vec::new(),
            fingerprint: None,
        }
    }
}

/// Web serving modes separating bind scope from encryption, unlike the former `local_http` boolean. This enables
/// the plaintext-LAN combination required by native mobile shells.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ServeMode {
    /// LAN with self-signed TLS on `0.0.0.0`, including HTTP-to-HTTPS sniffing redirect; desktop remote default.
    LanTls,
    /// Plain HTTP/ws on `127.0.0.1` for Electron sidecar; loopback never leaves the host.
    LoopbackHttp,
    /// Plain HTTP/ws on LAN for native mobile shells whose RN WebView cannot bypass self-signed certificates,
    /// especially Android. This sacrifices LAN encryption (architecture section 20).
    LanHttp,
}

impl ServeMode {
    /// Whether transport is plaintext; only `LanTls` uses TLS.
    fn plaintext(self) -> bool {
        !matches!(self, ServeMode::LanTls)
    }
    /// Bind address octets: LoopbackHttp uses 127.0.0.1; both LAN modes use 0.0.0.0.
    fn bind_octets(self) -> [u8; 4] {
        match self {
            ServeMode::LoopbackHttp => [127, 0, 0, 1],
            _ => [0, 0, 0, 0],
        }
    }
    /// Bind-host string used for port preflight.
    fn bind_host(self) -> &'static str {
        match self {
            ServeMode::LoopbackHttp => "127.0.0.1",
            _ => "0.0.0.0",
        }
    }
}

/// Whether an app identifier names a production identity by convention: `.release` for a packaged
/// desktop build or `.server` for the deployed headless SSH service. This is only ONE of the production
/// signals — see [`is_production`], which also treats any release compile as production.
///
/// Caveat specific to heddle: the packaged desktop build keeps the default identifier (`com.heddle.app`)
/// rather than the upstream VelaTerm `.release` scheme, so this suffix check does NOT fire for it — the
/// release-compile signal in [`is_production`] is what guards the packaged app. The suffix check still
/// independently guards the minimal server, whose identity is always `io.vlinx.vlxterm.server`, even
/// when built as a debug compile.
pub fn is_production_identifier(identifier: &str) -> bool {
    identifier.ends_with(".release") || identifier.ends_with(".server")
}

/// Whether the running build must apply production hardening — notably, refuse plaintext `LanHttp` on
/// 0.0.0.0. True when EITHER the binary is a release compile (`is_release_build`, wired at each call site
/// as `!cfg!(debug_assertions)`) OR the identifier is a production identity ([`is_production_identifier`]).
///
/// The release-compile signal is primary: it fires for the packaged desktop app and the deployed server
/// regardless of identifier string, and it fails safe — any release build hardens. The identifier signal
/// additionally hardens the minimal server and any future `.release`/`.server` identity even under a debug
/// compile. Plaintext `LanHttp` exists only for development mobile-device testing over LAN; production
/// devices use HTTPS with certificate pinning (architecture §20). Loopback `--local-http` never leaves the
/// host and is always permitted.
///
/// The build signal is injected rather than read inline so the decision stays fully unit-testable under a
/// debug-compiled `cargo test`.
pub fn is_production(identifier: &str, is_release_build: bool) -> bool {
    is_release_build || is_production_identifier(identifier)
}

/// Handle for a running service.
struct Running {
    port: u16,
    lan_ips: Vec<String>,
    fingerprint: Option<String>,
    /// Startup mode, determining status URL scheme and host.
    mode: ServeMode,
    /// Authentication state and device registry used for pairing links, device listing, and revocation.
    auth: Arc<AuthState>,
    /// Server E2EE key whose public half is embedded in pairing links.
    e2ee_keys: Arc<e2ee::ServerKeys>,
    handle: axum_server::Handle<std::net::SocketAddr>,
    thread: std::thread::JoinHandle<()>,
}

/// Pairing result returned to the frontend and encoded as a QR code, serialized in camelCase.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    /// Browser URL: `scheme://host:port/#pair=<base64url pairing data>`.
    pub url: String,
    /// Issued device token, also embedded in the URL and exposed separately for display/copy.
    pub device_token: String,
}

/// Public device-entry alias used by commands.rs return types.
pub use auth::DeviceEntry;

/// Tauri-managed web-service state holding the running handle behind a Mutex for start/stop transitions.
pub struct WebServer {
    inner: Mutex<Option<Running>>,
}

impl WebServer {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// Starts the service, first stopping any running instance so password, port, and mode changes apply.
    ///
    /// Modes (see [`ServeMode`]): LanTls is self-signed TLS on 0.0.0.0 with sniff redirect; LoopbackHttp is
    /// plaintext 127.0.0.1 for Electron without per-message TLS overhead; LanHttp is plaintext 0.0.0.0 for native
    /// mobile shells that cannot bypass self-signed certificates.
    ///
    /// All modes retain authentication because other local/LAN clients can reach even plaintext ports.
    pub fn start(
        &self,
        app: AppCtx,
        password: &str,
        port: Option<u16>,
        mode: ServeMode,
    ) -> Result<WebServerStatus, String> {
        if password.trim().is_empty() {
            return Err("Please set an access password first".into());
        }
        let mut guard = self.inner.lock().unwrap();
        if let Some(running) = guard.take() {
            running.handle.shutdown();
            let _ = running.thread.join();
        }

        let port = port.unwrap_or(DEFAULT_PORT);
        let bind_host = mode.bind_host();
        // Synchronously preflight port availability, release it immediately, then let axum-server bind.
        drop(
            std::net::TcpListener::bind((bind_host, port))
                .map_err(|e| format!("Port {port} is already in use: {e}"))?,
        );

        let lan_ips = lan_ips();
        // Persist the E2EE server key, device registry, and self-signed TLS certificate in the data directory.
        let data_dir = app.data_dir()?;
        let e2ee_keys = Arc::new(e2ee::ServerKeys::load_or_create(&data_dir)?);
        // Plaintext needs no certificate; TLS creates one and calculates its frontend fingerprint before moving into the thread.
        let tls_pem: Option<(Vec<u8>, Vec<u8>)>;
        let fingerprint: Option<String>;
        if mode.plaintext() {
            tls_pem = None;
            fingerprint = None;
        } else {
            let (cert_pem, key_pem) = tls::ensure_cert(&data_dir, &lan_ips)?;
            fingerprint = tls::fingerprint_sha256(&cert_pem);
            tls_pem = Some((cert_pem, key_pem));
        }

        // Remove the obsolete per-device-token registry, replaced by one rotation token and an in-memory registry.
        let _ = std::fs::remove_file(data_dir.join("vlx-devices.json"));
        let auth = Arc::new(AuthState::new(password));
        let ctx = Ctx {
            app,
            auth: auth.clone(),
            e2ee_keys: e2ee_keys.clone(),
            mode,
        };
        let handle = axum_server::Handle::new();
        let handle_clone = handle.clone();
        let bind_octets = mode.bind_octets();
        let addr = std::net::SocketAddr::from((bind_octets, port));

        let thread = std::thread::Builder::new()
            .name("vlx-web".into())
            .spawn(move || {
                let rt = match tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(e) => {
                        eprintln!("failed to start Web service tokio runtime: {e}");
                        return;
                    }
                };
                rt.block_on(async move {
                    let router = build_router(ctx);
                    match tls_pem {
                        Some((cert_pem, key_pem)) => {
                            // rustls 0.23 requires an explicit global CryptoProvider when both aws-lc-rs and ring
                            // are present. Match tunnel.rs with aws-lc-rs; installation is process-idempotent.
                            let _ = tokio_rustls::rustls::crypto::aws_lc_rs::default_provider()
                                .install_default();
                            let config = match axum_server::tls_rustls::RustlsConfig::from_pem(
                                cert_pem, key_pem,
                            )
                            .await
                            {
                                Ok(c) => c,
                                Err(e) => {
                                    eprintln!("TLS configuration failed: {e}");
                                    return;
                                }
                            };
                            // The TLS acceptor sniffs plaintext HTTP and redirects to HTTPS, avoiding errors when users omit the scheme.
                            let acceptor = axum_server::tls_rustls::RustlsAcceptor::new(config)
                                .acceptor(sniff::HttpSniff);
                            if let Err(e) = axum_server::bind(addr)
                                .acceptor(acceptor)
                                .handle(handle_clone)
                                .serve(router.into_make_service())
                                .await
                            {
                                eprintln!("Web service exited abnormally: {e}");
                            }
                        }
                        None => {
                            // Local unencrypted path: plain loopback HTTP without TLS acceptor or sniff redirect.
                            if let Err(e) = axum_server::bind(addr)
                                .handle(handle_clone)
                                .serve(router.into_make_service())
                                .await
                            {
                                eprintln!("Web service exited abnormally: {e}");
                            }
                        }
                    }
                });
            })
            .map_err(|e| format!("Failed to start web server thread: {e}"))?;

        *guard = Some(Running {
            port,
            lan_ips: lan_ips.clone(),
            fingerprint: fingerprint.clone(),
            mode,
            auth,
            e2ee_keys,
            handle,
            thread,
        });

        Ok(status_from(port, lan_ips, fingerprint, mode))
    }

    /// Stops the service.
    pub fn stop(&self) {
        if let Some(running) = self.inner.lock().unwrap().take() {
            running.handle.shutdown();
            let _ = running.thread.join();
        }
    }

    /// Returns current status.
    pub fn status(&self) -> WebServerStatus {
        match &*self.inner.lock().unwrap() {
            Some(r) => status_from(r.port, r.lan_ips.clone(), r.fingerprint.clone(), r.mode),
            None => WebServerStatus::stopped(),
        }
    }

    /// Generates a browser pairing URL containing the current shared token and server public key. `address` chooses
    /// an interface IP; `rotate=true` replaces the token, invalidates old links, and clears all registrations.
    pub fn create_pairing(
        &self,
        address: Option<String>,
        rotate: bool,
    ) -> Result<PairingInfo, String> {
        let guard = self.inner.lock().unwrap();
        let running = guard.as_ref().ok_or("Web server not started")?;
        // Rotate the shared token and clear registrations when requested; otherwise reuse the current token.
        let token = if rotate {
            running.auth.rotate_pairing_token()
        } else {
            running.auth.pairing_token()
        };
        let scheme = if running.mode == ServeMode::LanTls {
            "https"
        } else {
            "http"
        };
        let host = address
            .filter(|s| !s.trim().is_empty())
            .or_else(|| running.lan_ips.first().cloned())
            .unwrap_or_else(|| "localhost".to_string());
        // Put token and server public key in the URL fragment so they never reach the server, proxy logs, or Referer.
        let offer = serde_json::json!({
            "t": token,
            "k": running.e2ee_keys.public_key_b64(),
        });
        let code = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(offer.to_string());
        let url = format!("{scheme}://{host}:{}/#pair={code}", running.port);
        Ok(PairingInfo {
            url,
            device_token: token,
        })
    }

    /// Lists paired devices that actually connected; returns empty while stopped.
    pub fn list_devices(&self) -> Vec<DeviceEntry> {
        match &*self.inner.lock().unwrap() {
            Some(r) => r.auth.list_devices(),
            None => Vec::new(),
        }
    }

    /// Revokes a device by blacklisting and deregistering it. E2EE rejects reconnects and an active connection is
    /// dropped within one heartbeat; other devices are unaffected. Returns false while stopped.
    pub fn revoke_device(&self, device_id: &str) -> bool {
        match &*self.inner.lock().unwrap() {
            Some(r) => r.auth.block_device(device_id),
            None => false,
        }
    }
}

impl Default for WebServer {
    fn default() -> Self {
        Self::new()
    }
}

fn status_from(
    port: u16,
    lan_ips: Vec<String>,
    fingerprint: Option<String>,
    mode: ServeMode,
) -> WebServerStatus {
    let urls: Vec<String> = match mode {
        // Loopback plaintext exposes only 127.0.0.1 for Electron sidecar.
        ServeMode::LoopbackHttp => vec![format!("http://127.0.0.1:{port}")],
        // LAN modes enumerate LAN addresses and choose HTTP for mobile or HTTPS for browser remote access.
        ServeMode::LanHttp | ServeMode::LanTls => {
            let scheme = if matches!(mode, ServeMode::LanTls) {
                "https"
            } else {
                "http"
            };
            // Fall back to localhost when no LAN IP is found, preserving local access.
            let hosts = if lan_ips.is_empty() {
                vec!["localhost".to_string()]
            } else {
                lan_ips
            };
            hosts
                .iter()
                .map(|h| format!("{scheme}://{h}:{port}"))
                .collect()
        }
    };
    WebServerStatus {
        running: true,
        port: Some(port),
        url: urls.first().cloned(),
        urls,
        fingerprint,
    }
}

/// Builds public login/static routes and protected `/api/*` plus `/ws` routes.
fn build_router(ctx: Ctx) -> Router {
    Router::new()
        .route("/api/login", post(auth::login))
        .route("/api/me", get(auth::me))
        .route("/api/mode", get(mode_info))
        .route("/api/logout", post(auth::logout))
        // Image upload now invokes save_pasted_image over authenticated WS with paired E2EE. The cookie-only
        // POST /api/upload path was removed because paired sessions had no cookie and received 401.
        .route("/ws", get(ws::ws_handler))
        .fallback(static_handler)
        .with_state(ctx)
}

/// Tells the frontend whether pairing is mandatory (LanTls only). Without pairing data, mandatory mode asks for a
/// pairing link instead of showing password login; plaintext loopback/LAN modes retain password login.
async fn mode_info(State(ctx): State<Ctx>) -> impl IntoResponse {
    axum::Json(serde_json::json!({
        "requirePairing": ctx.mode == ServeMode::LanTls,
    }))
}

/// Serves embedded SPA assets, falling back to index.html for frontend routing. Assets contain no secrets and are
/// public; actual data and terminal access remain protected through `/ws`.
async fn static_handler(State(_ctx): State<Ctx>, uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(content) = Assets::get(path) {
        let mime = mime_for(path);
        return ([(header::CONTENT_TYPE, mime)], content.data.into_owned()).into_response();
    }
    // SPA fallback sends unknown paths to frontend routing.
    match Assets::get("index.html") {
        Some(content) => (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            content.data.into_owned(),
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            "Frontend assets not found (dist not built?)",
        )
            .into_response(),
    }
}

/// Minimal extension-to-MIME mapping that avoids another dependency.
fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Enumerates LAN IPv4 candidates that other devices can actually reach, for UI listing, pairing URLs, and TLS SANs.
/// Filtering is deliberately strict because the first result becomes the pairing-link host.
///
/// Rules:
/// 1. Keep only non-loopback private IPv4 ranges.
/// 2. Exclude network and broadcast addresses; macOS internal interfaces often report unreachable `.0` noise.
/// 3. Exclude system-internal, VM, container, and bridge interfaces by name.
/// 4. Rank broadcast-capable Wi-Fi/Ethernet first and point-to-point VPN/tunnel interfaces last. Tunnels remain as
///    fallbacks because they can be the only reachable address for VPN users, but must not become the default.
fn lan_ips() -> Vec<String> {
    let mut normal: Vec<String> = Vec::new();
    let mut ptp: Vec<String> = Vec::new();
    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() || is_virtual_iface(&iface.name) {
                continue;
            }
            if let if_addrs::IfAddr::V4(v4) = iface.addr {
                if !v4.ip.is_private() || is_network_or_broadcast(v4.ip, v4.netmask) {
                    continue;
                }
                let ip = v4.ip.to_string();
                // A broadcast address indicates normal LAN; its absence usually indicates a point-to-point VPN.
                if v4.broadcast.is_some() {
                    normal.push(ip);
                } else {
                    ptp.push(ip);
                }
            }
        }
    }
    normal.extend(ptp);
    normal
}

/// Whether an interface is system-internal, virtual-machine, container, or bridge traffic unreachable from LAN peers.
///
/// VPN tunnels (`utun`/`ppp`) are retained but ranked last by [`lan_ips`] because VPN access may depend on them.
/// Bridges are excluded because they are usually VM NAT gateways or macOS Internet Sharing interfaces unreachable
/// from the real LAN. This intentionally omits the rare direct-phone Internet Sharing case.
fn is_virtual_iface(name: &str) -> bool {
    // Prefixes covering common virtual interfaces across all three platforms:
    const VIRTUAL_PREFIXES: &[&str] = &[
        // macOS AirDrop, low-latency WLAN, Apple private, and software AP.
        "awdl", "llw", "anpi", "ap", // VMware, VirtualBox, and Parallels.
        "vmnet", "vboxnet", "vnic", // Containers and Linux virtual bridges.
        "docker", "veth", "virbr",
        // Bridges/Internet Sharing, usually host-side .1 NAT gateways unreachable externally.
        "bridge", // Overlay networks such as ZeroTier.
        "zt",
    ];
    let name = name.to_ascii_lowercase();
    VIRTUAL_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// Whether an IPv4 is its subnet's network or broadcast address, neither of which is a connectable host.
///
/// For /24, `.0` is network and `.255` broadcast. /31 and /32 point-to-point masks have no conventional host
/// distinction and are allowed directly.
fn is_network_or_broadcast(ip: std::net::Ipv4Addr, netmask: std::net::Ipv4Addr) -> bool {
    let ip = u32::from(ip);
    let host_mask = !u32::from(netmask); // Host bits are 1; network bits are 0.
    if host_mask <= 1 {
        // Allow /32 and /31, which have no conventional network/broadcast distinction.
        return false;
    }
    let host_part = ip & host_mask;
    host_part == 0 || host_part == host_mask
}

#[cfg(test)]
mod tests {
    use super::{is_network_or_broadcast, is_production, is_production_identifier, is_virtual_iface};
    use std::net::Ipv4Addr;

    #[test]
    fn release_identifier_is_production() {
        // Release-script identifiers end in .release and forbid plaintext LAN mode.
        assert!(is_production_identifier("io.vlinx.vlxterm.release"));
    }

    #[test]
    fn dev_identifier_is_not_production() {
        // Default development/test identifier permits plaintext LAN for mobile-device testing.
        assert!(!is_production_identifier("io.vlinx.vlxterm"));
    }

    #[test]
    fn server_identifier_is_production() {
        // Headless SSH server identifiers end in .server and also forbid plaintext LAN defensively.
        assert!(is_production_identifier("io.vlinx.vlxterm.server"));
    }

    #[test]
    fn release_compile_is_production_regardless_of_identifier() {
        // HED-39 regression: heddle's packaged desktop build keeps the default `com.heddle.app`
        // identifier, which is not a `.release`/`.server` identity. The release-compile signal must
        // still mark it production so the plaintext-LAN guard fires. Mutation check: dropping
        // `is_release_build ||` from `is_production` reds this.
        assert!(is_production("com.heddle.app", true));
    }

    #[test]
    fn debug_compile_with_default_identifier_is_not_production() {
        // Development build (debug compile + default identifier) permits plaintext LAN for
        // mobile-device testing over the LAN.
        assert!(!is_production("com.heddle.app", false));
    }

    #[test]
    fn server_identifier_is_production_even_in_debug_compile() {
        // The minimal server's identity forbids plaintext LAN defensively via the identifier signal,
        // independent of the release-compile signal.
        assert!(is_production("io.vlinx.vlxterm.server", false));
    }

    #[test]
    fn release_identifier_is_production_even_in_debug_compile() {
        // A `.release` identity likewise hardens independent of the compile profile.
        assert!(is_production("io.vlinx.vlxterm.release", false));
    }

    #[test]
    fn network_and_broadcast_addresses_are_filtered() {
        let mask24 = Ipv4Addr::new(255, 255, 255, 0);
        // Filter network addresses whose host bits are all zero.
        assert!(is_network_or_broadcast(
            Ipv4Addr::new(192, 168, 97, 0),
            mask24
        ));
        // Filter broadcast addresses whose host bits are all one.
        assert!(is_network_or_broadcast(
            Ipv4Addr::new(192, 168, 97, 255),
            mask24
        ));
        // Keep normal host addresses.
        assert!(!is_network_or_broadcast(
            Ipv4Addr::new(192, 168, 88, 205),
            mask24
        ));
        // Keep a VM gateway .1 here; interface-name filtering handles it separately.
        assert!(!is_network_or_broadcast(
            Ipv4Addr::new(172, 16, 68, 1),
            mask24
        ));
        // Allow /32 point-to-point addresses common to VPNs.
        assert!(!is_network_or_broadcast(
            Ipv4Addr::new(10, 10, 10, 134),
            Ipv4Addr::new(255, 255, 255, 255)
        ));
        // Under /16, 192.168.0.0 is network while 192.168.97.0 is a valid host.
        let mask16 = Ipv4Addr::new(255, 255, 0, 0);
        assert!(is_network_or_broadcast(
            Ipv4Addr::new(192, 168, 0, 0),
            mask16
        ));
        assert!(!is_network_or_broadcast(
            Ipv4Addr::new(192, 168, 97, 0),
            mask16
        ));
    }

    #[test]
    fn virtual_interfaces_are_flagged() {
        // Exclude system, VM, container, and bridge interfaces, including host-side .1 NAT/Internet Sharing gateways.
        for n in [
            "awdl0",
            "llw0",
            "anpi0",
            "anpi3",
            "ap1",
            "vmnet1",
            "vmnet8",
            "vboxnet0",
            "vnic0",
            "docker0",
            "veth1a2b3c",
            "virbr0",
            "zt5u4i",
            "bridge0",
            "bridge100",
        ] {
            assert!(is_virtual_iface(n), "{n} should be treated as a virtual interface");
        }
        // Keep real LAN and VPN tunnel interfaces; lan_ips merely ranks VPNs lower.
        for n in ["en0", "en1", "eth0", "wlan0", "utun0", "ppp0"] {
            assert!(!is_virtual_iface(n), "{n} should not be treated as a virtual interface");
        }
    }
}
