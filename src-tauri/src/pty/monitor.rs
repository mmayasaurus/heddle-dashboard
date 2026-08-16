//! Session-status monitoring that extracts structured bell, terminal-title, and OSC notification signals
//! from the PTY byte stream.
//!
//! Signals carry no semantic interpretation; the frontend combines them into final state:
//! - `Bell`: a terminal bell, commonly emitted when Claude or Codex finishes or needs confirmation.
//! - `Title`: a terminal title set through OSC, where some CLIs expose state.
//! - `Notify`: OSC 9 or OSC 777 notifications, a fallback for sessions without authoritative hooks.

/// One signal scanned from the output stream.
pub enum ScanEvent {
    /// A standalone bell character, not an OSC string terminator.
    Bell,
    /// Terminal title text set by OSC 0, 1, or 2.
    Title(String),
    /// OSC 9/777 notification with an optional title and a body. OSC 9 has no title.
    Notify { title: Option<String>, body: String },
}

/// Incremental output scanner that preserves ANSI/OSC parsing state across chunks.
///
/// Recognizes standalone BEL, OSC title sequences (`ESC ] {0,1,2} ; text (BEL|ESC \\)`), and OSC
/// notifications (iTerm2 OSC 9 and OSC 777 `notify;title;body`). Other escape sequences are skipped.
#[derive(Default)]
pub struct OutputScanner {
    /// Saw ESC and awaits the next byte to determine whether OSC begins.
    esc_pending: bool,
    /// Currently inside an OSC string.
    in_osc: bool,
    /// Saw ESC inside OSC and awaits `\\`, the ST terminator.
    osc_esc_pending: bool,
    /// Length-limited OSC text buffer, including the numeric prefix and semicolon.
    osc_buf: Vec<u8>,
}

/// OSC buffer limit; discard oversized malformed streams to bound memory use.
const OSC_MAX: usize = 512;

impl OutputScanner {
    /// Feed a byte chunk and invoke `emit` for every scanned signal.
    pub fn feed(&mut self, bytes: &[u8], mut emit: impl FnMut(ScanEvent)) {
        for &b in bytes {
            if self.in_osc {
                if b == 0x07 {
                    // BEL terminates OSC.
                    self.finish_osc(&mut emit);
                } else if self.osc_esc_pending {
                    // ESC \ is the ST terminator.
                    self.osc_esc_pending = false;
                    if b == b'\\' {
                        self.finish_osc(&mut emit);
                    }
                } else if b == 0x1b {
                    self.osc_esc_pending = true;
                } else if self.osc_buf.len() < OSC_MAX {
                    self.osc_buf.push(b);
                }
                continue;
            }

            if self.esc_pending {
                self.esc_pending = false;
                if b == b']' {
                    self.in_osc = true;
                    self.osc_buf.clear();
                }
                // Ignore other escape sequences such as CSI.
                continue;
            }

            match b {
                0x1b => self.esc_pending = true,
                0x07 => emit(ScanEvent::Bell), // Standalone bell becomes an attention signal.
                _ => {}
            }
        }
    }

    fn finish_osc(&mut self, emit: &mut impl FnMut(ScanEvent)) {
        self.in_osc = false;
        self.osc_esc_pending = false;
        // Split `<code>;<content>` at the first semicolon, then dispatch by code.
        if let Some(pos) = self.osc_buf.iter().position(|&c| c == b';') {
            let (code, rest) = self.osc_buf.split_at(pos);
            let rest = &rest[1..]; // Skip the semicolon and retain content.
            match code {
                // OSC 0/1/2 sets the window or icon title.
                b"0" | b"1" | b"2" => {
                    let title = String::from_utf8_lossy(rest).trim().to_string();
                    if !title.is_empty() {
                        emit(ScanEvent::Title(title));
                    }
                }
                // OSC 9 is an untitled iTerm2 notification whose content is the body. Exclude
                // ConEmu/Windows Terminal numeric subcommands such as progress and cwd updates.
                b"9" => {
                    if !starts_with_numeric_subcommand(rest) {
                        let body = String::from_utf8_lossy(rest).trim().to_string();
                        if !body.is_empty() {
                            emit(ScanEvent::Notify { title: None, body });
                        }
                    }
                }
                // OSC 777 urxvt/Ghostty notifications use `notify;<title>;<body>`. Ignore other actions.
                b"777" => {
                    if let Some((title, body)) = parse_osc777(rest) {
                        if !body.is_empty() {
                            emit(ScanEvent::Notify { title, body });
                        }
                    }
                }
                _ => {}
            }
        }
        self.osc_buf.clear();
    }
}

/// Whether OSC 9 content begins with one or more ASCII digits followed by a semicolon.
///
/// This identifies ConEmu/Windows Terminal extensions rather than iTerm2 notifications. Human-readable
/// bodies rarely start with `digits;`, making shape-based exclusion more robust than fixed command IDs.
fn starts_with_numeric_subcommand(rest: &[u8]) -> bool {
    let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
    // Require at least one digit followed immediately by a semicolon.
    digits > 0 && rest.get(digits) == Some(&b';')
}

/// Parse OSC 777 content shaped as `notify;<title>;<body>`.
///
/// Require the `notify` action, take the second segment as title, and preserve later semicolons by
/// splitting only twice. Return None for a missing body and represent an empty title as None.
fn parse_osc777(rest: &[u8]) -> Option<(Option<String>, String)> {
    let s = String::from_utf8_lossy(rest);
    let mut parts = s.splitn(3, ';');
    if parts.next()? != "notify" {
        return None;
    }
    let title = parts.next()?.trim();
    let body = parts.next()?.trim();
    let title = if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    };
    Some((title, body.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Collect all events from a byte slice: bell count, titles, and `(title, body)` notifications.
    fn scan_all(bytes: &[u8]) -> (usize, Vec<String>, Vec<(Option<String>, String)>) {
        let mut sc = OutputScanner::default();
        let mut bells = 0;
        let mut titles = Vec::new();
        let mut notifies = Vec::new();
        sc.feed(bytes, |ev| match ev {
            ScanEvent::Bell => bells += 1,
            ScanEvent::Title(t) => titles.push(t),
            ScanEvent::Notify { title, body } => notifies.push((title, body)),
        });
        (bells, titles, notifies)
    }

    /// Return only bell count and titles for older tests concerned with those signal types.
    fn scan(bytes: &[u8]) -> (usize, Vec<String>) {
        let (bells, titles, _) = scan_all(bytes);
        (bells, titles)
    }

    #[test]
    fn standalone_bell_is_attention() {
        let (bells, titles) = scan(b"hello\x07world");
        assert_eq!(bells, 1);
        assert!(titles.is_empty());
    }

    #[test]
    fn osc_title_bel_terminated_is_not_a_bell() {
        // In `ESC ] 0 ; my title BEL`, BEL terminates OSC and is not a standalone bell.
        let (bells, titles) = scan(b"\x1b]0;my title\x07rest");
        assert_eq!(
            bells, 0,
            "a BEL that terminates an OSC must not count as a bell"
        );
        assert_eq!(titles, vec!["my title".to_string()]);
    }

    #[test]
    fn osc_title_st_terminated() {
        // `ESC ] 2 ; foo ESC \` uses ST termination.
        let (bells, titles) = scan(b"\x1b]2;foo\x1b\\bar");
        assert_eq!(bells, 0);
        assert_eq!(titles, vec!["foo".to_string()]);
    }

    #[test]
    fn osc_then_real_bell() {
        let (bells, titles) = scan(b"\x1b]0;t\x07ok\x07");
        assert_eq!(
            bells, 1,
            "a standalone BEL after an OSC does count as a bell"
        );
        assert_eq!(titles, vec!["t".to_string()]);
    }

    #[test]
    fn split_across_chunks() {
        // An OSC split across feeds still produces the complete title.
        let mut sc = OutputScanner::default();
        let mut titles = Vec::new();
        let mut sink = |ev: ScanEvent| {
            if let ScanEvent::Title(t) = ev {
                titles.push(t);
            }
        };
        sc.feed(b"\x1b]0;hel", &mut sink);
        sc.feed(b"lo\x07", &mut sink);
        assert_eq!(titles, vec!["hello".to_string()]);
    }

    #[test]
    fn csi_color_sequences_ignored() {
        // Ordinary colored output produces no signals.
        let (bells, titles) = scan(b"\x1b[31mred\x1b[0m text");
        assert_eq!(bells, 0);
        assert!(titles.is_empty());
    }

    #[test]
    fn osc9_notification_body() {
        // OSC 9 content is an untitled iTerm2 body, not a bell or title.
        let (bells, titles, notifies) = scan_all(b"\x1b]9;Build finished\x07");
        assert_eq!(bells, 0);
        assert!(titles.is_empty());
        assert_eq!(notifies, vec![(None, "Build finished".to_string())]);
    }

    #[test]
    fn osc9_conemu_progress_ignored() {
        // Ignore ConEmu/Windows Terminal progress extension `OSC 9 ; 4 ; <state> ; <progress>`.
        let (_, _, progress) = scan_all(b"\x1b]9;4;1;50\x07");
        assert!(
            progress.is_empty(),
            "the ConEmu progress subcommand must not raise a notification"
        );
        // Ignore other numeric subcommands such as cwd hint `9;9;<path>`.
        let (_, _, cwd) = scan_all(b"\x1b]9;9;/home/user\x07");
        assert!(
            cwd.is_empty(),
            "the ConEmu cwd subcommand must not raise a notification"
        );
        // A body beginning with digits but no following semicolon remains a normal notification.
        let (_, _, real) = scan_all(b"\x1b]9;5 tests passed\x07");
        assert_eq!(real, vec![(None, "5 tests passed".to_string())]);
    }

    #[test]
    fn osc777_title_and_body() {
        // OSC 777 notify splits its action, title, and body.
        let (bells, titles, notifies) = scan_all(b"\x1b]777;notify;Greeting;Hello there\x07");
        assert_eq!(bells, 0);
        assert!(titles.is_empty());
        assert_eq!(
            notifies,
            vec![(Some("Greeting".to_string()), "Hello there".to_string())]
        );
    }

    #[test]
    fn osc777_body_may_contain_semicolons() {
        // Semicolons inside the body remain intact after the first two splits.
        let (_, _, notifies) = scan_all(b"\x1b]777;notify;Title;a;b;c\x07");
        assert_eq!(
            notifies,
            vec![(Some("Title".to_string()), "a;b;c".to_string())]
        );
    }

    #[test]
    fn osc777_non_notify_action_ignored() {
        // Ignore uncommon OSC 777 actions other than notify.
        let (_, _, notifies) = scan_all(b"\x1b]777;cmd;something\x07");
        assert!(notifies.is_empty());
    }

    #[test]
    fn osc_notify_st_terminated() {
        // ST termination works like BEL termination.
        let (_, _, n9) = scan_all(b"\x1b]9;done\x1b\\");
        assert_eq!(n9, vec![(None, "done".to_string())]);
        let (_, _, n777) = scan_all(b"\x1b]777;notify;T;B\x1b\\");
        assert_eq!(n777, vec![(Some("T".to_string()), "B".to_string())]);
    }

    #[test]
    fn osc9_notify_split_across_chunks() {
        // A notification split across chunks is reconstructed exactly.
        let mut sc = OutputScanner::default();
        let mut notifies = Vec::new();
        let mut sink = |ev: ScanEvent| {
            if let ScanEvent::Notify { title, body } = ev {
                notifies.push((title, body));
            }
        };
        sc.feed(b"\x1b]9;Build ", &mut sink);
        sc.feed(b"passed\x07", &mut sink);
        assert_eq!(notifies, vec![(None, "Build passed".to_string())]);
    }

    #[test]
    fn osc_titles_unaffected_by_notify_parsing() {
        // Notification parsing does not alter OSC 0/1/2 title behavior.
        let (_, titles, notifies) = scan_all(b"\x1b]0;window title\x07\x1b]2;icon\x07");
        assert_eq!(titles, vec!["window title".to_string(), "icon".to_string()]);
        assert!(notifies.is_empty());
    }

    #[test]
    fn osc_notify_empty_body_ignored() {
        // Empty OSC 9 bodies and OSC 777 messages without a body do not notify.
        let (_, _, n9) = scan_all(b"\x1b]9;\x07");
        assert!(n9.is_empty());
        let (_, _, n777) = scan_all(b"\x1b]777;notify;OnlyTitle\x07");
        assert!(
            n777.is_empty(),
            "an OSC 777 without a body must not raise a notification"
        );
    }
}
