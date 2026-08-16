//! Behavioral tests for the route-mix aggregate (see TESTING-BAR.md): every assertion is a
//! number a user reads off the scoreboard, and each test names the regression it would catch.
    use super::*;

    /// Fixture DB with the heddle-core ledger schema (the columns this module reads).
    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE dispatches (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               orchestrator TEXT, task_class TEXT NOT NULL, provider TEXT NOT NULL,
               model TEXT NOT NULL, skills TEXT, issue TEXT, pr INTEGER,
               cwd TEXT NOT NULL DEFAULT '', prompt_preview TEXT NOT NULL DEFAULT '',
               session_id TEXT, ok INTEGER NOT NULL DEFAULT 0, error TEXT,
               input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER,
               reasoning_tokens INTEGER, duration_ms INTEGER, fell_back_from TEXT,
               started_at TEXT NOT NULL, finished_at TEXT)",
        )
        .unwrap();
        conn
    }

    fn insert(
        conn: &Connection, orch: Option<&str>, provider: &str, ok: i64,
        input: Option<i64>, output: Option<i64>, started_at: &str,
    ) {
        conn.execute(
            "INSERT INTO dispatches (orchestrator, task_class, provider, model, ok,
                                     input_tokens, output_tokens, started_at)
             VALUES (?1, 'implementation', ?2, 'm', ?3, ?4, ?5, ?6)",
            rusqlite::params![orch, provider, ok, input, output, started_at],
        )
        .unwrap();
    }

    /// Rows land in the right UTC hour buckets, split per provider, with NULL tokens counted as 0
    /// — the numbers a user reads off the scoreboard, not internals.
    #[test]
    fn buckets_by_hour_and_provider_with_null_tokens_as_zero() {
        let c = fixture();
        insert(&c, Some("T"), "codex", 1, Some(100), Some(10), "2026-08-16T01:05:00.000Z");
        insert(&c, Some("T"), "codex", 0, Some(50), None, "2026-08-16T01:59:59.999Z");
        insert(&c, Some("R"), "gemini", 1, None, Some(7), "2026-08-16T01:30:00.000Z");
        insert(&c, Some("R"), "codex", 1, Some(1), Some(1), "2026-08-16T02:00:00.000Z");
        let mix = route_mix_from(&c, 6, "2026-08-16T00:00:00.000Z").unwrap();
        assert_eq!(mix.hours.len(), 2);
        assert_eq!(mix.hours[0].hour, "2026-08-16T01");
        assert_eq!(
            mix.hours[0].providers,
            vec![
                ProviderHourTokens { provider: "codex".into(), dispatches: 2, input_tokens: 150, output_tokens: 10 },
                ProviderHourTokens { provider: "gemini".into(), dispatches: 1, input_tokens: 0, output_tokens: 7 },
            ]
        );
        assert_eq!(mix.hours[1].hour, "2026-08-16T02");
        assert_eq!(mix.hours[1].providers.len(), 1);
    }

    /// The window cutoff excludes older work: yesterday's dispatches must not inflate today's
    /// scoreboard.
    #[test]
    fn window_cutoff_excludes_older_rows() {
        let c = fixture();
        insert(&c, Some("T"), "codex", 1, Some(999), Some(999), "2026-08-15T10:00:00.000Z");
        insert(&c, Some("T"), "codex", 1, Some(5), Some(5), "2026-08-16T01:00:00.000Z");
        let mix = route_mix_from(&c, 6, "2026-08-16T00:00:00.000Z").unwrap();
        assert_eq!(mix.hours.len(), 1);
        assert_eq!(mix.hours[0].providers[0].input_tokens, 5);
        assert_eq!(mix.orchestrators, vec![OrchestratorCount { orchestrator: "T".into(), dispatches: 1, succeeded: 1 }]);
    }

    /// TEST-orchestrator verification dispatches never reach either aggregate — counting them
    /// would overstate delegation (the drawer's recent list already hides them).
    #[test]
    fn test_orchestrator_rows_are_excluded_everywhere() {
        let c = fixture();
        insert(&c, Some("TEST"), "codex", 1, Some(1000), Some(1000), "2026-08-16T01:00:00.000Z");
        insert(&c, Some("T"), "cursor", 1, Some(3), Some(4), "2026-08-16T01:10:00.000Z");
        let mix = route_mix_from(&c, 6, "2026-08-16T00:00:00.000Z").unwrap();
        assert_eq!(mix.hours.len(), 1);
        assert_eq!(mix.hours[0].providers, vec![ProviderHourTokens {
            provider: "cursor".into(), dispatches: 1, input_tokens: 3, output_tokens: 4 }]);
        assert_eq!(mix.orchestrators.len(), 1);
        assert_eq!(mix.orchestrators[0].orchestrator, "T");
    }

    /// NULL orchestrators still count (as "?") — silently dropping them would hide undisciplined
    /// dispatches, the opposite of what this scoreboard is for.
    #[test]
    fn null_orchestrator_counts_as_question_mark() {
        let c = fixture();
        insert(&c, None, "codex", 0, Some(1), Some(1), "2026-08-16T01:00:00.000Z");
        insert(&c, Some("V"), "codex", 1, Some(1), Some(1), "2026-08-16T01:01:00.000Z");
        let mix = route_mix_from(&c, 6, "2026-08-16T00:00:00.000Z").unwrap();
        let names: Vec<_> = mix.orchestrators.iter().map(|o| o.orchestrator.as_str()).collect();
        assert!(names.contains(&"?") && names.contains(&"V"));
        let q = mix.orchestrators.iter().find(|o| o.orchestrator == "?").unwrap();
        assert_eq!((q.dispatches, q.succeeded), (1, 0));
    }

    /// Empty ledger ⇒ empty scoreboard, not an error — the drawer degrades gracefully.
    #[test]
    fn empty_ledger_yields_empty_mix() {
        let c = fixture();
        let mix = route_mix_from(&c, 6, "2026-08-16T00:00:00.000Z").unwrap();
        assert!(mix.hours.is_empty() && mix.orchestrators.is_empty());
        assert_eq!(mix.window_hours, 6);
    }

    /// The chrono-free epoch→ISO helper matches known timestamps (leap year + midnight edges) —
    /// a wrong cutoff silently shifts every bucket.
    #[test]
    fn epoch_to_iso_matches_known_values() {
        assert_eq!(epoch_to_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(epoch_to_iso(1_786_838_400), "2026-08-16T00:00:00.000Z");
        assert_eq!(epoch_to_iso(1_709_164_799), "2024-02-28T23:59:59.000Z");
        assert_eq!(epoch_to_iso(1_709_164_800), "2024-02-29T00:00:00.000Z");
    }
