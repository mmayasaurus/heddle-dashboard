//! Route-mix scoreboard (HED-69) — hourly ledger aggregates for the Fleet drawer.
//!
//! Answers Maya's "is the delegation discipline working?" at a glance: for each of the last N
//! UTC hours, how many worker tokens each provider consumed (the work routed OFF the Claude pool),
//! plus per-orchestrator dispatch counts for the same window. Pure ledger reads — the Claude cap
//! delta shown next to these rows is computed client-side from the drawer's own
//! `heddle_provider_limits` polls, because no cap-history file exists (deliberately: HED-69's AC is
//! "no new backend beyond a ledger aggregate command").
//!
//! Same posture as the other ledger views in `mod.rs`: read-only (`query_only`), best-effort
//! (missing ledger ⇒ empty result), TEST-orchestrator rows excluded everywhere (they are
//! heddle-core verification dispatches, not fleet work — the drawer's recent list already hides
//! them, and a scoreboard that counted them would overstate delegation).

use rusqlite::Connection;
use serde::Serialize;

/// One provider's slice of one hour bucket.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHourTokens {
    pub provider: String,
    pub dispatches: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

/// One UTC hour of routed work. `hour` is the ISO prefix "YYYY-MM-DDTHH" (UTC, matches the
/// ledger's `toISOString` timestamps); the frontend localizes it for display.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HourBucket {
    pub hour: String,
    pub providers: Vec<ProviderHourTokens>,
}

/// Per-orchestrator dispatch counts over the whole window (NULL orchestrator ⇒ "?").
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorCount {
    pub orchestrator: String,
    pub dispatches: i64,
    pub succeeded: i64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteMix {
    pub window_hours: i64,
    pub hours: Vec<HourBucket>,
    pub orchestrators: Vec<OrchestratorCount>,
}

/// Hourly route-mix over the last `hours` (default 6, clamped 1..=48).
#[tauri::command]
pub async fn heddle_route_mix(hours: Option<i64>) -> Result<RouteMix, String> {
    super::blocking(move || route_mix_sync(hours)).await
}

fn route_mix_sync(hours: Option<i64>) -> Result<RouteMix, String> {
    let hours = hours.unwrap_or(6).clamp(1, 48);
    let Some(conn) = super::ledger()? else {
        return Ok(RouteMix { window_hours: hours, hours: vec![], orchestrators: vec![] });
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let cutoff = aligned_cutoff_iso(now, hours);
    route_mix_from(&conn, hours, &cutoff)
}

/// Cutoff aligned to the top of the hour: asking for N hours yields at most N CALENDAR hour
/// buckets (the current partial hour plus N-1 complete ones) — a rolling cutoff would produce
/// N+1 buckets with a misleading partial oldest row.
fn aligned_cutoff_iso(now_secs: i64, hours: i64) -> String {
    let hour_start = now_secs - now_secs.rem_euclid(3600);
    epoch_to_iso(hour_start - (hours - 1) * 3600)
}

/// ISO-UTC cutoff `hours` ago, comparable to the ledger's `toISOString` values by plain string
/// ordering (both are zero-padded UTC ISO-8601).
fn cutoff_iso(hours: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    epoch_to_iso(now - hours * 3600)
}

/// Minimal epoch→ISO (UTC, second precision) without a chrono dependency: civil-from-days per
/// Howard Hinnant's algorithm.
fn epoch_to_iso(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{y:04}-{mth:02}-{d:02}T{h:02}:{m:02}:{s:02}.000Z")
}

/// The aggregate itself, over an injected connection so tests drive it with fixture data.
fn route_mix_from(conn: &Connection, window_hours: i64, cutoff: &str) -> Result<RouteMix, String> {
    // Hour × provider. substr(…, 1, 13) is "YYYY-MM-DDTHH" on the ledger's ISO timestamps.
    let mut stmt = conn
        .prepare(
            "SELECT substr(started_at, 1, 13) AS hour, provider,
                    COUNT(*) AS dispatches,
                    SUM(COALESCE(input_tokens, 0)) AS input_tokens,
                    SUM(COALESCE(output_tokens, 0)) AS output_tokens
             FROM dispatches
             WHERE started_at >= ?1 AND (orchestrator IS NULL OR orchestrator <> 'TEST')
             GROUP BY hour, provider
             ORDER BY hour ASC, provider ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([cutoff], |r| {
            Ok((
                r.get::<_, String>("hour")?,
                ProviderHourTokens {
                    provider: r.get("provider")?,
                    dispatches: r.get("dispatches")?,
                    input_tokens: r.get("input_tokens")?,
                    output_tokens: r.get("output_tokens")?,
                },
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut hours: Vec<HourBucket> = Vec::new();
    for row in rows {
        let (hour, slice) = row.map_err(|e| e.to_string())?;
        match hours.last_mut() {
            Some(b) if b.hour == hour => b.providers.push(slice),
            _ => hours.push(HourBucket { hour, providers: vec![slice] }),
        }
    }

    // Orchestrator counts over the whole window.
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(orchestrator, '?') AS orchestrator,
                    COUNT(*) AS dispatches, SUM(ok) AS succeeded
             FROM dispatches
             WHERE started_at >= ?1 AND (orchestrator IS NULL OR orchestrator <> 'TEST')
             GROUP BY COALESCE(orchestrator, '?')
             ORDER BY dispatches DESC, orchestrator ASC",
        )
        .map_err(|e| e.to_string())?;
    let orchestrators = stmt
        .query_map([cutoff], |r| {
            Ok(OrchestratorCount {
                orchestrator: r.get("orchestrator")?,
                dispatches: r.get("dispatches")?,
                succeeded: r.get::<_, Option<i64>>("succeeded")?.unwrap_or(0),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(RouteMix { window_hours, hours, orchestrators })
}

#[cfg(test)]
#[path = "route_mix_tests.rs"]
mod tests;
