//! Behavioral tests for the operator composer (HED-74c). Every test that needs a live MCP session
//! drives a FAKE child — a small Python fixture script generated per-test into a tempdir, speaking
//! just enough of the canned MCP handshake + tool results to exercise this module's response
//! handling — never the real `heddle-comms` broker, never a real operator token.
//!
//! Python (not Node, despite the real child being a Node script) is used for the fixture only:
//! `print(..., flush=True)` gives a deterministic, synchronous line-write over the pipe, avoiding
//! Node's platform-dependent async stdout-to-pipe buffering, which would otherwise make these tests
//! racy through no fault of the production code under test. Python3 and Node are both preinstalled
//! on every GitHub-hosted Actions runner this repo's CI uses.
//!
//! Spawn-based tests are `#[cfg(unix)]` — a shebang-executable fixture script needs a POSIX exec,
//! mirroring how rmcp's own `child_process.rs` test suite (`TokioChildProcess` spawn/drop tests)
//! gates itself the same way. Pure logic (redaction, binary-tier resolution, the closed-by-default
//! room args, and the two static-status reasons that need no live child) is tested unconditionally.
//!
//! `state()` is a single process-wide static, so tests that touch it serialize through
//! `test_serial()` and reset it first — otherwise parallel `cargo test` threads would race on the
//! same cached client/backoff fields.

use super::*;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

// ─────────────────────────────────── shared test plumbing ────────────────────────────────────

static TEST_SERIAL: OnceLock<AsyncMutex<()>> = OnceLock::new();

fn test_serial() -> &'static AsyncMutex<()> {
    TEST_SERIAL.get_or_init(|| AsyncMutex::new(()))
}

/// Clears the shared operator state so each serialized test starts from a clean slate regardless
/// of what an earlier test left behind.
async fn reset_state() {
    let mut s = state().lock().await;
    s.client = None;
    s.token = None;
    s.last_spawn_failure = None;
    s.last_reason = None;
}

/// A real `AppCtx::Headless` backed by a throwaway on-disk db in `dir` — enough for
/// `settings_json`/`ctx.db()`, never a Tauri `AppHandle` (impossible to construct outside a
/// running app).
fn test_ctx(dir: &Path) -> AppCtx {
    let db = crate::db::Db::open(&dir.join("test.db")).expect("open fixture db");
    AppCtx::Headless(Arc::new(crate::host::HeadlessHost::new(dir.to_path_buf(), db)))
}

fn put_settings(ctx: &AppCtx, value: &Value) {
    let mut entries = HashMap::new();
    entries.insert("vlx-settings".to_string(), value.to_string());
    crate::command_core::set_app_settings(ctx, entries).expect("seed vlx-settings fixture row");
}

/// A canned MCP stdio server: replies to `initialize`, drains `notifications/initialized`, then
/// answers `tools/call` per `mode`. `__MODE__` is substituted at write time (not read from an env
/// var) so parallel tests never share mutable process environment.
const FAKE_CHILD_TEMPLATE: &str = r#"#!/usr/bin/env python3
import sys, json

MODE = "__MODE__"

def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()

def read():
    line = sys.stdin.readline()
    return json.loads(line) if line else None

req = read()
if req is None:
    sys.exit(0)
send({"jsonrpc": "2.0", "id": req.get("id"), "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": {"tools": {}},
    "serverInfo": {"name": "fake-heddle-comms", "version": "0.0.1"},
}})

read()  # notifications/initialized: no id, no reply expected

calls = 0
while True:
    req = read()
    if req is None:
        break
    calls += 1
    if MODE == "die_after_one_call" and calls > 1:
        sys.exit(1)
    params = req.get("params", {}) or {}
    name = params.get("name")
    args = params.get("arguments") or {}
    if name == "comms_whoami":
        payload = {"revoked": MODE == "whoami_revoked", "identity": "operator"}
    elif MODE == "refused":
        payload = {"outcome": "refused", "code": "floor-held", "reason": "held by someone"}
    elif MODE == "echo_args":
        payload = args
    else:
        payload = {"ok": True}
    send({"jsonrpc": "2.0", "id": req.get("id"), "result": {
        "content": [{"type": "text", "text": json.dumps(payload)}]
    }})
"#;

#[cfg(unix)]
fn write_fake_child(dir: &Path, mode: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(format!("fake-heddle-comms-{mode}.py"));
    std::fs::write(&path, FAKE_CHILD_TEMPLATE.replace("__MODE__", mode))
        .expect("write fake child fixture");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
        .expect("chmod fake child fixture");
    path
}

/// Writes a fake child in `mode`, a fixture token file beside it, and points
/// `vlx-settings.comms.{operatorBinPath,operatorTokenPath}` at both — the one setup every
/// spawn-based test below shares, so each test states only the one thing that varies: its mode.
#[cfg(unix)]
fn configure_fake_child(ctx: &AppCtx, dir: &Path, mode: &str) -> std::path::PathBuf {
    let script = write_fake_child(dir, mode);
    let token_path = dir.join("token");
    std::fs::write(&token_path, "fixture-token-not-real").unwrap();
    put_settings(
        ctx,
        &serde_json::json!({"comms": {
            "operatorBinPath": script.to_string_lossy(),
            "operatorTokenPath": token_path.to_string_lossy(),
        }}),
    );
    script
}

// ───────────────────────────────────── Test 1: token safety ──────────────────────────────────

#[test]
fn operator_token_never_appears_in_argv_or_error_strings() {
    let token = "sekrit-operator-token-abc123";

    // Direct-executable tier (no extra args).
    let cmd = build_command("heddle-comms", &[], token);
    let std_cmd = cmd.as_std();
    assert!(!std_cmd.get_program().to_string_lossy().contains(token));
    assert_eq!(std_cmd.get_args().count(), 0);

    // node-script tier: the script path is a normal arg — still no token anywhere in argv.
    let cmd2 = build_command("node", &["/x/dist/comms/channel-server.js".to_string()], token);
    for arg in cmd2.as_std().get_args() {
        assert!(!arg.to_string_lossy().contains(token));
    }
    assert!(!cmd2.as_std().get_program().to_string_lossy().contains(token));

    // The token IS present in the child's env (that's the whole point) — argv is what must stay clean.
    let has_token_env = std_cmd
        .get_envs()
        .any(|(k, v)| k == "HEDDLE_COMMS_OPERATOR_TOKEN" && v == Some(std::ffi::OsStr::new(token)));
    assert!(has_token_env, "token must reach the child via env");
    let has_push_env = std_cmd.get_envs().any(|(k, _)| k == "HEDDLE_COMMS_PUSH");
    assert!(!has_push_env, "HEDDLE_COMMS_PUSH must never be set by this module");

    // Every error string this module can construct is passed through `redact`.
    let leaked = format!("spawn failed: saw token {token} in a hypothetical error");
    assert_eq!(
        redact(leaked, Some(token)),
        "spawn failed: saw token [REDACTED] in a hypothetical error"
    );
    assert_eq!(redact("no token in play".to_string(), None), "no token in play");
}

// ─────────────────────────────── Test 4a (pure half): closed by default ──────────────────────

#[test]
fn create_room_defaults_to_closed_when_open_not_specified() {
    let args = create_room_args("fleet-x".to_string(), None, None);
    assert_eq!(args.get("open"), Some(&Value::Bool(false)));

    let explicit_open = create_room_args("fleet-y".to_string(), Some("topic".to_string()), Some(true));
    assert_eq!(explicit_open.get("open"), Some(&Value::Bool(true)));
    assert_eq!(explicit_open.get("topic"), Some(&Value::String("topic".to_string())));
}

// ───────────────────────────────── binary resolution (pure) ──────────────────────────────────

#[test]
fn resolve_binary_explicit_override_is_trusted_as_typed() {
    let settings = serde_json::json!({"comms": {"operatorBinPath": "/opt/whatever/heddle-comms"}});
    let resolved = resolve_binary(Some(&settings));
    assert_eq!(resolved, Some(("/opt/whatever/heddle-comms".to_string(), Vec::new())));
}

#[test]
fn resolve_binary_heddle_core_root_requires_the_script_to_exist() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let settings = serde_json::json!({"comms": {"heddleCoreRoot": root}});

    // No `dist/comms/channel-server.js` yet: this tier must not claim availability.
    // (PATH tier 2 sits between explicit-override and this one; asserting `!= Some(("node", ...))`
    // rather than `== None` keeps this test honest about that ordering without depending on the
    // real machine's PATH not having a `heddle-comms` binary on it.)
    let before = resolve_binary(Some(&settings));
    assert_ne!(before, Some(("node".to_string(), vec![dir.path().join("dist/comms/channel-server.js").to_string_lossy().to_string()])));

    let script_dir = dir.path().join("dist").join("comms");
    std::fs::create_dir_all(&script_dir).unwrap();
    std::fs::write(script_dir.join("channel-server.js"), "// fixture").unwrap();
    let after = resolve_binary(Some(&settings));
    assert_eq!(
        after,
        Some((
            "node".to_string(),
            vec![script_dir.join("channel-server.js").to_string_lossy().to_string()]
        ))
    );
}

// ──────────────────────────────── status: no-binary / no-token (pure) ────────────────────────

#[tokio::test]
async fn status_is_no_binary_when_nothing_is_configured() {
    let _serial = test_serial().lock().await;
    reset_state().await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_ctx(dir.path());
    // No settings row at all, and this assumes (per the verified fixture facts) that a machine
    // running this suite does not happen to have a binary literally named `heddle-comms` on PATH.
    let status = static_status(&ctx).await;
    assert_eq!(status.reason, Some("no-binary"));
    assert!(!status.available);
}

#[tokio::test]
async fn status_is_no_token_when_binary_resolves_but_token_file_is_missing() {
    let _serial = test_serial().lock().await;
    reset_state().await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_ctx(dir.path());
    // A binary override that resolves (existence is not checked for this tier — see resolve_binary's
    // doc), plus an explicit, deliberately-absent token path so this never touches the real $HOME.
    put_settings(
        &ctx,
        &serde_json::json!({"comms": {
            "operatorBinPath": dir.path().join("not-a-real-binary").to_string_lossy(),
            "operatorTokenPath": dir.path().join("no-token-here").to_string_lossy(),
        }}),
    );
    let status = static_status(&ctx).await;
    assert_eq!(status.reason, Some("no-token"));
    assert!(!status.available);
}

// ─────────────────────────────────── spawn-based tests (unix) ────────────────────────────────

#[cfg(unix)]
#[tokio::test]
async fn status_spawn_failed_is_cached_after_a_failed_spawn_attempt() {
    let _serial = test_serial().lock().await;
    reset_state().await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_ctx(dir.path());
    // A real file with no execute bit: TokioChildProcess::new must fail the OS-level spawn.
    use std::os::unix::fs::PermissionsExt;
    let not_executable = dir.path().join("heddle-comms");
    std::fs::write(&not_executable, "not a program").unwrap();
    std::fs::set_permissions(&not_executable, std::fs::Permissions::from_mode(0o600)).unwrap();
    put_settings(
        &ctx,
        &serde_json::json!({"comms": {
            "operatorBinPath": not_executable.to_string_lossy(),
            "operatorTokenPath": dir.path().join("token").to_string_lossy(),
        }}),
    );
    std::fs::write(dir.path().join("token"), "fixture-token-not-real").unwrap();

    let err = ensure_client(&ctx).await.expect_err("non-executable file must fail to spawn");
    assert_eq!(err, "spawn-failed");
    // Cached: a status poll right after replays the same reason without a fresh spawn attempt.
    let status = static_status(&ctx).await;
    assert_eq!(status.reason, Some("spawn-failed"));
}

#[cfg(unix)]
#[tokio::test]
async fn status_revoked_reflects_live_whoami() {
    let _serial = test_serial().lock().await;
    reset_state().await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_ctx(dir.path());
    configure_fake_child(&ctx, dir.path(), "whoami_revoked");

    let revoked = whoami_revoked(&ctx).await.expect("whoami should succeed against the fake child");
    assert!(revoked);
    shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn refused_post_message_is_ok_not_err() {
    let _serial = test_serial().lock().await;
    reset_state().await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_ctx(dir.path());
    configure_fake_child(&ctx, dir.path(), "refused");

    let mut args = Map::new();
    args.insert("to".into(), Value::String("#fleet".into()));
    args.insert("body".into(), Value::String("hello".into()));
    let result = passthrough(&ctx, "post_message", Some(args))
        .await
        .expect("a business refusal must be Ok, never Err");
    assert_eq!(result.get("outcome").and_then(Value::as_str), Some("refused"));
    assert_eq!(result.get("code").and_then(Value::as_str), Some("floor-held"));
    shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn create_room_sends_closed_over_the_wire_when_open_omitted() {
    let _serial = test_serial().lock().await;
    reset_state().await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_ctx(dir.path());
    configure_fake_child(&ctx, dir.path(), "echo_args");

    let args = create_room_args("fleet-new".to_string(), None, None);
    let echoed = passthrough(&ctx, "create_room", Some(args))
        .await
        .expect("echo_args always succeeds");
    assert_eq!(echoed.get("open"), Some(&Value::Bool(false)));
    shutdown().await;
}

#[cfg(unix)]
#[tokio::test]
async fn child_crash_triggers_respawn_on_the_next_call() {
    let _serial = test_serial().lock().await;
    reset_state().await;
    let dir = tempfile::tempdir().unwrap();
    let ctx = test_ctx(dir.path());
    configure_fake_child(&ctx, dir.path(), "die_after_one_call");

    // Call 1: the freshly spawned child answers its one call, then will exit on the next request.
    call_tool(&ctx, "comms_whoami", None)
        .await
        .expect("first call against a fresh child succeeds");
    // Call 2: lands on the same connection; the child exits without replying -> this call fails,
    // and must clear the cached client rather than leave a dead pipe cached forever.
    let second = call_tool(&ctx, "comms_whoami", None).await;
    assert!(second.is_err(), "a dead pipe must surface as an error, not hang or succeed");
    assert!(state().lock().await.client.is_none(), "a failed call must clear the cached client");
    // Call 3: proves respawn happened — a brand new child, answering its own first call.
    call_tool(&ctx, "comms_whoami", None)
        .await
        .expect("the next call must respawn rather than replay the dead pipe forever");
    shutdown().await;
}
