//! Fleet roster for the Fleet drawer (Agent R's feature, moved here verbatim from the pre-split
//! `heddle_stats.rs`): live Claude Code fleet orchestrators (`~/.claude/sessions/*.json`, alive by
//! `kill(pid, 0)`) with the in-flight heddle workers each one owns, plus an "(orphaned)" bucket
//! for workers whose orchestrator is gone.

use serde::Serialize;

use super::{home, ledger};

/// One in-flight heddle worker, grouped under its live fleet orchestrator for the Fleet drawer.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worker {
    id: i64,
    task_class: String,
    provider: String,
    model: String,
    started_at: String,
    cwd: String,
    elapsed_ms: i64,
    stale: bool,
}

/// A live Claude Code fleet orchestrator and the heddle workers it currently owns.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetAgent {
    name: String,
    pid: i64,
    session_id: String,
    cwd: String,
    status: String,
    kind: String,
    updated_at_ms: i64,
    alive: bool,
    workers: Vec<Worker>,
}

fn process_alive(pid: i32) -> bool {
    // `kill(pid, 0)` does not send a signal; EPERM means the process exists but belongs to another
    // user, which is still live for roster purposes.
    unsafe {
        libc::kill(pid, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

fn live_fleet_agents() -> Vec<FleetAgent> {
    let dir = home().join(".claude").join("sessions");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };

    let mut agents = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(session) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let Some(name) = session["name"].as_str() else {
            continue;
        };
        if !(1..=3).contains(&name.chars().count()) {
            continue;
        }
        let Some(pid) = session["pid"].as_i64() else {
            continue;
        };
        let Ok(pid_for_kill) = i32::try_from(pid) else {
            continue;
        };
        if pid_for_kill <= 0 || !process_alive(pid_for_kill) {
            continue;
        }
        agents.push(FleetAgent {
            name: name.to_string(),
            pid,
            session_id: session["sessionId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            cwd: session["cwd"].as_str().unwrap_or_default().to_string(),
            status: session["status"].as_str().unwrap_or_default().to_string(),
            kind: session["kind"].as_str().unwrap_or_default().to_string(),
            updated_at_ms: session["updatedAt"].as_i64().unwrap_or_default(),
            alive: true,
            workers: vec![],
        });
    }
    agents
}

fn attach_in_flight_workers(agents: &mut [FleetAgent]) -> Vec<Worker> {
    let Ok(Some(conn)) = ledger() else {
        return vec![];
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, orchestrator, task_class, provider, model, started_at, cwd, \
         (julianday('now') - julianday(started_at)) * 86400000.0 AS elapsed_ms \
         FROM dispatches WHERE finished_at IS NULL ORDER BY id DESC",
    ) else {
        return vec![];
    };
    let Ok(rows) = stmt.query_map([], |row| {
        let elapsed_ms = row
            .get::<_, Option<f64>>("elapsed_ms")?
            .unwrap_or_default()
            .max(0.0) as i64;
        Ok((
            row.get::<_, Option<String>>("orchestrator")?,
            Worker {
                id: row.get("id")?,
                task_class: row.get("task_class")?,
                provider: row.get("provider")?,
                model: row.get("model")?,
                started_at: row.get("started_at")?,
                cwd: row.get("cwd")?,
                elapsed_ms,
                stale: elapsed_ms > 12 * 60 * 60 * 1000,
            },
        ))
    }) else {
        return vec![];
    };

    let mut orphaned = Vec::new();
    for (orchestrator, worker) in rows.flatten() {
        if let Some(agent) = agents
            .iter_mut()
            .find(|agent| Some(agent.name.as_str()) == orchestrator.as_deref())
        {
            agent.workers.push(worker);
        } else {
            orphaned.push(worker);
        }
    }
    orphaned
}

/// Live Claude Code fleet agents plus their in-flight heddle workers. Both sources are optional:
/// inaccessible sessions or ledger data simply produce a partial roster rather than failing the drawer.
#[tauri::command]
pub async fn heddle_fleet_roster() -> Result<Vec<FleetAgent>, String> {
    Ok(
        match tauri::async_runtime::spawn_blocking(|| {
            let mut agents = live_fleet_agents();
            let orphaned = attach_in_flight_workers(&mut agents);
            agents.sort_by(|a, b| {
                b.alive
                    .cmp(&a.alive)
                    .then((!a.cwd.contains("heddle")).cmp(&(!b.cwd.contains("heddle"))))
                    .then(a.name.cmp(&b.name))
            });
            if !orphaned.is_empty() {
                agents.push(FleetAgent {
                    name: "(orphaned)".to_string(),
                    pid: 0,
                    session_id: String::new(),
                    cwd: String::new(),
                    status: String::new(),
                    kind: String::new(),
                    updated_at_ms: 0,
                    alive: false,
                    workers: orphaned,
                });
            }
            agents
        })
        .await
        {
            Ok(agents) => agents,
            Err(_) => vec![],
        },
    )
}
