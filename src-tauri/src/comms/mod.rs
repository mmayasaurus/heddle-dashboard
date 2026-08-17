//! Fleet chatroom panel: read path + write path (HED-74a/HED-74c).
//!
//! `~/.heddle/comms.db` is owned and written exclusively by heddle's Node broker
//! (`src/comms/log.ts`). [`reader`] only ever reads it directly — every connection it opens is
//! `SQLITE_OPEN_READ_ONLY` with `PRAGMA query_only = ON` on top, so it cannot write the log the
//! fleet depends on, even by accident.
//!
//! [`operator`] is the write path. It never touches `comms.db` directly either: every write
//! crosses the wire to the broker's `heddle-comms` MCP server over the official `rmcp` client SDK,
//! spawned and owned there under the OPERATOR role. The broker remains the only thing that ever
//! writes `comms.db` — this module writes to the broker's stdin, not to the database file.

pub mod operator;
pub mod reader;
