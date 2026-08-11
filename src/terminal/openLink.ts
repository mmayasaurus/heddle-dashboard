//! Shared terminal link handler for OSC 8 hyperlinks and bare URLs detected by WebLinksAddon.
//!
//! Why xterm's default handling cannot be used:
//!
//! 1. xterm's `OscLinkProvider` calls synchronous `confirm()` before `window.open()`. The Tauri
//!    dialog plugin replaces confirm in every WebView with an async invocation. Remote windows lack
//!    dialog permission, causing an unhandled ACL rejection; in the main window the returned Promise
//!    is always truthy, so navigation proceeds before the user answers.
//! 2. Both default paths eventually call `window.open()`, which returns null in macOS WKWebView and
//!    only logs "Opening link blocked".
//!
//! Route everything through `platform.opener.openExternal`. Tauri desktop and remote windows use
//! the local opener plugin, opening links in the operator's browser rather than on the remote host;
//! plain browsers fall back to `window.open`. commands.rs grants remote windows the required
//! `opener:allow-open-url` permission when creating them.

import type { ILinkHandler } from "@xterm/xterm";

import { platform } from "../platform";

/**
 * Open a terminal link. Failures remain unobtrusive: popup blocking in browsers and ACL rejection
 * in underprivileged windows are logged only to the console.
 */
export function openTerminalLink(uri: string): void {
  void platform.opener.openExternal(uri).catch((err: unknown) => {
    console.warn("[terminal] failed to open link", uri, err);
  });
}

/** Pass to `new Terminal({ linkHandler })` to handle OSC 8 hyperlink clicks. */
export const terminalLinkHandler: ILinkHandler = {
  activate(_event, text) {
    openTerminalLink(text);
  },
};

/** Pass to `new WebLinksAddon(...)` to handle detected bare-URL clicks. */
export function webLinkActivate(_event: MouseEvent, uri: string): void {
  openTerminalLink(uri);
}
