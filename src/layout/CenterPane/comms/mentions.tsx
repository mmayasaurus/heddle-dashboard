//! @mention highlighting for chatroom message bodies (HED-130). `@all` / `@orchestrator` / agent
//! and child addresses get a subtle visual mark so the operator can see at a glance who a message
//! is addressed to.
//!
//! SECURITY (do not weaken): message bodies are attacker-influenced text — any agent can post
//! anything. `splitMentions` only ever slices the input into plain-text segments; `MentionText`
//! turns those segments into React elements whose text is always passed as a JSX child (React
//! escapes it automatically) — exactly like Transcript's previous bare `{m.body}` rendering, just
//! split into more than one text node. Never dangerouslySetInnerHTML, never a markdown/HTML
//! renderer, never innerHTML. mentions.test.tsx asserts a body containing `<img onerror=...>`
//! still renders as inert literal text with no element created from it.
//!
//! DESIGN — capture-then-predicate, not shape-enumeration. The prior regex enumerated mention
//! *shapes* as ordered alternatives, which shadows any longer id that starts like a shorter one:
//! `@all-hands` matched only `@all` (which MEANS broadcast — actively misleading), `@operator-x`
//! matched only `@operator`, and `@claude-sonnet-4` partial-matched to `@claude-sonnet`. That was
//! the 4th regression in that one regex. This file no longer enumerates shapes: `AT_TOKEN` below
//! captures the FULL `@`-token — any run shaped like address.ts's own `AGENT_RE`, plus an optional
//! `.child` suffix — with no alternation to shadow. A separate pure predicate, `isAgentMention`,
//! then decides whether that whole captured id is a mention worth highlighting. Widening what
//! counts as a mention is now a one-line predicate change, never a regex-shape edit that can
//! shadow a differently-shaped id again.
//!
//! GRAMMAR — grounded in the broker's own parser, ~/Developer/heddle/src/comms/address.ts (read,
//! not guessed):
//!   BROADCAST = '@all'                            — literal; address.ts's own broadcast address.
//!   OPERATOR  = 'operator'                         — the human's address, address.ts's own. Note
//!     this is "operator", not "orchestrator" — address.ts has no "orchestrator" address kind at
//!     all. `@orchestrator` is a comms-protocol convention for "reach my dispatcher" used
//!     constantly in fleet chat, so it is highlighted here on explicit request, but it does not
//!     round-trip through address.ts's parseAddress().
//!   AGENT_RE  = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/  — real broker agent ids allow mixed case,
//!     digit-only, and hyphenated ids ("codex-B" and "3" are address.ts's own docstring examples).
//!     `AT_TOKEN` captures this full shape unconditionally; `isAgentMention` then highlights the
//!     capture when its base id is `all`/`operator`/`orchestrator`, a single UPPERCASE letter
//!     (`@T`), all-digit (`@3`), or contains a hyphen anywhere (`@codex-B`, `@all-hands`) — a
//!     hyphen or digit is what marks an identifier, but note the real rule is narrower than "has a
//!     digit": `@T1` has a digit yet is NOT a mention, because it is neither a lone uppercase
//!     letter nor all-digit nor hyphenated — just an ordinary mixed word. A bare capitalised word
//!     after a stray "@" (`@Kubernetes`) is likewise not a mention. `splitMentions` keeps
//!     `AT_TOKEN` out of email addresses (`user@codex-B.com`, `café@codex-B.com`, `用户@T`) by
//!     checking the character immediately before the `@` against `LEFT_BOUNDARY_CHAR` in code — a
//!     regex lookbehind is deliberately avoided: it reaches the WebView untransformed and older
//!     WKWebView (< Safari 16.4) would throw a syntax error, whereas a `\p{…}` character class is
//!     supported far earlier.
//!   CHILD_RE  = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.([1-9][0-9]{0,8})$/ — a child's sequence
//!     number is a positive integer with no leading zero, one level deep only (`K.1.1` is not an
//!     address). `AT_TOKEN`'s optional `.child` suffix mirrors that digit grammar exactly, not a
//!     loose `\d+`; `isAgentMention` decides on the BASE id (before the `.child`), so `@codex-B.2`
//!     is a mention because `codex-B` is, independent of the suffix.

import { Fragment } from "react";

// Capture the whole @-token: an AGENT_RE-shaped id (address.ts: [A-Za-z0-9][A-Za-z0-9_-]{0,63})
// plus an optional .child suffix. The LEFT boundary is checked in splitMentions against the
// preceding character (LEFT_BOUNDARY_CHAR) rather than a regex lookbehind: a `(?<!…)` lookbehind
// reaches the Tauri WebView untransformed (tsc does not rewrite regex — same trap as `.at()`), and
// WKWebView only gained lookbehind in Safari 16.4, so on an older macOS WebView it would be a
// SYNTAX ERROR that blanks the whole bundle. Unicode property escapes in a plain character class
// (below) are supported far earlier (Safari 11.1), so LEFT_BOUNDARY_CHAR is safe where a lookbehind
// is not.
const AT_TOKEN = /@([A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\.[1-9][0-9]{0,8})?)/g;

// A char that, immediately before an @-token, means it is glued to an identifier/email local part
// (`user@…`, `café@…`, `用户@…`) and so must NOT be treated as a mention. Unicode letters/digits
// included — a non-ASCII letter right before @ must block it just like an ASCII one.
const LEFT_BOUNDARY_CHAR = /[\p{L}\p{N}._%+-]/u;

/** Is the captured id (the part after @, possibly with a .child) a mention we highlight, vs an
 *  ordinary word after a stray @ (`@Kubernetes`)? Decided on the BASE (before any .child):
 *   - the literals all / operator / orchestrator (broadcast, the human, the routing convention);
 *   - a single UPPERCASE letter (`@T`); an all-digit id (`@3`); or any id containing a hyphen
 *     (`@codex-B`, `@all-hands`, `@claude-sonnet-4`) — a hyphen or digit is what distinguishes an
 *     identifier from prose. Everything else (a bare word) is not a mention. */
function isAgentMention(id: string): boolean {
  const base = id.split(".")[0];
  return (
    base === "all" || base === "operator" || base === "orchestrator" ||
    /^[A-Z]$/.test(base) || /^[0-9]+$/.test(base) || base.includes("-")
  );
}

export interface MentionSegment {
  text: string;
  mention: boolean;
}

/**
 * Split `body` into alternating plain-text / mention segments, in order. Never loses or reorders
 * characters: `splitMentions(x).map(s => s.text).join("") === x` holds for any input.
 */
export function splitMentions(body: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let cursor = 0;
  AT_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AT_TOKEN.exec(body)) !== null) {
    if (match.index > cursor) {
      segments.push({ text: body.slice(cursor, match.index), mention: false });
    }
    // Glued to a preceding identifier/letter/digit (an email local part, a longer word) → plain
    // text, never a mention. This replaces the removed lookbehind; the text is still emitted in
    // order so the round-trip invariant holds either way.
    const gluedLeft = match.index > 0 && LEFT_BOUNDARY_CHAR.test(body[match.index - 1]);
    segments.push({ text: match[0], mention: isAgentMention(match[1]) && !gluedLeft });
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) {
    segments.push({ text: body.slice(cursor), mention: false });
  }
  return segments;
}

export interface MentionTextProps {
  body: string;
}

/** Renders `body` as plain text with `@mention` segments wrapped in `.comms-mention` spans. Built
 *  entirely from `splitMentions`'s plain-text segments passed as JSX children — never HTML,
 *  markdown, or dangerouslySetInnerHTML. */
export function MentionText({ body }: MentionTextProps) {
  return (
    <>
      {splitMentions(body).map((seg, i) =>
        seg.mention ? (
          <span key={i} className="comms-mention" data-testid="comms-mention">
            {seg.text}
          </span>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}
