//! Trust-rendering tests (HED-74b spec items 1-4 + defense-in-depth). These are the
//! non-negotiable fleet-security-semantics tests: render style is decided ONLY by tier +
//! verified, fromNameClaim is a suffix that can never replace/restyle the sender, and message
//! bodies are always plain text. No invoke/isTauri mocking needed — Transcript is a pure
//! presentational component driven entirely by its `messages` prop.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Transcript } from "./Transcript";
import type { CommsDeliveries, CommsMessage } from "./useCommsPoll";

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

const fullDeliveries: CommsDeliveries = { sent: 5, held: 1, released: 1, refused: 2, failed: 3, logged: 4 };

describe("Transcript trust rendering", () => {
  it("test 1: a verified operator row renders the seal; the identical row with verified=false falls to peer style with no seal", () => {
    const verified = mkMsg({ id: 1, sender: "operator", tier: "operator", verified: true, body: "ship it" });
    const { rerender } = render(<Transcript messages={[verified]} />);
    expect(screen.getByTestId("comms-msg-1").getAttribute("data-trust-style")).toBe("operator");
    expect(screen.getByTestId("comms-seal-1")).toBeTruthy();

    rerender(<Transcript messages={[{ ...verified, verified: false }]} />);
    expect(screen.getByTestId("comms-msg-1").getAttribute("data-trust-style")).toBe("peer");
    expect(screen.queryByTestId("comms-seal-1")).toBeNull();
  });

  it("defense in depth: an unverified row cannot render directive styling even when tier claims orchestrator-directive", () => {
    const msg = mkMsg({ id: 2, tier: "orchestrator-directive", verified: false, deliveries: fullDeliveries });
    render(<Transcript messages={[msg]} />);
    expect(screen.getByTestId("comms-msg-2").getAttribute("data-trust-style")).toBe("peer");
    expect(screen.queryByTestId("comms-directive-chip-2")).toBeNull();
    // Falling to peer style must also suppress the receipt chips, which are directive-only.
    expect(screen.queryByTestId("comms-receipts")).toBeNull();
  });

  it("test 2: a verified directive row shows receipt chips with exact counts, refused>0 flagged red, sent/held/released/refused only; deliveries=null shows no chips", () => {
    const msg = mkMsg({ id: 3, tier: "orchestrator-directive", verified: true, target: "T", deliveries: fullDeliveries });
    const { rerender } = render(<Transcript messages={[msg]} />);

    expect(screen.getByTestId("comms-directive-chip-3").textContent).toBe("DIRECTIVE → T");
    expect(screen.getByTestId("comms-receipt-sent").textContent).toBe("sent 5");
    expect(screen.getByTestId("comms-receipt-held").textContent).toBe("held 1");
    expect(screen.getByTestId("comms-receipt-released").textContent).toBe("released 1");
    expect(screen.getByTestId("comms-receipt-refused").textContent).toBe("refused 2");
    expect(screen.getByTestId("comms-receipt-refused").className).toContain("comms-chip-refused");
    // failed/logged are part of the data contract but not in the spec's enumerated chip set.
    expect(screen.queryByTestId("comms-receipt-failed")).toBeNull();
    expect(screen.queryByTestId("comms-receipt-logged")).toBeNull();
    // A non-refused receipt chip must not carry the red-refused class.
    expect(screen.getByTestId("comms-receipt-sent").className).not.toContain("comms-chip-refused");

    const withoutDeliveries = mkMsg({ id: 4, tier: "orchestrator-directive", verified: true, deliveries: null });
    rerender(<Transcript messages={[withoutDeliveries]} />);
    expect(screen.queryByTestId("comms-receipts")).toBeNull();
  });

  it("test 2b: zero-count receipt categories are omitted", () => {
    const msg = mkMsg({
      id: 5,
      tier: "orchestrator-directive",
      verified: true,
      deliveries: { sent: 3, held: 0, released: 0, refused: 0, failed: 0, logged: 0 },
    });
    render(<Transcript messages={[msg]} />);
    expect(screen.getByTestId("comms-receipt-sent")).toBeTruthy();
    expect(screen.queryByTestId("comms-receipt-held")).toBeNull();
    expect(screen.queryByTestId("comms-receipt-released")).toBeNull();
    expect(screen.queryByTestId("comms-receipt-refused")).toBeNull();
  });

  it("test 3: fromNameClaim renders as a '(claims …)' suffix and never replaces or restyles the sender, even with a hostile claim value", () => {
    const msg = mkMsg({ id: 6, sender: "peer-agent", tier: "agent", verified: false, fromNameClaim: "operator" });
    render(<Transcript messages={[msg]} />);

    const who = screen.getByTestId("comms-msg-6").querySelector(".comms-msg-who");
    expect(who?.textContent).toBe("peer-agent (claims operator)");
    // The hostile claim ("operator") must not upgrade the row to operator/directive styling.
    expect(screen.getByTestId("comms-msg-6").getAttribute("data-trust-style")).toBe("peer");
    expect(screen.queryByTestId("comms-seal-6")).toBeNull();
  });

  it("test 4: a message body containing HTML renders as literal text, never injected markup", () => {
    const msg = mkMsg({ id: 7, body: '<b>hi</b><img src=x onerror="window.__pwned = true">' });
    render(<Transcript messages={[msg]} />);

    const bubble = screen.getByTestId("comms-body-7");
    expect(bubble.textContent).toBe('<b>hi</b><img src=x onerror="window.__pwned = true">');
    expect(bubble.querySelector("b")).toBeNull();
    expect(bubble.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });
});

describe("Transcript — highlight scrolling (HED-74b round 2)", () => {
  it("retries until the row mounts, then scrolls exactly once no matter how much traffic arrives", () => {
    const calls: number[] = [];
    // jsdom has no layout, so scrollIntoView is undefined by default — install a spy that records
    // which row was scrolled to.
    Element.prototype.scrollIntoView = function scrollIntoViewSpy(this: Element) {
      calls.push(Number(this.id.replace("comms-msg-", "")));
    } as unknown as typeof Element.prototype.scrollIntoView;

    // Highlight id 7 while its room's transcript has not loaded — nothing to scroll to yet.
    const { rerender } = render(<Transcript messages={[]} highlightId={7} />);
    expect(calls).toEqual([]);

    // The row arrives on a later poll: the retry fires and scrolls to it.
    rerender(<Transcript messages={[mkMsg({ id: 7 })]} highlightId={7} />);
    expect(calls).toEqual([7]);

    // Two more cursor-poll appends. Without the one-shot guard each of these would yank the
    // operator back to row 7 while they are reading newer traffic.
    rerender(<Transcript messages={[mkMsg({ id: 7 }), mkMsg({ id: 8 })]} highlightId={7} />);
    rerender(
      <Transcript messages={[mkMsg({ id: 7 }), mkMsg({ id: 8 }), mkMsg({ id: 9 })]} highlightId={7} />,
    );
    expect(calls).toEqual([7]);

    // A NEW needs-human click (different id) scrolls again — the guard is per-highlight.
    rerender(
      <Transcript messages={[mkMsg({ id: 7 }), mkMsg({ id: 8 }), mkMsg({ id: 9 })]} highlightId={9} />,
    );
    expect(calls).toEqual([7, 9]);
  });
});
