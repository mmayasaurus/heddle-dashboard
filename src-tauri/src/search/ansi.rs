//! Strip ANSI recording bytes into visible text lines for full-text indexing.
//!
//! A dependency-free state machine modeled after ModeTracker/OutputScanner consumes CSI; OSC/DCS/APC/
//! PM/SOS strings through BEL/ST; and character-set/intermediate escapes. Printable bytes overwrite or
//! append at the cursor column. Carriage return resets the column for spinner redraws, backspace moves
//! left, and newline completes a line. It targets searchable text rather than exact screen emulation;
//! agent full-screen TUIs use transcript indexing instead.

/// Parse raw terminal bytes into visible lines, invoking a callback per line and supporting chunked streaming.
pub struct AnsiStripper {
    state: StripState,
    /// Visible bytes in the current line, overwritten/appended at the cursor column.
    line: Vec<u8>,
    /// Cursor column for writing.
    col: usize,
}

enum StripState {
    /// Normal text.
    Ground,
    /// ESC received; await the next byte to select a sequence type.
    Esc,
    /// Inside CSI (`ESC [`), consuming through a final byte in 0x40..=0x7e.
    Csi,
    /// Escape with one intermediate/final byte, such as `ESC ( B`; consume one more byte.
    EscIntermediate,
    /// Inside an OSC/DCS/APC/PM/SOS string awaiting BEL or `ESC \` termination.
    StringSeq { esc_pending: bool },
}

impl AnsiStripper {
    pub fn new() -> Self {
        Self {
            state: StripState::Ground,
            line: Vec::new(),
            col: 0,
        }
    }

    /// Feed bytes and invoke `on_line` for every completed line.
    pub fn feed(&mut self, bytes: &[u8], on_line: &mut impl FnMut(&str)) {
        for &b in bytes {
            self.state = match std::mem::replace(&mut self.state, StripState::Ground) {
                StripState::Ground => {
                    self.ground(b, on_line);
                    // ground() selects Esc for ESC and otherwise remains Ground.
                    if b == 0x1b {
                        StripState::Esc
                    } else {
                        StripState::Ground
                    }
                }
                StripState::Esc => match b {
                    b'[' => StripState::Csi,
                    b']' | b'P' | b'_' | b'^' | b'X' => {
                        StripState::StringSeq { esc_pending: false }
                    }
                    // Character-set and other intermediate introducers consume one more byte.
                    b'(' | b')' | b'*' | b'+' | b'-' | b'.' | b'/' | b' ' | b'#' | b'%' => {
                        StripState::EscIntermediate
                    }
                    0x1b => StripState::Esc,
                    // Consume single-byte ESC sequences such as ESC M, 7, 8, or =.
                    _ => StripState::Ground,
                },
                StripState::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        StripState::Ground
                    } else {
                        StripState::Csi
                    }
                }
                StripState::EscIntermediate => StripState::Ground,
                StripState::StringSeq { esc_pending } => {
                    if esc_pending {
                        if b == b'\\' {
                            StripState::Ground
                        } else {
                            StripState::StringSeq {
                                esc_pending: b == 0x1b,
                            }
                        }
                    } else if b == 0x07 {
                        StripState::Ground
                    } else {
                        StripState::StringSeq {
                            esc_pending: b == 0x1b,
                        }
                    }
                }
            };
        }
    }

    /// Handle one byte in Ground state; feed centralizes ESC state transitions.
    fn ground(&mut self, b: u8, on_line: &mut impl FnMut(&str)) {
        match b {
            0x1b => {} // feed handles the ESC transition.
            b'\n' => self.flush_line(on_line),
            b'\r' => self.col = 0,
            0x08 => self.col = self.col.saturating_sub(1), // Backspace.
            b'\t' => self.put(b' '), // Approximate tabs as one space for search.
            _ if b < 0x20 => {}      // Ignore other controls, including BEL.
            _ => self.put(b),
        }
    }

    /// Write a visible byte at the cursor, overwriting/appending, then advance.
    fn put(&mut self, b: u8) {
        if self.col < self.line.len() {
            self.line[self.col] = b;
        } else {
            while self.line.len() < self.col {
                self.line.push(b' ');
            }
            self.line.push(b);
        }
        self.col += 1;
    }

    /// Complete the current line, invoke the callback, and clear the buffer.
    fn flush_line(&mut self, on_line: &mut impl FnMut(&str)) {
        let s = String::from_utf8_lossy(&self.line).into_owned();
        on_line(&s);
        self.line.clear();
        self.col = 0;
    }

    /// Flush a final unterminated line. Incremental indexing must not call this because a partial tail
    /// may continue later; use it only when rebuilding a completed recording.
    pub fn finish(&mut self, on_line: &mut impl FnMut(&str)) {
        if !self.line.is_empty() {
            self.flush_line(on_line);
        }
    }
}

/// Strip a complete byte slice into visible lines, including its unterminated tail.
pub fn strip_to_lines(bytes: &[u8]) -> Vec<String> {
    let mut lines = Vec::new();
    let mut st = AnsiStripper::new();
    {
        let mut push = |l: &str| lines.push(l.to_string());
        st.feed(bytes, &mut push);
        st.finish(&mut push);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feed possibly chunked bytes and collect visible lines, including the final tail.
    fn strip_lines(chunks: &[&[u8]]) -> Vec<String> {
        let mut lines = Vec::new();
        let mut st = AnsiStripper::new();
        {
            let mut push = |l: &str| lines.push(l.to_string());
            for c in chunks {
                st.feed(c, &mut push);
            }
            st.finish(&mut push);
        }
        lines
    }

    /// Consume SGR colors and cursor CSI, leaving visible text only.
    #[test]
    fn strip_removes_sgr_and_cursor_csi() {
        let lines = strip_lines(&[b"\x1b[31mred\x1b[0m \x1b[2Knormal\n"]);
        assert_eq!(lines, vec!["red normal".to_string()]);
    }

    /// Consume OSC title sequences terminated by either BEL or ST without leaking text.
    #[test]
    fn strip_removes_osc_title() {
        let bel = strip_lines(&[b"\x1b]0;my window title\x07hello\n"]);
        assert_eq!(bel, vec!["hello".to_string()]);
        let st = strip_lines(&[b"\x1b]2;t\x1b\\world\n"]);
        assert_eq!(st, vec!["world".to_string()]);
    }

    /// Character-set selection `ESC ( B` must not leak `B` into text.
    #[test]
    fn strip_removes_charset_selection() {
        let lines = strip_lines(&[b"\x1b(Bplain\n"]);
        assert_eq!(lines, vec!["plain".to_string()]);
    }

    /// Carriage-return redraw preserves the final spinner frame.
    #[test]
    fn strip_carriage_return_overwrites_line() {
        let lines = strip_lines(&[b"loading...\rdone!\n"]);
        // `done!` overwrites the first five characters of `loading...`, leaving `done!ng...`; the key
        // property is searchable `done` and overwrite semantics.
        assert_eq!(lines, vec!["done!ng...".to_string()]);
        // CRLF retains content: carriage return moves the cursor and newline completes the line.
        let crlf = strip_lines(&[b"keep this\r\n"]);
        assert_eq!(crlf, vec!["keep this".to_string()]);
    }

    /// Escape sequences split across chunks remain fully consumed.
    #[test]
    fn strip_handles_split_across_chunks() {
        // Split `ESC [ 3`/`1m` and OSC across chunks.
        let lines = strip_lines(&[b"\x1b[3", b"1mhi\x1b]0;ti", b"tle\x07 there\n"]);
        assert_eq!(lines, vec!["hi there".to_string()]);
    }

    /// strip_to_lines processes a complete slice including an unterminated tail.
    #[test]
    fn strip_to_lines_keeps_trailing_partial() {
        let lines = strip_to_lines(b"first\nsecond no newline");
        assert_eq!(
            lines,
            vec!["first".to_string(), "second no newline".to_string()]
        );
    }

    /// Incremental feed retains the partial tail until a later newline, unlike finish.
    #[test]
    fn feed_without_finish_holds_partial_line() {
        let mut out = Vec::new();
        let mut st = AnsiStripper::new();
        {
            let mut push = |l: &str| out.push(l.to_string());
            st.feed(b"complete\npartial", &mut push);
        }
        assert_eq!(out, vec!["complete".to_string()]); // The partial tail is not emitted.
    }
}
