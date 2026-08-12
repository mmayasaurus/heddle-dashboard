//! Built-in browser tabs.
//!
//! React renders the toolbar, while `Window::add_child` mounts a native child WebView in the main window.
//! Frontend placeholder bounds position it, tab switching shows/hides it, and tab closure destroys it.
//!
//! Security model—do not weaken:
//! - `browser-*` child labels are outside the `windows:["main"]` capability, so external pages cannot call
//!   Tauri commands.
//! - Injection only rewrites `window.open`; never expose tokens or internal objects to third-party pages.
//! - Allow only HTTP, HTTPS, and about:blank through both normalization and `on_navigation`.
//! - Commands accept tabId only; BrowserManager owns labels and never trusts frontend labels.
//!
//! Coordinate conversion, verified on macOS and Linux: macOS add_child uses the frame origin above the
//! native title bar, while CSS begins in the content area and tao reports frame size for both outer/inner.
//! Derive title-bar height as logical window height minus reported CSS viewport height. Fullscreen naturally
//! yields zero. Linux/Windows already use the client-area origin and must return zero; applying the macOS
//! formula there would mistake WebKit/tao scale-factor differences for an offset. See `y_offset()`.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State};

/// Full Safari UA. WKWebView's default omits the Version/Safari suffix Google uses to detect and reject
/// embedded WebViews; this UA has been verified with Google login.
const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

/// Shared browser-only persistent data-store identifier. It isolates browser data from main UI settings,
/// shares site login state across tabs, and lets the system persist cookies/localStorage/IndexedDB without
/// application access to plaintext credentials. Requires macOS 14+.
const VLX_BROWSER_STORE: [u8; 16] = *b"vlx-browser-v1\0\0";

/// Rewrite `window.open` and `target=_blank` to navigate the current tab; inject no heddle objects.
const POPUP_REWRITE_JS: &str = r#"(function () {
  window.open = function (u) { if (u) location.href = u; return null; };
  document.addEventListener("click", function (e) {
    const a = e.target && e.target.closest && e.target.closest("a[target=_blank]");
    if (a && a.href) { e.preventDefault(); location.href = a.href; }
  }, true);
})();"#;

/// Managed tabId-to-child-label state. Commands resolve through tabId and quietly return when a tab has
/// already closed, preserving idempotence.
pub struct BrowserManager(Mutex<HashMap<String, String>>);

impl BrowserManager {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    fn label_of(&self, tab_id: &str) -> Option<String> {
        self.0.lock().ok()?.get(tab_id).cloned()
    }
}

/// `browser://state/{tabId}` payload. V1 uses URL host as title until native page-title support.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserState {
    url: String,
    title: String,
    loading: bool,
}

/// Emit only to main because this desktop-only feature must not broadcast remotely.
fn emit_state(app: &AppHandle, tab_id: &str, url: &url::Url, loading: bool) {
    let title = url
        .host_str()
        .map(str::to_string)
        .unwrap_or_else(|| url.to_string());
    let _ = app.emit_to(
        "main",
        &format!("browser://state/{tab_id}"),
        BrowserState {
            url: url.to_string(),
            title,
            loading,
        },
    );
}

/// Allow HTTP, HTTPS, and about only; reject file and other schemes to avoid exposing local files.
fn scheme_allowed(url: &url::Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "about")
}

/// Normalize address input: validate explicit schemes, prepend HTTPS to domain-like or localhost values
/// without whitespace, and otherwise build a Google search URL.
fn normalize_url(input: &str) -> Result<url::Url, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Empty address".into());
    }
    if input.eq_ignore_ascii_case("about:blank") {
        return Ok(url::Url::parse("about:blank").expect("constant URL"));
    }
    // Parse an explicit `xxx://` scheme and apply the allowlist.
    if let Some(pos) = input.find("://") {
        let scheme = &input[..pos];
        if scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        {
            let url = url::Url::parse(input).map_err(|e| format!("Invalid URL: {e}"))?;
            if !scheme_allowed(&url) {
                return Err(format!("Scheme not allowed: {}", url.scheme()));
            }
            return Ok(url);
        }
    }
    // Domain-like input contains a dot or localhost and no whitespace; prepend HTTPS.
    let no_space = !input.chars().any(char::is_whitespace);
    let host_part = input.split(['/', ':']).next().unwrap_or("");
    let domain_like = no_space && (host_part.contains('.') || host_part == "localhost");
    if domain_like {
        let url = url::Url::parse(&format!("https://{input}"))
            .map_err(|e| format!("Invalid URL: {e}"))?;
        if !scheme_allowed(&url) {
            return Err(format!("Scheme not allowed: {}", url.scheme()));
        }
        return Ok(url);
    }
    // Search terms.
    url::Url::parse_with_params("https://www.google.com/search", &[("q", input)])
        .map_err(|e| format!("Failed to build search URL: {e}"))
}

/// Y offset for add_child/set_position, nonzero only on macOS.
///
/// macOS shifts from frame origin to CSS content origin using logical height minus CSS viewport height.
/// Linux/Windows client origins already match CSS and return zero, avoiding cross-runtime scale mismatches.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn y_offset(window: &tauri::Window, css_viewport_h: f64) -> f64 {
    #[cfg(target_os = "macos")]
    {
        let (Ok(inner), Ok(scale)) = (window.inner_size(), window.scale_factor()) else {
            return 0.0;
        };
        (inner.height as f64 / scale - css_viewport_h).max(0.0)
    }
    #[cfg(not(target_os = "macos"))]
    {
        0.0
    }
}

/// Resolve a child WebView by tabId.
fn webview_of(
    app: &AppHandle,
    state: &State<'_, BrowserManager>,
    tab_id: &str,
) -> Option<tauri::Webview> {
    app.get_webview(&state.label_of(tab_id)?)
}

/// Create and mount a child WebView from frontend placeholder bounds and CSS viewport height. Repeated calls
/// for the same tabId update bounds idempotently.
///
/// Must remain async. On Windows add_child posts build to the main thread and blocks the caller on recv; a
/// synchronous main-thread command would deadlock waiting for itself. Async moves the wait to a worker so
/// the main loop can build. Other operations only post messages and may remain synchronous.
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    state: State<'_, BrowserManager>,
    tab_id: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    css_viewport_h: f64,
) -> Result<(), String> {
    let window = app.get_window("main").ok_or("main window not found")?;
    if state.label_of(&tab_id).is_some() {
        return browser_set_bounds(app.clone(), state, tab_id, x, y, w, h, css_viewport_h);
    }
    let parsed = normalize_url(&url)?;
    let label = format!("browser-{}", &uuid::Uuid::new_v4().to_string()[..8]);

    let nav_app = app.clone();
    let nav_tab = tab_id.clone();
    let load_app = app.clone();
    let load_tab = tab_id.clone();
    let builder = tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed))
        .user_agent(SAFARI_UA)
        .data_store_identifier(VLX_BROWSER_STORE)
        .initialization_script(POPUP_REWRITE_JS)
        // Enforce the scheme allowlist for in-page navigation and report URL changes.
        .on_navigation(move |url| {
            if !scheme_allowed(url) {
                return false;
            }
            emit_state(&nav_app, &nav_tab, url, true);
            true
        })
        .on_page_load(move |_, payload| {
            let loading = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            emit_state(&load_app, &load_tab, payload.url(), loading);
        })
        // Disable wry native drag/drop interception so macOS pages receive HTML5 file drops.
        .disable_drag_drop_handler();

    let offset = y_offset(&window, css_viewport_h);
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y + offset),
            LogicalSize::new(w, h),
        )
        .map_err(|e| format!("Failed to create browser webview: {e}"))?;

    if let Ok(mut map) = state.0.lock() {
        map.insert(tab_id, label);
    }
    Ok(())
}

/// Address-bar navigation after HTTPS/search normalization and invalid-scheme rejection.
#[tauri::command]
pub fn browser_navigate(
    app: AppHandle,
    state: State<'_, BrowserManager>,
    tab_id: String,
    input: String,
) -> Result<(), String> {
    let url = normalize_url(&input)?;
    let Some(wv) = webview_of(&app, &state, &tab_id) else {
        return Ok(());
    };
    wv.navigate(url)
        .map_err(|e| format!("Navigation failed: {e}"))
}

/// Navigate back through evaluated history API because Tauri exposes no goBack; no-op without history.
#[tauri::command]
pub fn browser_back(app: AppHandle, state: State<'_, BrowserManager>, tab_id: String) {
    if let Some(wv) = webview_of(&app, &state, &tab_id) {
        let _ = wv.eval("history.back()");
    }
}

/// Navigate forward.
#[tauri::command]
pub fn browser_forward(app: AppHandle, state: State<'_, BrowserManager>, tab_id: String) {
    if let Some(wv) = webview_of(&app, &state, &tab_id) {
        let _ = wv.eval("history.forward()");
    }
}

/// Reload through Webview::reload, available in 2.11.
#[tauri::command]
pub fn browser_reload(app: AppHandle, state: State<'_, BrowserManager>, tab_id: String) {
    if let Some(wv) = webview_of(&app, &state, &tab_id) {
        let _ = wv.reload();
    }
}

/// Stop loading.
#[tauri::command]
pub fn browser_stop(app: AppHandle, state: State<'_, BrowserManager>, tab_id: String) {
    if let Some(wv) = webview_of(&app, &state, &tab_id) {
        let _ = wv.eval("window.stop()");
    }
}

/// Synchronize bounds after placeholder ResizeObserver or window changes.
#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    state: State<'_, BrowserManager>,
    tab_id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    css_viewport_h: f64,
) -> Result<(), String> {
    let Some(wv) = webview_of(&app, &state, &tab_id) else {
        return Ok(());
    };
    let window = app.get_window("main").ok_or("main window not found")?;
    let offset = y_offset(&window, css_viewport_h);
    wv.set_position(LogicalPosition::new(x, y + offset))
        .map_err(|e| format!("Failed to move browser webview: {e}"))?;
    wv.set_size(LogicalSize::new(w, h))
        .map_err(|e| format!("Failed to resize browser webview: {e}"))?;
    Ok(())
}

/// Show or hide on tab changes while keeping hidden page processes and media alive.
#[tauri::command]
pub fn browser_set_visible(
    app: AppHandle,
    state: State<'_, BrowserManager>,
    tab_id: String,
    visible: bool,
) {
    if let Some(wv) = webview_of(&app, &state, &tab_id) {
        let _ = if visible { wv.show() } else { wv.hide() };
    }
}

/// Close and destroy a child WebView when its tab closes.
#[tauri::command]
pub fn browser_close(app: AppHandle, state: State<'_, BrowserManager>, tab_id: String) {
    let label = if let Ok(mut map) = state.0.lock() {
        map.remove(&tab_id)
    } else {
        None
    };
    if let Some(label) = label {
        if let Some(wv) = app.get_webview(&label) {
            // Hide before close so occasional macOS delayed child-view removal cannot leave a white remnant.
            let _ = wv.hide();
            let _ = wv.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_url;

    #[test]
    fn full_http_https_urls_pass_through() {
        assert_eq!(
            normalize_url("https://github.com/a/b?x=1")
                .unwrap()
                .as_str(),
            "https://github.com/a/b?x=1"
        );
        assert_eq!(
            normalize_url("http://example.com").unwrap().as_str(),
            "http://example.com/"
        );
    }

    #[test]
    fn domain_like_gets_https_prefix() {
        assert_eq!(
            normalize_url("github.com").unwrap().as_str(),
            "https://github.com/"
        );
        assert_eq!(
            normalize_url("news.ycombinator.com/item?id=1")
                .unwrap()
                .as_str(),
            "https://news.ycombinator.com/item?id=1"
        );
        assert_eq!(
            normalize_url("example.com:8080/path").unwrap().as_str(),
            "https://example.com:8080/path"
        );
        assert_eq!(
            normalize_url("localhost:1420").unwrap().as_str(),
            "https://localhost:1420/"
        );
    }

    #[test]
    fn search_terms_go_to_google() {
        let url = normalize_url("rust tauri webview").unwrap();
        assert_eq!(url.host_str(), Some("www.google.com"));
        assert_eq!(url.path(), "/search");
        assert!(url.query().unwrap().contains("rust"));
        // Input containing a dot and whitespace remains a search term.
        let url = normalize_url("what is tauri 2.0").unwrap();
        assert_eq!(url.host_str(), Some("www.google.com"));
    }

    #[test]
    fn disallowed_schemes_rejected() {
        assert!(normalize_url("file:///etc/hosts").is_err());
        assert!(normalize_url("ftp://example.com").is_err());
        // javascript:/data: without `://` becomes a harmless search or parse failure, never its original scheme.
        let url = normalize_url("javascript:alert(1)").unwrap();
        assert_eq!(url.host_str(), Some("www.google.com"));
    }

    #[test]
    fn about_blank_allowed() {
        assert_eq!(
            normalize_url("about:blank").unwrap().as_str(),
            "about:blank"
        );
        assert_eq!(
            normalize_url("ABOUT:BLANK").unwrap().as_str(),
            "about:blank"
        );
    }

    #[test]
    fn empty_and_whitespace_rejected() {
        assert!(normalize_url("").is_err());
        assert!(normalize_url("   ").is_err());
    }
}
