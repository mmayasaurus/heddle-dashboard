//! Behavioral tests for @mention splitting/highlighting (HED-130). Test 1 is the security
//! regression: a hostile body must render as inert literal text with no element ever created from
//! it — mirroring Transcript.test.tsx's own HTML-injection test, now through MentionText.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MentionText, splitMentions } from "./mentions";
import { Transcript } from "./Transcript";
import type { CommsMessage } from "./useCommsPoll";

afterEach(cleanup);

function mkMsg(overrides: Partial<CommsMessage> & { id: number }): CommsMessage {
  return {
    ts: "2026-08-16T17:02:00Z",
    sender: "R",
    target: "#fleet",
    kind: "chat",
    tier: "agent",
    verified: false,
    body: "hello",
    replyTo: null,
    dispatchId: null,
    fromNameClaim: null,
    senderKind: "agent",
    deliveries: null,
    ...overrides,
  };
}

describe("splitMentions", () => {
  it("round-trips every character for a handful of awkward inputs", () => {
    const inputs = [
      "",
      "@all",
      "@T@K",
      "a@b.com",
      "@",
      "hey @T can you check @K.1's PR, thanks @orchestrator",
      "not a mention: T, or a@b.com, or @t, or @lowercase",
    ];
    for (const input of inputs) {
      const joined = splitMentions(input)
        .map((s) => s.text)
        .join("");
      expect(joined).toBe(input);
    }
  });

  it("highlights @all, @orchestrator, @T, @K.1 and leaves surrounding prose untouched", () => {
    const input = "hey @T, @K.1 and @orchestrator saw @all — go";
    const segs = splitMentions(input);
    expect(segs.filter((s) => s.mention).map((s) => s.text)).toEqual([
      "@T",
      "@K.1",
      "@orchestrator",
      "@all",
    ]);
    // The mentions above must be exactly the addressed tokens — nothing else got swallowed into
    // one, and nothing was lost: rejoining every segment (mention or not) reproduces the input.
    expect(segs.map((s) => s.text).join("")).toBe(input);
  });

  it("does not highlight a bare address without @, a lowercase agent letter, or an email-looking token", () => {
    expect(splitMentions("T is on it").every((s) => !s.mention)).toBe(true);
    expect(splitMentions("@t is not an address").some((s) => s.mention)).toBe(false);
    expect(splitMentions("reach me at a@b.com").some((s) => s.mention)).toBe(false);
  });
});

describe("MentionText", () => {
  it("renders a hostile body as literal text — no element is ever created from it (security regression)", () => {
    const hostile = '<img src=x onerror="window.__pwned = true">';
    const { container } = render(<MentionText body={hostile} />);
    expect(container.textContent).toBe(hostile);
    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("wraps @mention segments in .comms-mention spans and leaves the rest as plain text", () => {
    const body = "hey @T, ping @K.1 please";
    const { container } = render(<MentionText body={body} />);
    const mentions = container.querySelectorAll(".comms-mention");
    expect(Array.from(mentions).map((el) => el.textContent)).toEqual(["@T", "@K.1"]);
    expect(container.textContent).toBe(body);
  });
});

describe("Transcript — mention rendering (HED-130)", () => {
  it("still renders the full body text when it contains a mention", () => {
    const body = "@all heads up, @T can you look at this";
    const msg = mkMsg({ id: 42, body });
    render(<Transcript messages={[msg]} />);
    const bubble = screen.getByTestId("comms-body-42");
    expect(bubble.textContent).toBe(body);
    expect(bubble.querySelectorAll(".comms-mention")).toHaveLength(2);
  });
});

describe("splitMentions — addresses this fleet actually uses", () => {
  const mentions = (body: string) =>
    splitMentions(body).filter((s) => s.mention).map((s) => s.text);

  it("highlights @operator — the human at the keyboard is the one mention that must never be missed", () => {
    expect(mentions("@operator can you approve this?")).toEqual(["@operator"]);
  });

  it("highlights hyphenated and numeric agent ids (address.ts allows them; this fleet runs codex-A..E)", () => {
    expect(mentions("handing to @codex-B and @3 for the sweep")).toEqual(["@codex-B", "@3"]);
    expect(mentions("child work goes to @codex-B.2")).toEqual(["@codex-B.2"]);
  });

  it("still refuses ordinary capitalised prose after a stray @", () => {
    expect(mentions("deployed to @Kubernetes today")).toEqual([]);
    expect(mentions("mail me at a@b.com")).toEqual([]);
  });

  it("round-trips exactly for every one of those inputs", () => {
    for (const body of [
      "@operator can you approve this?",
      "handing to @codex-B and @3 for the sweep",
      "deployed to @Kubernetes today",
      "mail me at a@b.com",
      "@codex-B.2",
    ]) {
      expect(splitMentions(body).map((s) => s.text).join("")).toBe(body);
    }
  });
});
