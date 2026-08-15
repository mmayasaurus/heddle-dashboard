//! SQLite persistence layer.

pub mod repo;
pub mod schema;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};

/// Database file name inside the app data directory. Renamed from upstream's `vlx-term.db` (HED-40).
pub const DB_FILE: &str = "heddle.db";
/// Pre-rename database file name; migrated forward once by [`app_db_path`], never modified or removed.
pub const LEGACY_DB_FILE: &str = "vlx-term.db";

/// Resolve the database path inside `data_dir`, migrating a legacy `vlx-term.db` on first sight.
///
/// If `heddle.db` does not exist yet and `vlx-term.db` does, a consistent copy is produced with SQLite's
/// `VACUUM INTO` through a normal connection (so WAL content is folded in — a raw file copy of a WAL
/// database could drop the newest writes), written to `heddle.db.migrating` and renamed into place. The
/// legacy file is left exactly as it was so a pre-rename build still opens it. If the copy fails, the
/// legacy path is returned so startup keeps working on the old file (logged, not fatal).
pub fn app_db_path(data_dir: &Path) -> PathBuf {
    let new = data_dir.join(DB_FILE);
    let legacy = data_dir.join(LEGACY_DB_FILE);
    if new.exists() || !legacy.exists() {
        return new;
    }
    match copy_legacy_db(&legacy, &new) {
        Ok(()) => {
            eprintln!(
                "[heddle] migrated {} -> {} (legacy file kept untouched)",
                legacy.display(),
                new.display()
            );
            new
        }
        Err(e) => {
            eprintln!(
                "[heddle] legacy database migration failed ({e}); continuing on {}",
                legacy.display()
            );
            legacy
        }
    }
}

/// `VACUUM INTO` a consistent snapshot of `legacy` and place it at `new`. Read-only with respect to
/// `legacy`: VACUUM INTO never modifies the source database.
///
/// Concurrency: a GUI instance and a `--serve` instance can start against the same data dir at the same
/// moment and both see "no heddle.db yet". Each writes its own per-process temp file and then claims the
/// final name with [`place_snapshot`], which is atomic and never replaces an existing `heddle.db` — so
/// whichever process wins, the other simply adopts the winner's file and no open handle is ever swapped
/// underneath a running instance.
fn copy_legacy_db(legacy: &Path, new: &Path) -> Result<(), String> {
    let tmp = new.with_extension(format!("db.migrating.{}", std::process::id()));
    // Only ever our own incomplete artifact (same pid) from an interrupted earlier attempt.
    if tmp.exists() {
        std::fs::remove_file(&tmp).map_err(|e| format!("cannot clear stale {}: {e}", tmp.display()))?;
    }
    let src = Connection::open(legacy).map_err(|e| format!("open legacy db: {e}"))?;
    src.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("busy_timeout: {e}"))?;
    let tmp_str = tmp
        .to_str()
        .ok_or_else(|| "non-UTF-8 data dir path".to_string())?
        .to_string();
    src.execute("VACUUM INTO ?1", [tmp_str])
        .map_err(|e| format!("VACUUM INTO: {e}"))?;
    drop(src);
    place_snapshot(&tmp, new)
}

/// Atomically publish `tmp` as `new` without ever replacing an existing `new`. `hard_link` fails with
/// `AlreadyExists` when the target exists (POSIX and Windows), unlike `rename`, which would silently
/// clobber a concurrent migrator's already-open database. Either way the temp file is removed.
fn place_snapshot(tmp: &Path, new: &Path) -> Result<(), String> {
    let linked = std::fs::hard_link(tmp, new);
    let _ = std::fs::remove_file(tmp);
    match linked {
        Ok(()) => Ok(()),
        // Another process published its snapshot first; ours was an identical copy of the same legacy
        // file, so adopting theirs is correct.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(format!("place snapshot into {}: {e}", new.display())),
    }
}

/// Database handle injected as Tauri managed state.
pub struct Db {
    pub conn: Mutex<Connection>,
}

impl Db {
    /// Open or create the database and initialize its schema.
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("Failed to open database: {e}"))?;
        // Connection PRAGMAs are ordered deliberately. busy_timeout waits up to five seconds on locks so
        // multiple processes sharing a development database queue writes rather than immediately returning
        // SQLITE_BUSY. WAL allows concurrent readers and a serialized writer and requires local storage;
        // it persists in the database file. foreign_keys must be enabled per connection for cascades.
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| format!("Failed to set busy_timeout: {e}"))?;
        conn.execute_batch("PRAGMA journal_mode = WAL;\nPRAGMA foreign_keys = ON;")
            .map_err(|e| format!("Failed to set pragmas: {e}"))?;
        conn.execute_batch(schema::SCHEMA)
            .map_err(|e| format!("Failed to initialize schema: {e}"))?;
        migrate(&conn)?;
        // Create FTS5/trigram separately so an unavailable extension disables search without blocking startup.
        init_search_index(&conn);
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

/// Create the `session_fts` FTS5 virtual table. Some SQLite builds omit FTS5/trigram, so failure is logged
/// and swallowed. [`table_exists`] then reports search unavailable without preventing application startup.
fn init_search_index(conn: &Connection) {
    if let Err(e) = conn.execute_batch(schema::SESSION_FTS_DDL) {
        eprintln!(
            "[heddle] Search index unavailable: failed to create FTS5 table ({e}). \
             Full-text search will be disabled. This SQLite build may lack FTS5/trigram support."
        );
    }
}

/// Whether a regular or virtual table exists in sqlite_master, used to detect session_fts availability.
pub fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?1",
        [table],
        |_| Ok(()),
    )
    .optional()
    .map(|o| o.is_some())
    .unwrap_or(false)
}

/// Incrementally add columns missing from older databases; SCHEMA already covers new databases.
fn migrate(conn: &Connection) -> Result<(), String> {
    // Add sessions.kind to old databases with terminal as a nondestructive default.
    if !column_exists(conn, "sessions", "kind") {
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'terminal'",
            [],
        )
        .map_err(|e| format!("Failed to migrate sessions.kind: {e}"))?;
    }
    // Add nullable sessions.agent_session_id for the last native agent ID used by automatic resume.
    if !column_exists(conn, "sessions", "agent_session_id") {
        conn.execute("ALTER TABLE sessions ADD COLUMN agent_session_id TEXT", [])
            .map_err(|e| format!("Failed to migrate sessions.agent_session_id: {e}"))?;
    }
    // Add nullable parent_session_id for nested sessions. SQLite cannot enforce cascades retroactively on
    // columns added by ALTER, so repo::delete_node recursively deletes children as an application fallback.
    if !column_exists(conn, "sessions", "parent_session_id") {
        conn.execute("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT", [])
            .map_err(|e| format!("Failed to migrate sessions.parent_session_id: {e}"))?;
    }
    // Add sessions.collapsed for child-session expansion, matching projects and groups.
    if !column_exists(conn, "sessions", "collapsed") {
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN collapsed INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("Failed to migrate sessions.collapsed: {e}"))?;
    }
    // Add sessions.worktree_path so deletion can offer associated Git worktree cleanup.
    if !column_exists(conn, "sessions", "worktree_path") {
        conn.execute("ALTER TABLE sessions ADD COLUMN worktree_path TEXT", [])
            .map_err(|e| format!("Failed to migrate sessions.worktree_path: {e}"))?;
    }
    // Add worktree_base_ref for the full baseline branch recorded at worktree creation. Landing and pull
    // requests target it independently of session hierarchy. Old records fall back to the primary branch.
    if !column_exists(conn, "sessions", "worktree_base_ref") {
        conn.execute("ALTER TABLE sessions ADD COLUMN worktree_base_ref TEXT", [])
            .map_err(|e| format!("Failed to migrate sessions.worktree_base_ref: {e}"))?;
    }
    // Add archived_at for reversible soft hiding and read-only playback, nullable when active.
    if !column_exists(conn, "sessions", "archived_at") {
        conn.execute("ALTER TABLE sessions ADD COLUMN archived_at INTEGER", [])
            .map_err(|e| format!("Failed to migrate sessions.archived_at: {e}"))?;
    }
    // Add fork_pending. A value of 1 means agent_session_id still references the source conversation and
    // the first launch must use agent-specific fork arguments. set_agent_session_id clears the flag after
    // capturing the new conversation ID, restoring normal resume behavior.
    if !column_exists(conn, "sessions", "fork_pending") {
        conn.execute(
            "ALTER TABLE sessions ADD COLUMN fork_pending INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("Failed to migrate sessions.fork_pending: {e}"))?;
    }
    // Add browser_url for browser nodes' latest URL; other session types keep it null.
    if !column_exists(conn, "sessions", "browser_url") {
        conn.execute("ALTER TABLE sessions ADD COLUMN browser_url TEXT", [])
            .map_err(|e| format!("Failed to migrate sessions.browser_url: {e}"))?;
    }
    // Add nullable agent_args for user-defined launch arguments appended unchanged to agent commands.
    if !column_exists(conn, "sessions", "agent_args") {
        conn.execute("ALTER TABLE sessions ADD COLUMN agent_args TEXT", [])
            .map_err(|e| format!("Failed to migrate sessions.agent_args: {e}"))?;
    }
    // Add nullable permission_mode. Null/default uses staged approval; skip bypasses confirmations.
    // inject::permission_flag maps it to agent-specific command-line flags at launch.
    if !column_exists(conn, "sessions", "permission_mode") {
        conn.execute("ALTER TABLE sessions ADD COLUMN permission_mode TEXT", [])
            .map_err(|e| format!("Failed to migrate sessions.permission_mode: {e}"))?;
    }
    // Add deleted_at tombstones to projects/groups. Containers holding archived sessions are hidden rather
    // than deleted so restoration can revive the hierarchy. Production SCHEMA always creates both tables;
    // table_exists only supports migration tests containing a sessions table alone.
    if table_exists(conn, "projects") && !column_exists(conn, "projects", "deleted_at") {
        conn.execute("ALTER TABLE projects ADD COLUMN deleted_at INTEGER", [])
            .map_err(|e| format!("Failed to migrate projects.deleted_at: {e}"))?;
    }
    if table_exists(conn, "groups") && !column_exists(conn, "groups", "deleted_at") {
        conn.execute("ALTER TABLE groups ADD COLUMN deleted_at INTEGER", [])
            .map_err(|e| format!("Failed to migrate groups.deleted_at: {e}"))?;
    }
    // Add nullable group worktree path and baseline ref for sidebar tags and new-session defaults.
    if table_exists(conn, "groups") && !column_exists(conn, "groups", "worktree_path") {
        conn.execute("ALTER TABLE groups ADD COLUMN worktree_path TEXT", [])
            .map_err(|e| format!("Failed to migrate groups.worktree_path: {e}"))?;
    }
    if table_exists(conn, "groups") && !column_exists(conn, "groups", "worktree_base_ref") {
        conn.execute("ALTER TABLE groups ADD COLUMN worktree_base_ref TEXT", [])
            .map_err(|e| format!("Failed to migrate groups.worktree_base_ref: {e}"))?;
    }
    // Add the nullable emoji marker to all three node tables. Unmarked nodes keep NULL, so old databases stay
    // unchanged and the sidebar simply renders no marker for them.
    if !column_exists(conn, "sessions", "mark") {
        conn.execute("ALTER TABLE sessions ADD COLUMN mark TEXT", [])
            .map_err(|e| format!("Failed to migrate sessions.mark: {e}"))?;
    }
    if table_exists(conn, "projects") && !column_exists(conn, "projects", "mark") {
        conn.execute("ALTER TABLE projects ADD COLUMN mark TEXT", [])
            .map_err(|e| format!("Failed to migrate projects.mark: {e}"))?;
    }
    if table_exists(conn, "groups") && !column_exists(conn, "groups", "mark") {
        conn.execute("ALTER TABLE groups ADD COLUMN mark TEXT", [])
            .map_err(|e| format!("Failed to migrate groups.mark: {e}"))?;
    }
    // Add ssh_hosts.shared_db to restore the host's last remote-database choice, defaulting to independent.
    if table_exists(conn, "ssh_hosts") && !column_exists(conn, "ssh_hosts", "shared_db") {
        conn.execute(
            "ALTER TABLE ssh_hosts ADD COLUMN shared_db INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| format!("Failed to migrate ssh_hosts.shared_db: {e}"))?;
    }
    // Create the parent index only after migration adds parent_session_id. Putting it in SCHEMA would fail
    // on old databases before ALTER runs; IF NOT EXISTS remains safe and idempotent for new databases.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)",
        [],
    )
    .map_err(|e| format!("Failed to create session parent index: {e}"))?;
    Ok(())
}

/// Whether a table already has a column, based on PRAGMA table_info.
fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    let sql = format!("PRAGMA table_info({table})");
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return false;
    };
    // The second table_info field, index 1, is the column name.
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) else {
        return false;
    };
    // Consume the iterator in this block so its temporary borrow cannot outlive stmt.
    for name in rows.flatten() {
        if name == column {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    /// HED-40: a pre-rename `vlx-term.db` is copied forward to `heddle.db` exactly once, with its
    /// content intact (including rows that only lived in the WAL), and the legacy file is left as-is.
    #[test]
    fn legacy_db_is_migrated_once_and_left_untouched() {
        let dir = std::env::temp_dir().join(format!("heddle-db-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let legacy = dir.join(super::LEGACY_DB_FILE);
        let new = dir.join(super::DB_FILE);

        // No database at all: the new path is returned and nothing is created.
        assert_eq!(super::app_db_path(&dir), new);
        assert!(!new.exists() && !legacy.exists());

        // A legacy WAL database with a row that has NOT been checkpointed into the main file.
        {
            let c = rusqlite::Connection::open(&legacy).unwrap();
            c.execute_batch("PRAGMA journal_mode = WAL; CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (42);")
                .unwrap();
            // Keep the connection open (WAL not checkpointed) while migrating, like a live app would.
            assert_eq!(super::app_db_path(&dir), new);
            drop(c);
        }
        assert!(new.exists(), "heddle.db must be created from the legacy file");
        assert!(legacy.exists(), "legacy file must never be removed");
        let n = rusqlite::Connection::open(&new).unwrap();
        let x: i64 = n.query_row("SELECT x FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(x, 42, "WAL-resident row must survive the copy");
        drop(n);

        // Second call is a no-op: writes to heddle.db are not clobbered by another copy.
        {
            let n = rusqlite::Connection::open(&new).unwrap();
            n.execute("INSERT INTO t VALUES (7)", []).unwrap();
        }
        assert_eq!(super::app_db_path(&dir), new);
        let n = rusqlite::Connection::open(&new).unwrap();
        let cnt: i64 = n.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(cnt, 2, "an existing heddle.db must be used as-is");
        // Legacy content unchanged by everything above.
        let l = rusqlite::Connection::open(&legacy).unwrap();
        let lcnt: i64 = l.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(lcnt, 1);
        drop((n, l));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two migrators racing: the second snapshot must never replace a `heddle.db` that already exists
    /// (another instance may have it open), and its temp file must be cleaned up.
    #[test]
    fn concurrent_snapshot_never_replaces_an_existing_db() {
        let dir = std::env::temp_dir().join(format!("heddle-db-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let new = dir.join(super::DB_FILE);
        std::fs::write(&new, b"winner").unwrap();
        let tmp = dir.join("heddle.db.migrating.999999");
        std::fs::write(&tmp, b"loser").unwrap();
        super::place_snapshot(&tmp, &new).unwrap();
        assert_eq!(std::fs::read(&new).unwrap(), b"winner", "existing heddle.db must be left alone");
        assert!(!tmp.exists(), "the losing temp file must be removed");
        // And the normal path still publishes when nothing exists yet.
        let fresh = dir.join("fresh.db");
        let tmp2 = dir.join("fresh.db.migrating.1");
        std::fs::write(&tmp2, b"snapshot").unwrap();
        super::place_snapshot(&tmp2, &fresh).unwrap();
        assert_eq!(std::fs::read(&fresh).unwrap(), b"snapshot");
        assert!(!tmp2.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;
    use rusqlite::Connection;

    /// Simulate an early sessions table missing hierarchy/worktree columns. Migration adds them and the
    /// parent index idempotently, guarding the regression where a SCHEMA index crashed old databases.
    #[test]
    fn migrate_adds_columns_and_index_on_legacy_db() {
        let conn = Connection::open_in_memory().unwrap();
        // Early sessions table missing three columns.
        conn.execute_batch(
            "CREATE TABLE sessions (
               id TEXT PRIMARY KEY, project_id TEXT NOT NULL, group_id TEXT,
               name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL
             );",
        )
        .unwrap();

        migrate(&conn).unwrap();

        assert!(column_exists(&conn, "sessions", "parent_session_id"));
        assert!(column_exists(&conn, "sessions", "collapsed"));
        assert!(column_exists(&conn, "sessions", "worktree_path"));
        assert!(column_exists(&conn, "sessions", "mark"));

        let idx: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND name='idx_sessions_parent'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(idx, 1, "the idx_sessions_parent index should have been created");

        // A repeated migration remains error-free.
        migrate(&conn).unwrap();
    }

    /// A fresh full SCHEMA also migrates idempotently, skipping existing columns and creating the index.
    #[test]
    fn migrate_is_noop_safe_on_fresh_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(schema::SCHEMA).unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        assert!(column_exists(&conn, "sessions", "parent_session_id"));
    }

    /// Cross-shell application preferences round-trip exactly and use last-write-wins updates per key.
    #[test]
    fn app_settings_roundtrip_and_upsert() {
        use std::collections::HashMap;
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(schema::SCHEMA).unwrap();

        let mut a = HashMap::new();
        a.insert("vlx-theme".to_string(), "dark".to_string());
        a.insert("vlx-lang".to_string(), "zh-CN".to_string());
        repo::set_app_settings(&conn, &a).unwrap();

        let got = repo::get_app_settings(&conn).unwrap();
        assert_eq!(got.get("vlx-theme").map(String::as_str), Some("dark"));
        assert_eq!(got.get("vlx-lang").map(String::as_str), Some("zh-CN"));

        // Upsert replaces the same key without affecting others.
        let mut b = HashMap::new();
        b.insert("vlx-theme".to_string(), "light".to_string());
        repo::set_app_settings(&conn, &b).unwrap();

        let got = repo::get_app_settings(&conn).unwrap();
        assert_eq!(got.get("vlx-theme").map(String::as_str), Some("light"));
        assert_eq!(got.get("vlx-lang").map(String::as_str), Some("zh-CN"));
    }
}
