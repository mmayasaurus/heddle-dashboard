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
            "/api/approvals",
            "/api/meters",
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
            "/api/approvals",
            "/api/meters",
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
            if path == "/api/sessions" || path == "/api/approvals" || path == "/api/meters" {
                assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
                let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
                let body = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
                let key = match path {
                    "/api/sessions" => "sessions",
                    "/api/approvals" => "approvals",
                    "/api/meters" => "meters",
                    _ => unreachable!(),
                };
                assert!(body[key].is_array());
            }
        }
    }

    #[test]
    fn pending_spool_returns_only_objects_and_missing_spool_is_empty() {
        // Exercise the path-injectable seam directly — no `PUSH_SPOOL` env mutation, which would
        // race the other handlers' env reads in this parallel test binary. A private tempdir keeps
        // the fixture off a predictable shared /tmp path.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pending.json");
        std::fs::write(&path, r#"[{"id":"one"},{"id":"two"},null]"#).unwrap();
        let items = read_pending_spool_from(&path);
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(serde_json::Value::is_object));

        let _ = std::fs::remove_file(&path);
        assert!(read_pending_spool_from(&path).is_empty());
    }

    #[test]
    fn pending_spool_is_sorted_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pending.json");
        std::fs::write(&path, r#"[{"id":"old","ts":100},{"id":"new","ts":300},{"id":"mid","ts":200}]"#).unwrap();
        let ids: Vec<String> = read_pending_spool_from(&path)
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, ["new", "mid", "old"]);
    }

    #[test]
    fn prompt_spools_filter_stale_and_invalid_entries_across_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("first.json"),
            r#"[{"id":"fresh","ts":950},{"id":"stale","ts":899},null,{"ts":999}]"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("second.json"),
            r#"[{"id":"also-fresh","ts":1000},{"id":"no-ts"}]"#,
        )
        .unwrap();
        std::fs::write(dir.path().join("ignored.txt"), r#"[{"id":"ignored","ts":1000}]"#).unwrap();

        let mut ids: Vec<String> = read_prompt_spools_from(dir.path(), 1000, 100)
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect();
        ids.sort();
        assert_eq!(ids, ["also-fresh", "fresh"]);
    }

    #[test]
    fn merged_approvals_dedup_by_newest_timestamp_and_sort_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let pending_path = dir.path().join("pending.json");
        let prompts_dir = dir.path().join("prompts");
        std::fs::create_dir(&prompts_dir).unwrap();
        std::fs::write(
            &pending_path,
            r#"[{"id":"shared","ts":100},{"id":"pending","ts":300}]"#,
        )
        .unwrap();
        std::fs::write(
            prompts_dir.join("session.json"),
            r#"[{"id":"shared","ts":200,"category":"permission"},{"id":"prompt","ts":400}]"#,
        )
        .unwrap();

        let items = read_approvals_from(&pending_path, &prompts_dir, 250, 50);
        let ids: Vec<String> = items
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, ["prompt", "pending", "shared"]);
        assert_eq!(items[2]["category"], "permission");
    }

    fn test_token_verifier(token: &str) -> bool {
        token == "test-token"
    }
}
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
        .route("/fleet-chat", get(fleet_chat))
        .route("/approvals", get(approvals))
        .route("/meters", get(meters));
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

async fn approvals() -> axum::Json<serde_json::Value> {
    let items = tokio::task::spawn_blocking(read_approvals)
        .await
        .unwrap_or_default();
    axum::Json(serde_json::json!({ "approvals": items }))
}

async fn meters() -> axum::Json<serde_json::Value> {
    let items = tokio::task::spawn_blocking(crate::heddle_stats::mirrored_all_account_meters)
        .await
        .unwrap_or_default();
    axum::Json(serde_json::json!({ "meters": items }))
}

fn pending_spool_path() -> Option<std::path::PathBuf> {
    std::env::var_os("PUSH_SPOOL")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".heddle/push/pending.json")))
}

fn read_pending_spool() -> Vec<serde_json::Value> {
    match pending_spool_path() {
        Some(path) => read_pending_spool_from(&path),
        None => vec![],
    }
}

fn prompts_spool_dir() -> Option<PathBuf> {
    std::env::var_os("POCKET_PROMPTS_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".heddle/push/prompts")))
}

fn prompt_ttl_secs() -> u64 {
    std::env::var("POCKET_PROMPT_TTL_SECS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(21_600)
}

fn read_approvals() -> Vec<serde_json::Value> {
    let mut items = read_pending_spool();
    if let Some(dir) = prompts_spool_dir() {
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        items.extend(read_prompt_spools_from(&dir, now_secs, prompt_ttl_secs()));
    }
    merge_approvals(items)
}

#[cfg(test)]
fn read_approvals_from(
    pending_path: &Path,
    prompts_dir: &Path,
    now_secs: u64,
    ttl_secs: u64,
) -> Vec<serde_json::Value> {
    let mut items = read_pending_spool_from(pending_path);
    items.extend(read_prompt_spools_from(prompts_dir, now_secs, ttl_secs));
    merge_approvals(items)
}

fn merge_approvals(items: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let mut deduplicated = std::collections::HashMap::new();
    for item in items {
        let id = item["id"].as_str().unwrap_or_default().to_string();
        let replace = deduplicated
            .get(&id)
            .is_none_or(|existing: &serde_json::Value| timestamp(&item) > timestamp(existing));
        if replace {
            deduplicated.insert(id, item);
        }
    }
    let mut items: Vec<serde_json::Value> = deduplicated.into_values().collect();
    items.sort_by(|a, b| timestamp(b).partial_cmp(&timestamp(a)).unwrap_or(std::cmp::Ordering::Equal));
    items
}

fn read_prompt_spools_from(dir: &Path, now_secs: u64, ttl_secs: u64) -> Vec<serde_json::Value> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let oldest = now_secs.saturating_sub(ttl_secs);
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|extension| extension == "json"))
        .flat_map(|entry| {
            std::fs::read_to_string(entry.path())
                .ok()
                .and_then(|contents| serde_json::from_str::<Vec<serde_json::Value>>(&contents).ok())
                .unwrap_or_default()
        })
        .filter(|value| value.is_object() && value["id"].as_str().is_some())
        .filter(|value| value["ts"].as_f64().is_some_and(|ts| ts >= oldest as f64))
        .collect()
}

fn timestamp(value: &serde_json::Value) -> f64 {
    value["ts"].as_f64().unwrap_or(0.0)
}

/// Path-injectable core so tests exercise the parse/filter/absent behaviour without mutating the
/// process-global `PUSH_SPOOL` env — which would race the other handlers' env reads in the parallel
/// test binary. Runtime callers go through `read_pending_spool` / `pending_spool_path`.
fn read_pending_spool_from(path: &std::path::Path) -> Vec<serde_json::Value> {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return vec![];
    };
    let mut items: Vec<serde_json::Value> = serde_json::from_str::<Vec<serde_json::Value>>(&contents)
        .unwrap_or_default()
        .into_iter()
        // A well-formed envelope is an object with a string `id`; skip anything else so the PWA can
        // key on `id` and never renders id-less junk. (Missing non-id fields are tolerated here and
        // rendered defensively client-side.)
        .filter(|value| value.get("id").and_then(serde_json::Value::as_str).is_some())
        .collect();
    // Newest-first, defensively: the producer already sorts, but the host must not depend on it — a
    // hand-edited spool, or S3b merging a second producer later, could arrive unordered. A missing
    // or non-numeric `ts` sorts last.
    items.sort_by(|a, b| {
        let ts = |value: &serde_json::Value| value["ts"].as_f64().unwrap_or(0.0);
        ts(b).partial_cmp(&ts(a)).unwrap_or(std::cmp::Ordering::Equal)
    });
    items
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
    let roster = crate::heddle_stats::roster::fleet_roster(false);
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
