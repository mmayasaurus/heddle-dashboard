//! Fable-attributed weekly usage ESTIMATE per Claude account (HED-75).
//!
//! WHY AN ESTIMATE: Fable is capped at 50% of an account's WEEKLY allowance, but no readable surface
//! exposes a Fable-specific window — the Claude Code statusline payload (and therefore the tap's
//! `claude-<acct>.json`) carries only `five_hour` / `seven_day` (verified 2026-08-15). What the tap
//! DOES record on every capture is the `model` of the session that rendered and the account-wide
//! `seven_day.used_percentage`. So: the delta between two consecutive captures on the same account
//! is attributed to the model that rendered the newer capture (`fable-*` → Fable, else Other).
//!
//! HONESTY RULES (all tested):
//!   - a capture is only compared with the previous one WE ingested; the same capture is never
//!     counted twice;
//!   - a new weekly window (`seven_day.resets_at` moved) starts the books over — whatever was already
//!     used at the first capture of a window is `unknown`, not attributed;
//!   - a gap longer than `MAX_GAP_SECS` between ingested captures (the app wasn't watching) sends the
//!     delta to `unknown` instead of inflating whichever model happened to render next;
//!   - the estimate is `null` until `MIN_SAMPLES` positive deltas were attributed (confidence), and the
//!     sample count is always exposed next to it;
//!   - if the payload ever carries a model-scoped window (any `rate_limits` key mentioning `fable`
//!     with a `used_percentage`), that exact value wins and `exact: true` is set — the tap already
//!     captures `rate_limits` verbatim, so nothing else has to change.
//!
//! Interleaved sessions on one account (Fable and Haiku both rendering) still blur attribution —
//! this is a best-effort signal for a soft cap, not an accounting record; the drawer says "≈ … (est.)".
//!
//! Persisted per account at `~/.heddle/usage/claude-<acct>.attrib.json` (atomic write) by
//! `claude::build` on every poll; exposed as `fableWeeklyEstimatePct` / `fableWeeklySamples` on the
//! claude `ProviderLimit` (active account) and each per-account row, with the breakdown in `detail`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Positive attributed deltas needed before the estimate is shown.
pub(super) const MIN_SAMPLES: i64 = 3;
/// Longer than this between ingested captures = nobody was watching; the delta is `unknown`.
pub(super) const MAX_GAP_SECS: i64 = 600;
/// Fraction of the OBSERVED window that must be attributed before the estimate is a usable number.
///
/// A QUARTER, not a half. Starting to watch mid-window is the normal case — the app polls into a week
/// already in progress, and everything burned before the first capture is unknown forever — so a
/// half-coverage bar would suppress the estimate almost always, trading one useless answer for
/// another. A quarter still admits the ordinary mid-window start (measured: a bracketed run covering
/// 5 of 15 points, 33%) while rejecting the case that actually misled (live acct2, 2026-08-17: 3 of
/// 43 points, 7%, reported as a confident `Some(0.0)`).
pub(super) const MIN_COVERAGE: f64 = 0.25;

/// Persisted attribution state for one account and one weekly window. Percent values are percentage
/// points of the account's weekly cap.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct Attrib {
    /// The weekly window these numbers belong to (`seven_day.resets_at`); a different value = new window.
    pub window_resets_at: Option<i64>,
    /// The last capture we ingested (its `capturedAt` and `seven_day.used_percentage`).
    pub last_captured_at: Option<i64>,
    pub last_used_pct: Option<f64>,
    pub fable_pct: f64,
    pub other_pct: f64,
    pub unknown_pct: f64,
    /// Number of positive deltas attributed to Fable or Other — the confidence.
    pub samples: i64,
    /// The payload carried a model-scoped Fable window and `fable_pct` is that exact value.
    pub exact: bool,
    pub updated_at: Option<i64>,
}

/// The fields of one tap capture that attribution needs.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Capture {
    pub captured_at: i64,
    pub model: String,
    pub seven_day_used: Option<f64>,
    pub seven_day_resets_at: Option<i64>,
    /// An exact model-scoped Fable window, if the payload has one.
    pub exact_fable_pct: Option<f64>,
}

/// Extract a `Capture` from a tap snapshot (`{model, rate_limits:{seven_day:{…}, …}, capturedAt}`).
pub(super) fn capture_from_tap(v: &Value) -> Option<Capture> {
    let captured_at = v["capturedAt"].as_i64()?;
    let rl = &v["rate_limits"];
    // Only a WEEKLY Fable window is the exact value for this estimate — a hypothetical
    // fable-scoped 5h window must never be published as the weekly number.
    let exact = rl.as_object().and_then(|m| {
        m.iter()
            .find(|(k, w)| {
                let k = k.to_ascii_lowercase();
                k.contains("fable")
                    && (k.contains("seven_day") || k.contains("7d") || k.contains("week"))
                    && w["used_percentage"].is_number()
            })
            .and_then(|(_, w)| w["used_percentage"].as_f64())
    });
    Some(Capture {
        captured_at,
        model: v["model"].as_str().unwrap_or("").to_string(),
        seven_day_used: rl["seven_day"]["used_percentage"].as_f64(),
        seven_day_resets_at: rl["seven_day"]["resets_at"].as_i64(),
        exact_fable_pct: exact,
    })
}

/// Token match ("claude-fable-5", "Fable"), not substring — a model named e.g. "affable" must not
/// be attributed to Fable.
pub(super) fn is_fable_model(model: &str) -> bool {
    model
        .to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|t| t == "fable")
}

/// Start the books over for a (possibly new) weekly window: whatever is already used at this
/// capture is `unknown`, nothing is attributed, confidence resets.
fn reset_state(state: &mut Attrib, cap: &Capture, used: f64, now: i64) {
    *state = Attrib {
        window_resets_at: cap.seven_day_resets_at,
        last_captured_at: Some(cap.captured_at),
        last_used_pct: Some(used),
        unknown_pct: used,
        updated_at: Some(now),
        ..Default::default()
    };
}

/// Whether `cap` starts a new weekly window relative to `state`. Only two comparable (non-null)
/// reset timestamps that differ prove a new window — a capture temporarily omitting `resets_at`
/// (or the first one to carry it) must not wipe the books.
fn window_changed(state: &Attrib, cap: &Capture) -> bool {
    matches!(
        (state.window_resets_at, cap.seven_day_resets_at),
        (Some(a), Some(b)) if a != b
    )
}

/// Attribute one positive delta (or fold a provider correction) into the buckets.
fn apply_delta(state: &mut Attrib, cap: &Capture, used: f64, prev_used: f64, prev_at: i64) {
    let delta = used - prev_used;
    let gap = cap.captured_at - prev_at;
    if delta > 0.0 {
        if gap > MAX_GAP_SECS {
            state.unknown_pct += delta;
        } else if is_fable_model(&cap.model) {
            state.fable_pct += delta;
            state.samples += 1;
        } else {
            state.other_pct += delta;
            state.samples += 1;
        }
    } else if delta < 0.0 {
        // Used% went DOWN inside the same window (provider correction): shrink the buckets
        // proportionally so they keep summing to what the provider now reports; with nothing to
        // shrink, the reported total is simply unattributable.
        let total = state.fable_pct + state.other_pct + state.unknown_pct;
        if total > 0.0 {
            let f = (used / total).clamp(0.0, 1.0);
            state.fable_pct *= f;
            state.other_pct *= f;
            state.unknown_pct *= f;
        } else {
            state.unknown_pct = used;
        }
    }
}

/// Ordering/duplicate guard: `true` when this capture must be dropped — it is older than the
/// baseline, or identical (same timestamp, same reading, same exact value) to the last one.
fn already_ingested(state: &Attrib, cap: &Capture) -> bool {
    let Some(prev_at) = state.last_captured_at else {
        return false;
    };
    if cap.captured_at < prev_at {
        return true;
    }
    cap.captured_at == prev_at
        && state.last_used_pct == cap.seven_day_used
        && (cap.exact_fable_pct.is_none() || cap.exact_fable_pct == Some(state.fable_pct))
}

/// The exact-window path: adopt the provider's weekly Fable value verbatim. Entering exact mode
/// drops the heuristic books; crossing into a new window while exact starts over first.
fn ingest_exact(state: &mut Attrib, cap: &Capture, exact: f64, now: i64) -> bool {
    if !state.exact || window_changed(state, cap) {
        *state = Attrib {
            exact: true,
            ..Default::default()
        };
    }
    let changed = state.fable_pct != exact || state.last_captured_at != Some(cap.captured_at);
    state.fable_pct = exact;
    if cap.seven_day_resets_at.is_some() {
        state.window_resets_at = cap.seven_day_resets_at;
    }
    state.last_captured_at = Some(cap.captured_at);
    state.last_used_pct = cap.seven_day_used;
    state.updated_at = Some(now);
    changed
}

/// Leaving exact mode inside the SAME window: keep what we KNOW (the last exact Fable share) as
/// the seed, book the remainder as unknown, and rebuild confidence from zero — the estimate hides
/// until fresh samples exist, then resumes well-seeded instead of amnesiac.
fn seed_from_exact(state: &mut Attrib, cap: &Capture, used: f64, now: i64) {
    let seed = state.fable_pct.min(used).max(0.0);
    *state = Attrib {
        window_resets_at: cap.seven_day_resets_at.or(state.window_resets_at),
        last_captured_at: Some(cap.captured_at),
        last_used_pct: Some(used),
        fable_pct: seed,
        unknown_pct: (used - seed).max(0.0),
        updated_at: Some(now),
        ..Default::default()
    };
}

/// Fold one capture into the state. Returns whether the state changed (→ persist).
///
/// Ordering: a capture at the SAME timestamp is re-processed only if its reading differs (two
/// renders inside one second — gap 0, normal attribution); a capture OLDER than the last ingested
/// one is dropped outright, so out-of-order writers can never rewind the baseline.
pub(super) fn ingest(state: &mut Attrib, cap: &Capture, now: i64) -> bool {
    if already_ingested(state, cap) {
        return false;
    }
    if let Some(exact) = cap.exact_fable_pct {
        return ingest_exact(state, cap, exact, now);
    }
    let Some(used) = cap.seven_day_used else {
        return false;
    };
    let (Some(prev_used), Some(prev_at)) = (state.last_used_pct, state.last_captured_at) else {
        reset_state(state, cap, used, now);
        return true;
    };
    if window_changed(state, cap) {
        // A new weekly window began: start the books over (exact or not — the old share belongs
        // to last week and never seeds the new one).
        reset_state(state, cap, used, now);
        return true;
    }
    if state.exact {
        seed_from_exact(state, cap, used, now);
        return true;
    }
    apply_delta(state, cap, used, prev_used, prev_at);
    if cap.seven_day_resets_at.is_some() {
        state.window_resets_at = cap.seven_day_resets_at;
    }
    state.last_captured_at = Some(cap.captured_at);
    state.last_used_pct = Some(used);
    state.updated_at = Some(now);
    true
}

/// How much of the observed window we actually attributed, 0.0-1.0. `samples` counts DELTAS and says
/// nothing about how much of the window they covered, which is the difference between "Fable is
/// quiet" and "we barely saw this window".
pub(super) fn coverage(state: &Attrib) -> f64 {
    let attributed = state.fable_pct + state.other_pct;
    let observed = attributed + state.unknown_pct;
    if observed <= 0.0 {
        return 0.0; // nothing observed yet — not "fully covered"
    }
    attributed / observed
}

/// The estimate to expose: exact value when the payload had one, else the attributed Fable share once
/// there are enough samples AND they cover enough of the window, else `None`.
///
/// The coverage half exists because the sample count alone lied (HED-136). Measured live on
/// 2026-08-17: an account showed `samples: 3` with 40 of its 43 weekly points unattributed, so the
/// old `samples >= MIN_SAMPLES` gate returned `Some(0.0)` — which HED-76's soft cap reads as "Fable
/// is quiet" when the truth was "we accounted for 7% of this window". A router that cannot see its
/// input must be told that, not handed a reassuring zero: `None` means unknown, and the caller is
/// expected to treat unknown conservatively rather than as all-clear.
pub(super) fn estimate(state: &Attrib) -> Option<f64> {
    if state.exact {
        return Some(state.fable_pct);
    }
    (state.samples >= MIN_SAMPLES && coverage(state) >= MIN_COVERAGE).then_some(state.fable_pct)
}

/// The `detail` breakdown for the drawer tooltip / router.
pub(super) fn detail(state: &Attrib) -> Value {
    serde_json::json!({
        "fablePct": state.fable_pct,
        "otherPct": state.other_pct,
        "unknownPct": state.unknown_pct,
        "samples": state.samples,
        "exact": state.exact,
        "minSamples": MIN_SAMPLES,
        // Surfaced so a consumer can see WHY an estimate is absent: too few samples, or samples that
        // covered too little of the window. Without this, "no estimate" is indistinguishable from a bug.
        "coverage": coverage(state),
        "minCoverage": MIN_COVERAGE,
        "windowResetsAt": state.window_resets_at,
        "lastCapturedAt": state.last_captured_at,
        "updatedAt": state.updated_at,
    })
}

#[cfg(test)]
#[path = "fable_attrib_tests.rs"]
mod tests;
