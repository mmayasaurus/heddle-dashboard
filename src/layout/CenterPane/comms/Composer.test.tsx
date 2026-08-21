//! Behavioral tests for the operator composer (HED-74c). The two most important guarantees here:
//! (1) a broker refusal is a NORMAL result that renders inline and PRESERVES the typed body — it
//! must never be silently cleared; (2) a successful send clears the input and relies entirely on
//! the existing transcript poll — Composer must never insert anything locally (enforced here by
//! never importing/rendering CommsMessage at all, and asserted per-test below).

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../../ipc/transport";
import { Composer } from "./Composer";
import { useCommsPoll, type CommsNeedsHumanRow } from "./useCommsPoll";
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

describe("Composer — delivery notes for logged, non-live sends (HED-298)", () => {
  it("shows a note for a deaf DM while clearing the logged message", async () => {
    mockInvoke.mockResolvedValue({ outcome: "failed", code: "no-live-session", reason: "S has no live comms session; it can pull the message from the log" });
    render(<Composer target="S" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);

    fireEvent.change(input(), { target: { value: "please review" } });
    fireEvent.click(sendBtn());

    const deliveryNote = await screen.findByTestId("comms-delivery-note");
    expect(deliveryNote.textContent).toContain("S has no live session");
    expect(deliveryNote.getAttribute("role")).toBe("status");
    expect(deliveryNote.getAttribute("aria-live")).toBe("polite");
    expect(input().value).toBe("");
    expect(screen.queryByTestId("comms-refusal")).toBeNull();
  });

  it("shows the inbox-recipient count for a broadcast inbox split while clearing the draft", async () => {
    mockInvoke.mockResolvedValue({ outcome: "sent", code: "broadcast", reason: "1/3 pushed, 2/3 to inbox" });
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);

    fireEvent.click(within(screen.getByTestId("comms-atall-toggle")).getByRole("checkbox"));
    fireEvent.change(input(), { target: { value: "attention everyone" } });
    fireEvent.click(sendBtn());

    expect((await screen.findByTestId("comms-delivery-note")).textContent).toContain("2 of 3 recipients");
    expect(input().value).toBe("");
  });

  it.each([
    ["all-pushed broadcast", { outcome: "sent", code: "broadcast", reason: "3/3 pushed, 0/3 to inbox" }],
    ["pull-model room", { outcome: "logged", code: "room-pull" }],
    ["live DM", { outcome: "sent", code: "queued-for-channel", reason: "session S will inject it" }],
    ["no-recipient send", { outcome: "logged", code: "no-recipients" }],
  ])("does not show a delivery note for a %s", async (_label, result) => {
    mockInvoke.mockResolvedValue(result);
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);

    fireEvent.change(input(), { target: { value: "logged as expected" } });
    fireEvent.click(sendBtn());

    await waitFor(() => expect(input().value).toBe(""));
    expect(screen.queryByTestId("comms-delivery-note")).toBeNull();
  });

  it("keeps a refusal distinct: draft preserved and no delivery note", async () => {
    mockInvoke.mockResolvedValue({ outcome: "refused", code: "floor-held", reason: "floor-held" });
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder="V" replyTo={null} onClearReplyTo={vi.fn()} />);

    fireEvent.change(input(), { target: { value: "wait for me" } });
    fireEvent.click(sendBtn());

    await screen.findByTestId("comms-refusal");
    expect(input().value).toBe("wait for me");
    expect(screen.queryByTestId("comms-delivery-note")).toBeNull();
  });

  it("clears an earlier delivery note when a later send is refused", async () => {
    mockInvoke.mockResolvedValueOnce({ outcome: "failed", code: "no-live-session", reason: "S has no live comms session" });
    mockInvoke.mockResolvedValueOnce({ outcome: "refused", code: "floor-held", reason: "floor-held" });
    render(<Composer target="S" status={AVAILABLE} floorHolder="V" replyTo={null} onClearReplyTo={vi.fn()} />);

    fireEvent.change(input(), { target: { value: "first message" } });
    fireEvent.click(sendBtn());
    await screen.findByTestId("comms-delivery-note");

    fireEvent.change(input(), { target: { value: "retry message" } });
    fireEvent.click(sendBtn());

    await screen.findByTestId("comms-refusal");
    expect(screen.queryByTestId("comms-delivery-note")).toBeNull();
  });
});

describe("regression PR#89 — stale delivery results", () => {
  it("does not apply a deaf-DM result or clear a new target's draft after switching targets", async () => {
    let resolveSend!: (value: unknown) => void;
    mockInvoke.mockImplementation(() => new Promise((resolve) => (resolveSend = resolve)));
    const { rerender } = render(<Composer target="S" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);

    fireEvent.change(input(), { target: { value: "for S" } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(input().disabled).toBe(true));

    rerender(<Composer target="T" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);
    await waitFor(() => expect(input().disabled).toBe(false));
    fireEvent.change(input(), { target: { value: "draft for T" } });

    resolveSend({ outcome: "failed", code: "no-live-session", reason: "S has no live comms session" });

    await waitFor(() => expect(input().value).toBe("draft for T"));
    expect(screen.queryByTestId("comms-delivery-note")).toBeNull();
    expect(screen.queryByTestId("comms-refusal")).toBeNull();
  });

  it("does not apply an @all result after switching rooms", async () => {
    let resolveSend!: (value: unknown) => void;
    mockInvoke.mockImplementation(() => new Promise((resolve) => (resolveSend = resolve)));
    const onClearReplyTo = vi.fn();
    const replyTo = mkReplyTo();
    const { rerender } = render(<Composer target="#a" status={AVAILABLE} floorHolder={null} replyTo={replyTo} onClearReplyTo={onClearReplyTo} />);

    fireEvent.click(within(screen.getByTestId("comms-atall-toggle")).getByRole("checkbox"));
    fireEvent.change(input(), { target: { value: "for everyone" } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(input().disabled).toBe(true));

    rerender(<Composer target="#b" status={AVAILABLE} floorHolder={null} replyTo={replyTo} onClearReplyTo={onClearReplyTo} />);
    await waitFor(() => expect(input().disabled).toBe(false));
    fireEvent.change(input(), { target: { value: "draft for #b" } });

    resolveSend({ outcome: "failed", code: "no-live-session", reason: "S has no live comms session" });

    await waitFor(() => expect(input().value).toBe("draft for #b"));
    expect(screen.queryByTestId("comms-delivery-note")).toBeNull();
    expect(screen.queryByTestId("comms-refusal")).toBeNull();
    expect(screen.getByTestId("comms-reply-ctx")).toBeTruthy();
    expect(onClearReplyTo).not.toHaveBeenCalled();
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
  it("shows the effective destination and updates it when the broadcast toggle changes", () => {
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);

    expect(screen.getByTestId("comms-composer-to").textContent).toBe("→ #fleet");
    expect(input().getAttribute("aria-label")).toBe("Message #fleet as operator");

    fireEvent.click(within(screen.getByTestId("comms-atall-toggle")).getByRole("checkbox"));

    expect(screen.getByTestId("comms-composer-to").textContent).toBe("→ @all");
    expect(input().getAttribute("aria-label")).toBe("Message @all as operator");
  });

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

describe("Composer — confirmed sends notify the transcript reader", () => {
  function ComposerWithTranscriptRefresh() {
    const { refresh } = useCommsPoll(true, "#fleet");
    return <Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} onSent={refresh} />;
  }

  it("HED-164: a confirmed send eagerly reads the transcript, while refusal and error do not", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "heddle_comms_send") return Promise.resolve({ outcome: "sent", code: null, reason: null });
      if (cmd === "heddle_comms_transcript") return Promise.resolve({ schemaOk: true, schemaVersion: 1, messages: [], floor: null });
      if (cmd === "heddle_comms_rooms") return Promise.resolve({ schemaOk: true, schemaVersion: 1, rooms: [], needsHuman: [], recentRefusals: 0 });
      if (cmd === "heddle_fleet_roster") return Promise.resolve([]);
      return Promise.reject(new Error("unexpected invoke"));
    });
    render(<ComposerWithTranscriptRefresh />);
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_transcript", { target: "#fleet", sinceId: null }));
    mockInvoke.mockClear();

    fireEvent.change(input(), { target: { value: "confirmed" } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("heddle_comms_transcript", { target: "#fleet", sinceId: 0 }));

    mockInvoke.mockClear();
    mockInvoke.mockResolvedValueOnce({ outcome: "refused", code: "floor-held", reason: "floor-held" });
    fireEvent.change(input(), { target: { value: "refused" } });
    fireEvent.click(sendBtn());
    await screen.findByTestId("comms-refusal");
    expect(mockInvoke.mock.calls.some((call) => call[0] === "heddle_comms_transcript")).toBe(false);

    mockInvoke.mockClear();
    mockInvoke.mockRejectedValueOnce(new Error("broker unavailable"));
    fireEvent.change(input(), { target: { value: "error" } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(screen.getByTestId("comms-refusal").textContent).toContain("broker unavailable"));
    expect(mockInvoke.mock.calls.some((call) => call[0] === "heddle_comms_transcript")).toBe(false);
  });

  it("calls onSent only after a confirmed success, never after a refusal or transport error", async () => {
    const onSent = vi.fn();
    mockInvoke.mockResolvedValueOnce({ outcome: "sent", code: null, reason: null });
    mockInvoke.mockResolvedValueOnce({ outcome: "refused", code: "floor-held", reason: "floor-held" });
    mockInvoke.mockRejectedValueOnce(new Error("broker unavailable"));
    render(<Composer target="#fleet" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} onSent={onSent} />);

    fireEvent.change(input(), { target: { value: "confirmed" } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));

    fireEvent.change(input(), { target: { value: "refused" } });
    fireEvent.click(sendBtn());
    await screen.findByTestId("comms-refusal");
    expect(onSent).toHaveBeenCalledTimes(1);

    fireEvent.change(input(), { target: { value: "error" } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(screen.getByTestId("comms-refusal").textContent).toContain("broker unavailable"));
    expect(onSent).toHaveBeenCalledTimes(1);
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

  it("clears a delivery note when target changes", async () => {
    mockInvoke.mockResolvedValue({ outcome: "failed", code: "no-live-session", reason: "S has no live comms session" });
    const { rerender } = render(<Composer target="S" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);

    fireEvent.change(input(), { target: { value: "check this" } });
    fireEvent.click(sendBtn());
    await screen.findByTestId("comms-delivery-note");

    rerender(<Composer target="T" status={AVAILABLE} floorHolder={null} replyTo={null} onClearReplyTo={vi.fn()} />);

    await waitFor(() => expect(screen.queryByTestId("comms-delivery-note")).toBeNull());
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
