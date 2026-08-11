//! Mobile shortcut bar providing terminal control keys absent from soft keyboards, including Esc, Tab, Ctrl,
//! and arrows. Tapping sends the corresponding control sequence to the PTY through ptyWrite, the same path as
//! keyboard input.
//!
//! - Ctrl is a modifier mode. When active, it reveals a row of common ^A–^W combinations; tapping one sends it
//!   and turns the modifier off. It does not hook into xterm's input stream, avoiding contention with onData.
//! - Arrow keys choose sequences according to the terminal's current DECCKM (application cursor-key mode): SS3
//!   (ESC O x) in application mode and CSI (ESC [ x) otherwise. This serves both full-screen applications such as
//!   vim/less and shell line editing correctly.
//! - Every button prevents the default pointerdown action, preserving focus on xterm's hidden textarea and
//!   leaving the soft keyboard's current open/closed state unchanged.

import { useRef, useState } from "react";
import { ptyWrite } from "../ipc/commands";
import { focusTerminal, isAppCursorMode } from "../terminal/registry";

/** Common Ctrl combinations: C=interrupt, D=EOF, Z=suspend, L=clear, A/E=line start/end, K/U=delete line, R=search, W=delete word. */
const CTRL_LETTERS = ["C", "D", "Z", "L", "A", "E", "K", "U", "R", "W"];

export function KeyBar({
  sessionId,
  onImages,
}: {
  sessionId: string;
  /** Delegate camera/library images to the shared upper-layer injection path used by terminal paste/drop, including its failure banner. */
  onImages: (files: File[]) => void;
}) {
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const send = (seq: string) => {
    void ptyWrite(sessionId, seq).catch(() => {});
  };
  const arrow = (ch: "A" | "B" | "C" | "D") =>
    send(isAppCursorMode(sessionId) ? `\x1bO${ch}` : `\x1b[${ch}`);
  const sendCtrl = (letter: string) => {
    // Ctrl+letter equals the letter's ASCII value minus 64 (C→\x03, D→\x04, and so on).
    send(String.fromCharCode(letter.charCodeAt(0) - 64));
    setCtrlArmed(false);
  };
  const noFocusSteal = (e: React.SyntheticEvent) => e.preventDefault();

  const key = (label: string, onTap: () => void, extraClass = "") => (
    <button
      key={label}
      type="button"
      className={"m-key" + extraClass}
      onPointerDown={noFocusSteal}
      onClick={onTap}
    >
      {label}
    </button>
  );

  return (
    <div className="m-keybar-wrap">
      {ctrlArmed && (
        <div className="m-keybar">
          {CTRL_LETTERS.map((l) => key(`^${l}`, () => sendCtrl(l)))}
        </div>
      )}
      <div className="m-keybar">
        {key("Esc", () => send("\x1b"))}
        {key("Tab", () => send("\t"))}
        {key("Ctrl", () => setCtrlArmed((v) => !v), ctrlArmed ? " on" : "")}
        {key("↑", () => arrow("A"))}
        {key("↓", () => arrow("B"))}
        {key("←", () => arrow("D"))}
        {key("→", () => arrow("C"))}
        {key("^C", () => send("\x03"))}
        {key("⌨", () => focusTerminal(sessionId))}
        {key("📷", () => fileRef.current?.click())}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            // Camera/library image → existing upload path: WS invokes save_pasted_image, injects the server path,
            // and the agent reads the image from that path.
            const files = Array.from(e.target.files ?? []);
            if (files.length) onImages(files);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
