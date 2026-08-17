//! Read-only comms.db reader for the fleet chatroom (HED-74a).
//!
//! `~/.heddle/comms.db` is owned and written exclusively by heddle's Node broker
//! (`src/comms/log.ts`). Everything under `comms::` only ever reads it — every connection
//! `reader.rs` opens is `SQLITE_OPEN_READ_ONLY` with `PRAGMA query_only = ON` on top, so this
//! module cannot write the log the fleet depends on, even by accident.

pub mod reader;
