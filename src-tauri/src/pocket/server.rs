#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Request;
    use tower::ServiceExt;

    #[test]
    fn pocket_bind_address_is_loopback() {
        assert!(bind_addr(8800).ip().is_loopback());
    }

    #[test]
    fn regression_pr_99_blank_session_ids_are_not_actionable() {
        assert!(blank_session_id(""));
        assert!(blank_session_id("  \t\n"));
        assert!(!blank_session_id("session-123"));
    }

    #[test]
    fn regression_pr_99_config_dir_parser_keeps_spaces() {
        assert_eq!(
            claude_config_dir_from_command(
                "claude CLAUDE_CONFIG_DIR=/Users/maya/Library/Application Support/Claude HOME=/Users/maya",
            ),
            Some("/Users/maya/Library/Application Support/Claude")
        );
    }

    #[tokio::test]
    async fn regression_hed_345_data_routes_require_a_device_token() {
        for path in [
            "/api/me",
            "/api/sessions",
            "/api/sessions/missing/transcript",
            "/api/sessions/missing/status",
            "/api/fleet-chat",
            "/api/unrecognized",
        ] {
            let response = router_with_verifier(test_token_verifier)
                .oneshot(Request::builder().uri(path).body(axum::body::Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
        }

        for path in [
            "/api/me",
            "/api/sessions",
            "/api/sessions/missing/transcript",
            "/api/sessions/missing/status",
            "/api/fleet-chat",
        ] {
            let response = router_with_verifier(test_token_verifier)
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header(header::AUTHORIZATION, "Bearer test-token")
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            if path == "/api/sessions" {
                assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
                let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                assert!(serde_json::from_slice::<serde_json::Value>(&body).unwrap()["sessions"].is_array());
            }
        }
    }

    fn test_token_verifier(token: &str) -> bool {
        token == "test-token"
    }
}
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

use super::config;

/// Embedded pocket PWA output at `src-tauri/../pocket-dist`.
#[derive(rust_embed::Embed)]
#[folder = "$CARGO_MANIFEST_DIR/../pocket-dist"]
struct PocketAssets;

#[derive(Clone, Copy)]
struct PocketState {
    token_verifier: fn(&str) -> bool,
}

#[derive(Deserialize)]
struct TailQuery {
    tail: Option<usize>,
}

pub fn start(port: u16) -> Result<axum_server::Handle<std::net::SocketAddr>, String> {
    // Keep heddle provably off every public/LAN interface. Tailnet reachability comes only from an
    // external `tailscale serve --https=443 127.0.0.1:<port>` proxy that terminates TLS.
    let addr = bind_addr(port);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("could not start pocket console Tokio runtime: {e}"))?;
    let listener = std::net::TcpListener::bind(addr)
        .map_err(|e| format!("pocket console port {port} is already in use: {e}"))?;
    // `axum_server::from_tcp` adopts this listener into the tokio runtime, which rejects a blocking
    // socket; std listeners are blocking by default, so make it non-blocking before handing it over.
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("could not set the pocket console listener non-blocking: {e}"))?;

    let handle = axum_server::Handle::new();
    let handle_clone = handle.clone();
    std::thread::Builder::new()
        .name("heddle-pocket".into())
        .spawn(move || {
            runtime.block_on(async move {
                // The listener is already bound and listening (TcpListener::bind above), so `start`
                // returns Ok only once the port is held. `axum_server::from_tcp` adopts that std
                // listener into the async runtime here, where the reactor is active; its rare failure
                // is logged rather than propagated so it can never crash the desktop app.
                let server = match axum_server::from_tcp(listener) {
                    Ok(server) => server,
                    Err(error) => {
                        eprintln!("pocket console: could not adopt the bound listener: {error}");
                        return;
                    }
                };
                if let Err(error) = server
                    .handle(handle_clone)
                    .serve(router().into_make_service())
                    .await
                {
                    eprintln!("pocket console exited abnormally: {error}");
                }
            });
        })
        .map_err(|e| format!("could not start pocket console thread: {e}"))?;
    Ok(handle)
}

fn bind_addr(port: u16) -> std::net::SocketAddr {
    std::net::SocketAddr::from(([127, 0, 0, 1], port))
}

fn router() -> Router {
    router_with_verifier(config::verify_token)
}

fn router_with_verifier(token_verifier: fn(&str) -> bool) -> Router {
    // Static shell and health are public. `/api/me` and all future `/api/*` data routes require the
    // device token and return 401 when it is absent or wrong. Rate limiting is deliberately an S1
    // non-goal: the listener is loopback-only, exposure is tailnet-only, and tokens are high entropy.
    let state = PocketState { token_verifier };
    let protected = Router::new()
        .route("/me", get(me))
        .route("/sessions", get(sessions))
        .route("/sessions/:id/transcript", get(session_transcript))
        .route("/sessions/:id/status", get(session_status))
        .route("/fleet-chat", get(fleet_chat));
    Router::new()
        .route("/api/health", get(health))
        .nest("/api", protected)
        .fallback(static_handler)
        .layer(middleware::from_fn_with_state(state, require_api_token))
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    axum::Json(serde_json::json!({ "ok": true }))
}

async fn require_api_token(
    State(state): State<PocketState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> impl IntoResponse {
    if request.uri().path() == "/api/health" || !request.uri().path().starts_with("/api/") {
        return next.run(request).await;
    }
    match token_from_headers(&headers) {
        Some(token) if (state.token_verifier)(&token) => next.run(request).await,
        _ => StatusCode::UNAUTHORIZED.into_response(),
    }
}

async fn me() -> StatusCode {
    StatusCode::OK
}

async fn sessions() -> axum::Json<serde_json::Value> {
    let sessions = tokio::task::spawn_blocking(|| {
        cached_roster()
            .into_iter()
            .filter(|agent| !blank_session_id(&agent.session_id))
            .map(session_card)
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    axum::Json(serde_json::json!({ "sessions": sessions }))
}

async fn session_transcript(
    AxumPath(id): AxumPath<String>,
    Query(query): Query<TailQuery>,
) -> axum::Json<serde_json::Value> {
    if blank_session_id(&id) {
        return axum::Json(serde_json::json!({ "kind": null, "messages": [], "unavailable": "Session not found" }));
    }
    let tail = bounded_tail(query.tail);
    let response = tokio::task::spawn_blocking(move || {
        let Some(agent) = cached_roster()
            .into_iter()
            .find(|agent| agent.session_id == id)
        else {
            return serde_json::json!({ "kind": null, "messages": [], "unavailable": "Session not found" });
        };
        // The roster's session_id is the agent-native session id (e.g. the Claude session UUID);
        // the tab "kind" ("interactive") is NOT the agent provider. Probe the providers that have
        // parseable transcripts by which one's transcript file exists for this id, then read it.
        use crate::models::SessionKind;
        let resolved = [SessionKind::Claude, SessionKind::Codex, SessionKind::Grok]
            .into_iter()
            .find(|kind| crate::agent::transcript::source_path(*kind, &agent.session_id).is_some());
        let Some(kind) = resolved else {
            return serde_json::json!({ "kind": agent.kind, "messages": [], "unavailable": "No agent transcript for this session" });
        };
        let kind_label = match kind {
            SessionKind::Codex => "codex",
            SessionKind::Grok => "grok",
            _ => "claude",
        };
        match crate::agent::transcript::read(kind, &agent.session_id) {
            Ok(messages) => {
                let start = messages.len().saturating_sub(tail);
                serde_json::json!({ "kind": kind_label, "messages": messages[start..] })
            }
            Err(reason) => serde_json::json!({ "kind": kind_label, "messages": [], "unavailable": reason }),
        }
    })
    .await
    .unwrap_or_else(|error| serde_json::json!({ "kind": null, "messages": [], "unavailable": error.to_string() }));
    axum::Json(response)
}

async fn session_status(AxumPath(id): AxumPath<String>) -> axum::Json<serde_json::Value> {
    if blank_session_id(&id) {
        return axum::Json(serde_json::json!({ "contextPct": null, "usage": null, "account": null, "mode": null, "repo": null, "filesEditing": null }));
    }
    let response = tokio::task::spawn_blocking(move || {
        let Some(agent) = cached_roster()
            .into_iter()
            .find(|agent| agent.session_id == id)
        else {
            return serde_json::json!({ "contextPct": null, "usage": null, "account": null, "mode": null, "repo": null, "filesEditing": null });
        };
        let account = account_for_pid(agent.pid);
        let usage = account
            .as_deref()
            .and_then(crate::heddle_stats::mirrored_claude_account_usage);
        let repo = Path::new(&agent.cwd)
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string);
        serde_json::json!({
            "contextPct": null,
            "usage": usage,
            "account": account,
            "mode": null,
            "repo": repo,
            "filesEditing": null,
        })
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({ "contextPct": null, "usage": null, "account": null, "mode": null, "repo": null, "filesEditing": null }));
    axum::Json(response)
}

async fn fleet_chat(Query(query): Query<TailQuery>) -> axum::Json<serde_json::Value> {
    let tail = bounded_tail(query.tail) as i64;
    let messages = tokio::task::spawn_blocking(move || {
        crate::comms::reader::fleet_chat_tail(tail)
            .into_iter()
            .map(|message| serde_json::json!({ "sender": message.sender, "body": message.body, "ts": message.ts }))
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    axum::Json(serde_json::json!({ "messages": messages }))
}

fn session_card(agent: crate::heddle_stats::roster::FleetAgent) -> serde_json::Value {
    let account = agent.alive.then(|| account_for_pid(agent.pid)).flatten();
    serde_json::json!({
        "name": agent.name,
        "model": agent.model,
        "pid": agent.pid,
        "sessionId": agent.session_id,
        "cwd": agent.cwd,
        "status": agent.status,
        "kind": agent.kind,
        "updatedAtMs": agent.updated_at_ms,
        "alive": agent.alive,
        "workers": agent.workers.len(),
        "account": account,
        "role": null,
    })
}

const ROSTER_CACHE_TTL: Duration = Duration::from_secs(2);
static ROSTER_CACHE: OnceLock<Mutex<Option<(Instant, Vec<crate::heddle_stats::roster::FleetAgent>)>>> = OnceLock::new();

fn cached_roster() -> Vec<crate::heddle_stats::roster::FleetAgent> {
    let cache = ROSTER_CACHE.get_or_init(|| Mutex::new(None));
    let mut cached = cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((computed_at, roster)) = cached.as_ref() {
        if computed_at.elapsed() < ROSTER_CACHE_TTL {
            return roster.clone();
        }
    }
    let roster = crate::heddle_stats::roster::fleet_roster();
    *cached = Some((Instant::now(), roster.clone()));
    roster
}

fn blank_session_id(id: &str) -> bool {
    id.trim().is_empty()
}

fn bounded_tail(tail: Option<usize>) -> usize {
    tail.unwrap_or(200).clamp(1, 1_000)
}

#[cfg(unix)]
fn account_for_pid(pid: i64) -> Option<String> {
    if pid <= 0 {
        return None;
    }
    let output = Command::new("ps")
        .args(["eww", "-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let command = String::from_utf8(output.stdout).ok()?;
    let config_dir = claude_config_dir_from_command(&command)?;
    crate::heddle_stats::claude::account_id_for_config_dir(Path::new(config_dir))
}

#[cfg(unix)]
fn claude_config_dir_from_command(command: &str) -> Option<&str> {
    let value = command.split_once("CLAUDE_CONFIG_DIR=")?.1;
    // `ps eww` flattens the environment onto one line, so split at the next ` KEY=` boundary
    // rather than whitespace: config directories commonly include spaces.
    let end = value
        .char_indices()
        .find_map(|(index, character)| {
            (character == ' ' && value[index + 1..]
                .split_once('=')
                .is_some_and(|(key, _)| {
                    key.starts_with(|character: char| character.is_ascii_alphabetic() || character == '_')
                        && key.chars().all(|character| character.is_ascii_alphanumeric() || character == '_')
                }))
            .then_some(index)
        })
        .unwrap_or(value.len());
    (!value[..end].is_empty()).then_some(&value[..end])
}

#[cfg(not(unix))]
fn account_for_pid(_pid: i64) -> Option<String> {
    None
}

async fn static_handler(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    if path.contains("..") || path.starts_with('/') || path.contains('\\') {
        return (StatusCode::BAD_REQUEST, "Invalid path").into_response();
    }
    if let Some(content) = PocketAssets::get(path) {
        return ([(header::CONTENT_TYPE, mime_for(path))], content.data.into_owned()).into_response();
    }
    match PocketAssets::get("index.html") {
        Some(content) => (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            content.data.into_owned(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "Pocket assets not found (pocket-dist not built?)").into_response(),
    }
}

fn token_from_headers(headers: &HeaderMap) -> Option<String> {
    let authorization = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = authorization.strip_prefix("Bearer ")?.trim();
    (!token.is_empty()).then(|| token.to_string())
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}
