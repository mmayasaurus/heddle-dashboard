//! Regression tests for query-reply arbitration: blocked queries receive no reply, allowed ones do.
//!
//! A headless xterm is sufficient because parsing and query replies happen in the core and are
//! directly observable through `onData`. This preserves the key cross-client isolation invariant:
//! during mirroring or replay, this client must never write query replies into the shared PTY input.

import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";

import { installQueryReplyGuard } from "./queryReplyGuard";

/** Create a headless terminal with a mutable arbitration flag and an onData collector. */
function setup(withClipboard = false) {
  const term = new Terminal({ allowProposedApi: true });
  const clipboardWrites: string[] = [];
  let clipboardReads = 0;
  if (withClipboard) {
    const provider: IClipboardProvider = {
      readText: () => {
        clipboardReads += 1;
        return "";
      },
      writeText: (_sel, text) => {
        clipboardWrites.push(text);
      },
    };
    term.loadAddon(new ClipboardAddon(undefined, provider));
  }
  const flags = { swallowReplies: false, swallowClipboardWrites: false };
  installQueryReplyGuard(term, {
    swallowReplies: () => flags.swallowReplies,
    swallowClipboardWrites: () => flags.swallowClipboardWrites,
  });
  const replies: string[] = [];
  term.onData((d) => replies.push(d));
  const feed = (data: string) =>
    new Promise<void>((resolve) => term.write(data, resolve));
  return { term, flags, replies, feed, clipboardWrites, clipboardReads: () => clipboardReads };
}

describe("queryReplyGuard", () => {
  it("answers the core queries normally when allowed (owner-side semantics)", async () => {
    const { replies, feed } = setup();
    await feed("\x1b[c"); // DA1
    await feed("\x1b[6n"); // CPR
    await feed("\x1b[?2026$p"); // DECRQM
    expect(replies.join("")).toContain("c"); // DA1 reply: ESC[?1;2c
    expect(replies.some((r) => /\x1b\[\d+;\d+R/.test(r))).toBe(true); // CPR coordinates
    expect(replies.some((r) => r.includes("$y"))).toBe(true); // DECRPM
  });

  it("answers no query at all when swallowing (mirror-side and replay semantics)", async () => {
    const { flags, replies, feed } = setup();
    flags.swallowReplies = true;
    await feed("\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?6n\x1b[?2026$p\x1b[?2004$p");
    await feed("\x1bP$qm\x1b\\"); // DECRQSS(SGR)
    await feed("\x1b]10;?\x07\x1b]11;?\x07"); // OSC color queries
    expect(replies).toEqual([]);
  });

  it("the switch takes effect immediately in sequence: the same terminal swallows and then allows", async () => {
    const { flags, replies, feed } = setup();
    flags.swallowReplies = true;
    await feed("\x1b[6n");
    expect(replies).toEqual([]);
    flags.swallowReplies = false;
    await feed("\x1b[6n");
    expect(replies.length).toBe(1);
  });

  it("the set form of an OSC colour is unaffected and reaches the built-in handler, while the query form is swallowed", async () => {
    const { flags, replies, feed } = setup();
    flags.swallowReplies = true;
    // A set operation (without `?`) produces no reply or error and may reach the built-in handler.
    await feed("\x1b]4;1;rgb:ff/00/00\x07");
    // The query is blocked.
    await feed("\x1b]4;1;?\x07");
    expect(replies).toEqual([]);
  });

  it("OSC 52: read queries follow the reply arbitration, while writes are swallowed only during replay", async () => {
    const a = setup(true);
    // Normal owner mode: reads reply with an empty value (the provider hides the real clipboard),
    // while writes still take effect.
    await a.feed("\x1b]52;c;?\x07");
    expect(a.clipboardReads()).toBe(1);
    expect(a.replies.some((r) => r.startsWith("\x1b]52;"))).toBe(true);
    await a.feed("\x1b]52;c;aGVsbG8=\x07"); // "hello"
    expect(a.clipboardWrites).toEqual(["hello"]);

    // Mirror mode: reads receive no reply, but writes remain valid for local selection copying.
    const b = setup(true);
    b.flags.swallowReplies = true;
    await b.feed("\x1b]52;c;?\x07");
    expect(b.clipboardReads()).toBe(0);
    expect(b.replies).toEqual([]);
    await b.feed("\x1b]52;c;aGVsbG8=\x07");
    expect(b.clipboardWrites).toEqual(["hello"]);

    // During replay, writes are also blocked so historical copy sequences cannot replace the clipboard.
    const c = setup(true);
    c.flags.swallowReplies = true;
    c.flags.swallowClipboardWrites = true;
    await c.feed("\x1b]52;c;aGVsbG8=\x07");
    expect(c.clipboardWrites).toEqual([]);
  });
});
