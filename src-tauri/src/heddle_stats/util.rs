//! Small shared helpers for the provider-caps sources: PATH augmentation for GUI launches,
//! time/staleness, email masking, atomic snapshot writes, and running a CLI with a timeout.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::home;

/// GUI apps launched from Finder/Dock don't inherit the shell PATH, so `ccusage` / `claudex-usage` /
/// `agy` (installed via bun/npm/brew/curl) won't resolve by bare name. APPEND the usual install homes
/// (after the inherited PATH, so a user's own ordering still wins) using the platform's separator.
pub(crate) fn augmented_path() -> std::ffi::OsString {
    let h = home();
    let extra = [
        h.join(".bun/bin"),
        h.join(".npm-global/bin"),
        h.join(".local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    let current = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&current).collect();
    for p in extra {
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    // join_paths only fails if a dir contains the separator itself; keep the inherited PATH then.
    std::env::join_paths(dirs).unwrap_or(current)
}

pub(crate) fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `Some(true)` when the capture is older than `after` seconds; `None` when there is nothing to
/// judge (no capture time).
pub(crate) fn is_stale(captured_at: Option<i64>, now: i64, after: i64) -> Option<bool> {
    captured_at.map(|t| now - t > after)
}

/// Mask an email for display: first character of the local part + the full domain
/// ("alice@example.com" → "a…@example.com"). Anything that isn't `local@domain` is returned as-is.
pub(crate) fn mask_email(email: &str) -> String {
    match email.split_once('@') {
        Some((local, domain)) if !local.is_empty() && !domain.is_empty() => {
            let first = local.chars().next().unwrap_or('?');
            format!("{first}…@{domain}")
        }
        _ => email.to_string(),
    }
}

/// `~/.heddle/usage/` — the statusline tap's snapshot dir; per-provider refreshers write here too.
pub(crate) fn usage_dir() -> PathBuf {
    home().join(".heddle").join("usage")
}

/// Write JSON atomically (tmp + rename) so a reader never sees a half-written snapshot.
pub(crate) fn write_json_atomic(path: &Path, v: &serde_json::Value) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }
    // Unique temp name: two overlapping writers of the same target (e.g. two polls mirroring
    // limits.json) must never clobber each other's temp file.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}.{seq}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_vec(v).map_err(|e| e.to_string())?)
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    // `rename` replaces an existing destination on every platform std supports (MoveFileEx with
    // REPLACE_EXISTING on Windows); a reader that has the file open without share-delete (an
    // external tool on Windows) can still make it fail transiently, so retry briefly.
    let mut last = None;
    for attempt in 0..3 {
        match std::fs::rename(&tmp, path) {
            Ok(()) => {
                sweep_stale_tmp(path);
                return Ok(());
            }
            Err(e) => {
                last = Some(e);
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    Err(format!(
        "rename {}: {}",
        path.display(),
        last.map(|e| e.to_string()).unwrap_or_default()
    ))
}

/// Reap `<stem>.json.<pid>.<seq>.tmp` siblings older than an hour — leftovers from a process that
/// died between write and rename. Best-effort; readers ignore `.tmp` files anyway.
fn sweep_stale_tmp(target: &Path) {
    let (Some(dir), Some(stem)) = (target.parent(), target.file_stem().and_then(|s| s.to_str()))
    else {
        return;
    };
    let prefix = format!("{stem}.json.");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !(name.starts_with(&prefix) && name.ends_with(".tmp")) {
            continue;
        }
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .map(|age| age > Duration::from_secs(3600))
            .unwrap_or(false);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Run a command with a wall-clock budget, returning (exit success, stdout, stderr). The child is
/// killed on timeout. stdout/stderr are drained on threads so a chatty child can't deadlock us.
pub(crate) fn run_with_timeout(
    mut cmd: Command,
    budget: Duration,
) -> Result<(bool, String, String), String> {
    use std::process::Stdio;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;
    let drain = |pipe: Option<std::process::ChildStdout>,
                 err: Option<std::process::ChildStderr>| {
        std::thread::spawn(move || {
            let mut out = String::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_string(&mut out);
            }
            if let Some(mut e) = err {
                let _ = e.read_to_string(&mut out);
            }
            out
        })
    };
    let out_t = drain(child.stdout.take(), None);
    let err_t = drain(None, child.stderr.take());
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Ok(st),
            Ok(None) if started.elapsed() >= budget => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!("timed out after {}s", budget.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => break Err(format!("wait failed: {e}")),
        }
    };
    let stdout = out_t.join().unwrap_or_default();
    let stderr = err_t.join().unwrap_or_default();
    let st = status?;
    Ok((st.success(), stdout, stderr))
}

/// One-at-a-time out-of-band refresh with failure backoff, shared by the slow sources (Gemini,
/// Cursor): the work runs on a detached thread; a second caller while one is in flight is a no-op;
/// after a failed run callers back off for `backoff_secs` unless they force. The in-flight flag is
/// cleared by a Drop guard (panic-safe) and thread-spawn failure clears it too.
pub(crate) struct RefreshGate {
    refreshing: std::sync::atomic::AtomicBool,
    next_attempt_at: std::sync::atomic::AtomicI64,
}

impl RefreshGate {
    pub(crate) const fn new() -> Self {
        Self {
            refreshing: std::sync::atomic::AtomicBool::new(false),
            next_attempt_at: std::sync::atomic::AtomicI64::new(0),
        }
    }

    /// `true` when a refresh thread was started. `work` returns whether the refresh succeeded.
    pub(crate) fn spawn(
        &'static self,
        now: i64,
        force: bool,
        backoff_secs: i64,
        work: impl FnOnce() -> bool + Send + 'static,
    ) -> bool {
        use std::sync::atomic::Ordering::SeqCst;
        if !force && now < self.next_attempt_at.load(SeqCst) {
            return false;
        }
        if self
            .refreshing
            .compare_exchange(false, true, SeqCst, SeqCst)
            .is_err()
        {
            return false;
        }
        struct Guard(&'static RefreshGate);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.refreshing.store(false, SeqCst);
            }
        }
        let spawned = std::thread::Builder::new()
            .name("heddle-usage-refresh".into())
            .spawn(move || {
                let _guard = Guard(self);
                let ok = work();
                let done = now_secs();
                self.next_attempt_at
                    .store(if ok { 0 } else { done + backoff_secs }, SeqCst);
            });
        if spawned.is_err() {
            self.refreshing.store(false, SeqCst);
            self.next_attempt_at.store(now + backoff_secs, SeqCst);
            return false;
        }
        true
    }

    /// Whether a refresh is currently running (tests).
    #[cfg(test)]
    pub(crate) fn in_flight(&self) -> bool {
        self.refreshing.load(std::sync::atomic::Ordering::SeqCst)
    }
}
