//! Central request-error recorder (last-resort capture layer).
//!
//! Previously, request failures were handled independently at call sites and most disappeared into `void` or
//! empty catch blocks. Critical failures such as the initial tree load or server-rejected WS produced no UI
//! signal and required external evidence to diagnose (see the closed "empty sidebar after SSH remote-window
//! reconnect" issue under docs/issues/closed).
//!
//! This module is the mandatory convergence point for request failures, called from transport.invoke's catch:
//! - **Record and broadcast only; never retry.** Commands with side effects must not be resent automatically here.
//! - Retain the latest N entries in a ring buffer for the Error Log panel and debugging. WKWebView has no console,
//!   so this buffer is the on-site evidence.
//! - Also write to console.error where development, Chrome, or Electron consoles are available.

/** One request-failure record. */
export interface RequestErrorEntry {
  /** Failure timestamp in milliseconds. */
  ts: number;
  /** Command name: invoke's cmd, or a synthetic name such as "ws:error" for connection errors. */
  cmd: string;
  /** Error text from the backend or transport layer. */
  message: string;
}

/** Ring-buffer capacity: enough history for diagnosis without unbounded memory growth. */
const MAX_ENTRIES = 100;

const entries: RequestErrorEntry[] = [];
const subscribers = new Set<(entry: RequestErrorEntry) => void>();

/** Record a failure in the buffer, console.error, and subscriber broadcast used for live Error Log updates. */
export function recordRequestError(cmd: string, err: unknown): void {
  const message = String(err instanceof Error ? err.message : err);
  const entry: RequestErrorEntry = { ts: Date.now(), cmd, message };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  // Visible directly in development/Chrome/Electron consoles; WKWebView relies on the banner and buffer.
  console.error(`[vlx-req] ${cmd} failed:`, message);
  for (const cb of subscribers) cb(entry);
}

/** Recent failure records from newest to oldest, used for debugging and detail views. */
export function getRequestErrors(): RequestErrorEntry[] {
  return [...entries].reverse();
}

/** Clear every recorded failure, used by the Error Log panel's Clear button. */
export function clearRequestErrors(): void {
  entries.length = 0;
}

/** Subscribe to new failure records and return an unsubscribe function. */
export function onRequestError(cb: (entry: RequestErrorEntry) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
