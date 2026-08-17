//! Behavioral tests for the operator composer (HED-74c). The two most important guarantees here:
//! (1) a broker refusal is a NORMAL result that renders inline and PRESERVES the typed body — it
//! must never be silently cleared; (2) a successful send clears the input and relies entirely on
//! the existing transcript poll — Composer must never insert anything locally (enforced here by
//! never importing/rendering CommsMessage at all, and asserted per-test below).

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../../ipc/transport";
import { Composer } from "./Composer";
import type { CommsNeedsHumanRow } from "./useCommsPoll";
import type { OperatorStatus } from "./useOperatorStatus";

vi.mock("../../../ipc/transport", () => ({ invoke: vi.fn(), isTauri: true }));

const mockInvoke = vi.mocked(invoke);

const AVAILABLE: OperatorStatus = { available: true, revoked: false, reason: null };

function mkReplyTo(overrides: Partial<CommsNeedsHumanRow> = {}): CommsNeedsHumanRow {
  return { id: 9, ts: "2026-08-16T17:00:00Z", sender: "U", target: "#fleet", kind: "needs-human", body: "may I run cargo update?", ...overrides };
}

function input(): HTMLTextAreaElement {
  return screen.getByTestId("comms-composer-input") as HTMLTextAreaElement;
}
function sendBtn(): HTMLButtonElement {
  return screen.getByTestId("comms-send-btn") as HTMLButtonElement;
}

beforeEach(() => {
  mockInvoke.mockReset();
});

afterEach(cleanup);

describe("Composer — disabled states", () => {
  it("disabled with no hint text before target is known, even when the operator is available", () => {
    render(<Composer target={null} status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);
    expect(input().disabled).toBe(true);
    expect(screen.queryByTestId("comms-composer-hint")).toBeNull();
  });

  it.each([
    ["no-binary", "Install heddle"],
    ["no-token", "--init-operator-token"],
    ["revoked", "restart the app"],
    ["spawn-failed", "check the logs"],
  ] as const)("disabled with the %s hint", (reason, expectedSubstring) => {
    const status: OperatorStatus = { available: false, revoked: reason === "revoked", reason };
    render(<Composer target="#fleet" status={status} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);
    expect(input().disabled).toBe(true);
    expect(sendBtn().disabled).toBe(true);
    expect(screen.getByTestId("comms-composer-hint").textContent).toContain(expectedSubstring);
  });

  it("send stays disabled while the body is empty/whitespace-only, even when everything else is available", () => {
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);
    expect(sendBtn().disabled).toBe(true);
    fireEvent.change(input(), { target: { value: "   " } });
    expect(sendBtn().disabled).toBe(true);
  });
});

describe("Composer — refusal preserves the typed body", () => {
  it("a floor-held refusal shows the holder inline and keeps the typed text untouched", async () => {
    mockInvoke.mockResolvedValue({ outcome: "refused", code: "floor-held", reason: "floor-held" });
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder="V" replyTo={null} onClearReplyTo={vi.fn()} />);

    fireEvent.change(input(), { target: { value: "ship it" } });
    fireEvent.click(sendBtn());

    expect((await screen.findByTestId("comms-refusal")).textContent).toBe("V holds the floor — try again shortly.");
    expect(input().value).toBe("ship it");
  });

  it("a refusal without floor-held shows the broker's raw reason verbatim and still preserves the body", async () => {
    mockInvoke.mockResolvedValue({ outcome: "refused", code: "rate-limited", reason: "rate-limited: try again in 30s" });
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);

    fireEvent.change(input(), { target: { value: "still here" } });
    fireEvent.click(sendBtn());

    expect((await screen.findByTestId("comms-refusal")).textContent).toBe("rate-limited: try again in 30s");
    expect(input().value).toBe("still here");
  });

  it("a rejected invoke() call (transport error) renders the error inline and still preserves the body", async () => {
    mockInvoke.mockRejectedValue(new Error("child process not running"));
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);

    fireEvent.change(input(), { target: { value: "don't lose this" } });
    fireEvent.click(sendBtn());

    expect((await screen.findByTestId("comms-refusal")).textContent).toContain("child process not running");
    expect(input().value).toBe("don't lose this");
  });

  it("a malformed (unparseable) success payload falls back to the generic refusal text and preserves the body", async () => {
    mockInvoke.mockResolvedValue({ nonsense: true });
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);

    fireEvent.change(input(), { target: { value: "keep me" } });
    fireEvent.click(sendBtn());

    expect((await screen.findByTestId("comms-refusal")).textContent).toBe("The broker refused this message.");
    expect(input().value).toBe("keep me");
  });
});

describe("Composer — success clears and never inserts locally", () => {
  it("clears the input and any refusal banner on a successful send, and calls onClearReplyTo", async () => {
    mockInvoke.mockResolvedValue({ outcome: "sent", code: null, reason: null });
    const onClearReplyTo = vi.fn();
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={mkReplyTo()} onClearReplyTo={onClearReplyTo} />);

    fireEvent.change(input(), { target: { value: "ship it" } });
    fireEvent.click(sendBtn());

    await waitFor(() => expect(input().value).toBe(""));
    expect(screen.queryByTestId("comms-refusal")).toBeNull();
    expect(onClearReplyTo).toHaveBeenCalledTimes(1);
  });

  it("sends target/body/replyTo verbatim to heddle_comms_send and never calls any transcript-shaped command", async () => {
    mockInvoke.mockResolvedValue({ outcome: "sent", code: null, reason: null });
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={mkReplyTo({ id: 42 })} onClearReplyTo={vi.fn()} />);

    fireEvent.change(input(), { target: { value: "the fix landed" } });
    fireEvent.click(sendBtn());

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_send", { target: "#fleet", body: "the fix landed", replyTo: 42 }));
    expect(mockInvoke.mock.calls.some((c) => String(c[0]).includes("transcript"))).toBe(false);
  });

  it("recovering from a prior refusal: editing the body and sending again on success clears it (no stuck refusal banner)", async () => {
    mockInvoke.mockResolvedValueOnce({ outcome: "refused", code: "floor-held", reason: "floor-held" });
    mockInvoke.mockResolvedValueOnce({ outcome: "sent", code: null, reason: null });
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder="V" replyTo={null} onClearReplyTo={vi.fn()} />);

    fireEvent.change(input(), { target: { value: "retry me" } });
    fireEvent.click(sendBtn());
    await screen.findByTestId("comms-refusal");

    fireEvent.click(sendBtn());
    await waitFor(() => expect(input().value).toBe(""));
    expect(screen.queryByTestId("comms-refusal")).toBeNull();
  });
});

describe("Composer — Enter vs Shift+Enter", () => {
  it("Enter (no shift) sends the message", async () => {
    mockInvoke.mockResolvedValue({ outcome: "sent", code: null, reason: null });
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);

    fireEvent.change(input(), { target: { value: "hello" } });
    fireEvent.keyDown(input(), { key: "Enter" });

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_send", { target: "#fleet", body: "hello", replyTo: null }));
  });

  it("Shift+Enter does not send", () => {
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "hello" } });
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("Enter on an empty/whitespace body does not send", () => {
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("Composer — disabled while sending", () => {
  it("disables the input and send button between click and the invoke() settling", async () => {
    let resolveSend!: (v: unknown) => void;
    mockInvoke.mockImplementation(() => new Promise((resolve) => (resolveSend = resolve)));
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);

    fireEvent.change(input(), { target: { value: "in flight" } });
    fireEvent.click(sendBtn());

    await waitFor(() => expect(input().disabled).toBe(true));
    expect(sendBtn().disabled).toBe(true);

    resolveSend({ outcome: "sent", code: null, reason: null });
    await waitFor(() => expect(input().disabled).toBe(false));
  });
});

describe("Composer — @all toggle", () => {
  it("sends to the broadcast ADDRESS when the toggle is on, leaving the body untouched", async () => {
    mockInvoke.mockResolvedValue({ outcome: "sent", code: null, reason: null });
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);

    const toggle = within(screen.getByTestId("comms-atall-toggle")).getByRole("checkbox");
    fireEvent.click(toggle);
    fireEvent.change(input(), { target: { value: "everyone see this" } });
    fireEvent.click(sendBtn());

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_send", { target: "@all", body: "everyone see this", replyTo: null }),
    );
  });
});

describe("Composer — resets draft state when the active target changes (B4)", () => {
  it("clears the typed body, the @all toggle, and a refusal banner when target changes", async () => {
    mockInvoke.mockResolvedValue({ outcome: "refused", code: "floor-held", reason: "floor-held" });
    const { rerender } = render(<Composer target="#fleet" status={AVAILABLE} floorHolder="V" replyTo={null} onClearReplyTo={vi.fn()} />);

    const toggle = () => within(screen.getByTestId("comms-atall-toggle")).getByRole("checkbox") as HTMLInputElement;
    fireEvent.click(toggle());
    fireEvent.change(input(), { target: { value: "half-written for #fleet" } });
    fireEvent.click(sendBtn());

    expect(await screen.findByTestId("comms-refusal")).toBeTruthy();
    expect(toggle().checked).toBe(true);
    expect(input().value).toBe("half-written for #fleet");

    rerender(<Composer target="T" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);

    await waitFor(() => expect(input().value).toBe(""));
    expect(screen.queryByTestId("comms-refusal")).toBeNull();
    expect(toggle().checked).toBe(false);
  });

  it("does NOT clear the typed body when only the @all toggle changes (no target switch)", () => {
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);
    fireEvent.change(input(), { target: { value: "still typing" } });

    const toggle = within(screen.getByTestId("comms-atall-toggle")).getByRole("checkbox");
    fireEvent.click(toggle);

    expect(input().value).toBe("still typing");
  });
});

describe("Composer — reply context", () => {
  it("renders the reply-to sender and body when replyTo is set", () => {
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={mkReplyTo({ sender: "U.2" })} onClearReplyTo={vi.fn()} />);
    const ctx = screen.getByTestId("comms-reply-ctx");
    expect(ctx.textContent).toContain("U.2");
    expect(ctx.textContent).toContain("may I run cargo update?");
  });

  it("clicking the clear button calls onClearReplyTo without sending anything", () => {
    const onClearReplyTo = vi.fn();
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={mkReplyTo()} onClearReplyTo={onClearReplyTo} />);
    fireEvent.click(screen.getByTestId("comms-reply-clear"));
    expect(onClearReplyTo).toHaveBeenCalledTimes(1);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("renders no reply context when replyTo is null", () => {
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);
    expect(screen.queryByTestId("comms-reply-ctx")).toBeNull();
  });
});
