//! Terminal query-reply arbitration for conditionally blocking xterm's automatic responses.
//!
//! xterm automatically answers application queries such as DA1/DA2, DSR/CPR, DECRQM, DECRQSS,
//! OSC 4/10/11/12 color queries, and OSC 52 clipboard reads. Replies return to PTY input through
//! onData. With one xterm attached per client:
//!
//! - Live queries receive N replies, and extras become unintended input that a TUI may parse as keys.
//! - During attach/reconnect replay, historical queries in the latest 512 KB are answered again,
//!   injecting stale coordinates and attributes into application stdin.
//!
//! Arbitration predicates allow only the size owner in fit mode to answer live queries. Mirror clients
//! and all clients during replay remain silent, yielding one reply per live query and none for replay.
//! OSC 52 writes are also blocked during replay so historical copy sequences cannot overwrite the
//! local clipboard; live writes remain valid for user-initiated copying.
//!
//! The public parser API registers handlers for the same identifiers. xterm invokes them in reverse
//! registration order; true consumes a sequence and false falls through to built-ins. Install this
//! guard after all addons and evaluate predicates for every sequence.

import type { Terminal } from "@xterm/xterm";

export interface QueryReplyGuardOptions {
  /** Whether to consume queries without replying: true for mirrors and for all clients during replay. */
  swallowReplies: () => boolean;
  /** Whether to consume OSC 52 clipboard writes during replay to protect the local clipboard. */
  swallowClipboardWrites: () => boolean;
}

/** Install query arbitration after addons such as ClipboardAddon and return an uninstall function. */
export function installQueryReplyGuard(
  term: Terminal,
  opts: QueryReplyGuardOptions,
): () => void {
  const disposables: { dispose(): void }[] = [];
  const swallow = () => opts.swallowReplies();

  // CSI queries: DA1/DA2, DSR/CPR, DEC private DSR, and ANSI/DEC DECRQM. These identifiers are
  // query-only, so consuming them does not alter rendering state.
  for (const id of [
    { final: "c" },
    { prefix: ">", final: "c" },
    { final: "n" },
    { prefix: "?", final: "n" },
    { intermediates: "$", final: "p" },
    { prefix: "?", intermediates: "$", final: "p" },
  ]) {
    disposables.push(term.parser.registerCsiHandler(id, swallow));
  }

  // DCS DECRQSS queries, including invalid requests for which xterm returns `DCS 0 ST`.
  disposables.push(
    term.parser.registerDcsHandler({ intermediates: "$", final: "q" }, swallow),
  );

  // Consume only `?` color queries. Allow setters so replayed palette changes still render correctly.
  for (const ident of [4, 10, 11, 12]) {
    disposables.push(
      term.parser.registerOscHandler(
        ident,
        (data) => data.includes("?") && opts.swallowReplies(),
      ),
    );
  }

  // Apply reply arbitration to OSC 52 `<sel>;?` reads and consume writes only during replay. Returning
  // false falls through to ClipboardAddon, which was loaded before this guard.
  disposables.push(
    term.parser.registerOscHandler(52, (data) => {
      const isRead = data.split(";")[1] === "?";
      return isRead ? opts.swallowReplies() : opts.swallowClipboardWrites();
    }),
  );

  return () => {
    for (const d of disposables) d.dispose();
  };
}
