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
//! GRAMMAR — grounded in the broker's own parser, ~/Developer/heddle/src/comms/address.ts (read,
//! not guessed):
//!   BROADCAST = '@all'                            — literal, matched as-is.
//!   OPERATOR  = 'operator'                         — the human's address. Note this is
//!     "operator", not "orchestrator" — address.ts has no "orchestrator" address kind at all.
//!     `@orchestrator` is a comms-protocol convention for "reach my dispatcher" used constantly in
//!     fleet chat, so it is highlighted here on explicit request, but it does not round-trip
//!     through address.ts's parseAddress().
//!   AGENT_RE  = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/  — real broker agent ids are far more
//!     permissive than what this file highlights: mixed case, digit-only, and hyphenated ids are
//!     all valid ("codex-B" and "3" are address.ts's own docstring examples). This file only
//!     highlights uppercase-FIRST single-letter tokens (`@T`, not `@t`, not `@codex-B`) because
//!     that matches this fleet's actual identity convention and avoids turning an ordinary
//!     capitalised word after a stray "@" into a highlighted mention.
//!   CHILD_RE  = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.([1-9][0-9]{0,8})$/ — a child's sequence
//!     number is a positive integer with no leading zero, one level deep only (`K.1.1` is not an
//!     address). The mention regex mirrors that digit grammar exactly, not a loose `\d+`.

import { Fragment } from "react";

/** `@`-prefixed mention token. Three families, deliberately narrower than address.ts's full
 *  `AGENT_RE` charset so an ordinary capitalised word after a stray "@" (`@Kubernetes`) is not
 *  swallowed as a mention:
 *
 *   - the literals `@all` (address.ts BROADCAST), `@operator` (address.ts OPERATOR — the human
 *     at the keyboard, and the single most important thing to notice being mentioned) and
 *     `@orchestrator` (a live routing convention in the comms tooling rather than an address.ts
 *     grammar element — it never round-trips through parseAddress);
 *   - a single-uppercase-letter agent with an optional child suffix (`@T`, `@K.1`);
 *   - a hyphenated or numeric id (`@codex-B`, `@3`) — address.ts's own docs give these as real
 *     agent ids, and this fleet runs codex-A..codex-E. A hyphen or digit is what separates an
 *     identifier from ordinary prose, which is why the bare-word case stays excluded.
 *
 *  Child sequence numbers mirror CHILD_RE exactly (positive, no leading zero), not a loose `\d+`. */
const MENTION_RE =
  /@(?:all|operator|orchestrator|[A-Z](?:\.[1-9][0-9]{0,8})?|[A-Za-z0-9]+-[A-Za-z0-9]+(?:\.[1-9][0-9]{0,8})?|[0-9]+(?:\.[1-9][0-9]{0,8})?)\b/g;

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
  MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_RE.exec(body)) !== null) {
    if (match.index > cursor) {
      segments.push({ text: body.slice(cursor, match.index), mention: false });
    }
    segments.push({ text: match[0], mention: true });
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
