#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pocket_bind_address_is_loopback() {
        assert!(bind_addr(8800).ip().is_loopback());
    }
}
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;

use super::config;

/// Embedded pocket PWA output at `src-tauri/../pocket-dist`.
#[derive(rust_embed::Embed)]
#[folder = "../pocket-dist"]
struct PocketAssets;

#[derive(Clone, Copy)]
struct PocketState;

pub fn start(port: u16) -> Result<axum_server::Handle<std::net::SocketAddr>, String> {
    // Keep heddle provably off every public/LAN interface. Tailnet reachability comes only from an
    // external `tailscale serve --https=443 127.0.0.1:<port>` proxy that terminates TLS.
    let addr = bind_addr(port);
    drop(
        std::net::TcpListener::bind(addr)
            .map_err(|e| format!("pocket console port {port} is already in use: {e}"))?,
    );

    let handle = axum_server::Handle::new();
    let handle_clone = handle.clone();
    std::thread::Builder::new()
        .name("heddle-pocket".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!("pocket console: failed to start Tokio runtime: {error}");
                    return;
                }
            };
            runtime.block_on(async move {
                if let Err(error) = axum_server::bind(addr)
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
    // Static shell and health are public. `/api/me` and all future `/api/*` data routes require the
    // device token and return 401 when it is absent or wrong. Rate limiting is deliberately an S1
    // non-goal: the listener is loopback-only, exposure is tailnet-only, and tokens are high entropy.
    Router::new()
        .route("/api/health", get(health))
        .route("/api/me", get(me))
        .fallback(static_handler)
        .with_state(PocketState)
}

async fn health() -> impl IntoResponse {
    axum::Json(serde_json::json!({ "ok": true }))
}

async fn me(State(_state): State<PocketState>, headers: HeaderMap) -> impl IntoResponse {
    match token_from_headers(&headers) {
        Some(token) if config::verify_token(&token) => StatusCode::OK.into_response(),
        _ => StatusCode::UNAUTHORIZED.into_response(),
    }
}

async fn static_handler(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
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
