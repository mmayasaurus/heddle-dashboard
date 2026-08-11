//! Terminal output scheduler (phase three of the performance optimization): adds a shared queue before
//! term.write so that the focused terminal can jump the queue, while fragmented output from background
//! terminals is coalesced into larger blocks and written at a steady per-frame rate. This prevents noisy
//! background agents from monopolizing the main thread and making typing in the focused terminal sluggish.
//!
//! Two additional improvements were added on 2026-07-02; see the corresponding typing-priority and
//! chunked-flushing implementation plan:
//! 1. Typing priority (phase one of typing-aware output throttling): reduce the background budget to a
//!    trickle for a short window after user input.
//! 2. Chunked flushing: split every bulk delivery (catching up when foregrounded or draining an overflow)
//!    into FLUSH_BLOCK_BYTES writes. xterm's 12 ms time slicing only applies between write blocks; each
//!    individual block is parsed synchronously, so combining everything creates a long synchronous task.
//!
//! ## Why this is needed (and why xterm alone is not enough)
//!
//! Each xterm terminal has its own WriteBuffer, which parses within a 12 ms time budget per frame instead
//! of blocking the main thread all at once. Those buffers are independent and equally prioritized, though:
//! if 16 background terminals are producing output at once, they all compete for main-thread time and the
//! focused terminal loses, making typing laggy. This scheduler supplies what xterm cannot: **foreground
//! priority and background suppression across terminals**. Foreground priority lets the focused terminal
//! write immediately, while a global per-frame budget (see MAX_BYTES_PER_FRAME) caps the **aggregate**
//! background throughput regardless of how many background terminals are active.
//!
//! ## Scope and non-goals
//!
//! - Only live output after the gate opens is scheduled. History replay still calls term.write directly from
//!   the hook because its replaying/done sequence is highly order-sensitive and must not be disturbed.
//! - Data is combined as bytes throughout and never decoded to strings, preserving the zero-codec binary
//!   Channel path.
//! - Background backlog is never discarded. A high memory safety limit only prevents unbounded growth: if
//!   the limit is reached while the user is typing, fast per-frame draining is enabled; otherwise the entire
//!   backlog is immediately flushed in chunks.
//! - xterm's WriteBuffer guarantees FIFO order. This module only needs to preserve the order of term.write
//!   calls, so a session's backlog is flushed before new foreground bytes are written.
//!
//! ## Kill switch
//!
//! Controlled by Settings > Advanced > Foreground-priority output (`outputScheduler` in the store, enabled
//! by default). Disabling it restores simple unscheduled writes for both foreground and background output,
//! effective from the next block without rebuilding the terminal. This is the emergency fallback for phase
//! three.

import type { Terminal } from "@xterm/xterm";

import { useTermStore } from "../store/termStore";

/**
 * Global per-frame budget: the maximum number of bytes written per frame, **shared by all background
 * queues** rather than allocated separately to each session. This caps aggregate background throughput,
 * preserving main-thread capacity for the foreground terminal and UI even when several agents are noisy.
 * 128 KB is about 7.5 MB/s at 60 frames per second. With the input-yield window protecting active typing,
 * this budget applies mainly while the user is watching rather than typing. Raising it from 64 KB to
 * 128 KB lets background terminals catch up faster and reduces the backlog that must be replayed when one
 * is foregrounded, shortening the visible blank interval. It remains well below the 256 KB cost inflection
 * found by the dual-engine budget scan, so the added parsing cost is limited and does not grow linearly with
 * byte count. When a terminal becomes foreground, flushTerminalOutput catches it up in chunks without this
 * budget.
 */
const MAX_BYTES_PER_FRAME = 128 * 1024;
/** Per-session memory safety limit. Crossing it triggers draining without dropping bytes. */
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;

/**
 * Input-yield window (phase one of typing priority): for this period after the latest user input, drain
 * reduces the per-frame background budget to INPUT_TRICKLE_BYTES so the main thread can prioritize
 * keystrokes and IME composition. This uses 250 ms rather than the draft's 120 ms because normal intervals
 * between keystrokes are often 150-400 ms. A 120 ms window would repeatedly expire between keys, restoring
 * the full background budget during the sensitive period when composition is active and another key is due.
 */
const INPUT_WINDOW_MS = 250;
/** Per-frame background budget during the input window: a trickle keeps the backlog from growing too fast. */
const INPUT_TRICKLE_BYTES = 4 * 1024;
/**
 * Flush chunk size. xterm's 12 ms time slicing applies only between write blocks; each block is parsed
 * synchronously in full. The WriteBuffer documentation notes that a single backlog above roughly 500 KB
 * can make the UI unresponsive, so bulk deliveries must be split into smaller writes to let keyboard and
 * IME events run between blocks.
 */
const FLUSH_BLOCK_BYTES = 64 * 1024;
/** Independent per-frame fast-drain budget for a queue that reaches MAX_QUEUE_BYTES during user input. */
const OVERFLOW_FAST_BYTES = 128 * 1024;

interface QueueEntry {
  term: Terminal;
  chunks: Uint8Array[];
  /** Running byte total for chunks, avoiding a reduce on every check. */
  bytes: number;
  /** Enables fast draining after the backlog reaches MAX_QUEUE_BYTES during user input. */
  overflow: boolean;
}

/** Independent queues by session ID. A visible, active mirror counts as foreground and is not queued. */
const queues = new Map<string, QueueEntry>();
/** Shared drain-frame handle. All background queues use one rAF, which stops when every queue is empty. */
let rafId = 0;
/** Rotating start index so early Map entries cannot consume the budget before later entries every frame. */
let drainCursor = 0;
/** Timestamp of the latest user input (performance.now()), used by the input-yield window. */
let lastInputAt = -Infinity;

/** Records recent input; usePtySession calls this from captured keydown/composition* events and term.onData. */
export function noteUserInput() {
  lastInputAt = performance.now();
}

/** Returns whether the input-yield window is currently active. */
function inputActive(): boolean {
  return performance.now() - lastInputAt < INPUT_WINDOW_MS;
}

/** Coalesces Uint8Arrays without decoding them. A single chunk is returned without copying. */
function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Writes to the terminal and leaves rendering to xterm; there is no post-write forced-redraw hook. */
function writeNow(term: Terminal, bytes: Uint8Array) {
  term.write(bytes);
}

/** Removes up to limit bytes from the queue (including the final chunk whole) and coalesces them. */
function takeFrom(e: QueueEntry, limit: number): Uint8Array | null {
  if (e.chunks.length === 0) return null;
  let take = 0;
  const slice: Uint8Array[] = [];
  while (e.chunks.length && take < limit) {
    const c = e.chunks.shift()!;
    slice.push(c);
    take += c.length;
  }
  e.bytes -= take;
  return concatChunks(slice, take);
}

/**
 * Writes an entire session backlog in order, used to preserve ordering before foreground output jumps the
 * queue. Delivery is split into FLUSH_BLOCK_BYTES writes instead of one combined block: xterm parses each
 * block synchronously and yields the main thread only between blocks (see FLUSH_BLOCK_BYTES). Combining a
 * multi-megabyte backlog would create a synchronous task lasting hundreds of milliseconds, one source of
 * intermittent typing stalls. WriteBuffer's FIFO behavior still preserves order across the smaller writes.
 */
function flushAll(sessionId: string) {
  const e = queues.get(sessionId);
  if (!e || e.chunks.length === 0) return;
  e.overflow = false;
  let out = takeFrom(e, FLUSH_BLOCK_BYTES);
  while (out) {
    writeNow(e.term, out);
    out = takeFrom(e, FLUSH_BLOCK_BYTES);
  }
}

/**
 * Immediately writes a session's entire backlog in chunks, **without** the global per-frame budget.
 * Called when a session becomes foreground: the terminal the user is now viewing should catch up at once
 * instead of continuing under the background budget, where other queues could delay it further. This is a
 * no-op when there is no backlog. Because xterm's 12 ms time slicing applies between write blocks, flushAll
 * writes FLUSH_BLOCK_BYTES chunks so a multi-megabyte backlog is parsed across frames rather than in one
 * long synchronous task.
 */
export function flushTerminalOutput(sessionId: string) {
  flushAll(sessionId);
}

/**
 * Entry point for live output.
 * - Foreground (currently active and visible), or kill switch disabled: write immediately after flushing any
 *   existing session backlog to preserve order.
 * - Background: enqueue and drain steadily with per-frame throttling. If the memory limit is exceeded, no
 *   bytes are dropped: enable fast per-frame overflow draining while the user is typing, or immediately
 *   flush the entire backlog in chunks otherwise.
 */
export function writeTerminalOutput(
  sessionId: string,
  term: Terminal,
  bytes: Uint8Array,
  opts: { foreground: boolean },
) {
  // The kill switch restores immediate writes for both foreground and background output.
  const enabled = useTermStore.getState().outputScheduler;
  if (!enabled || opts.foreground) {
    flushAll(sessionId); // Flush queued bytes first so new output cannot overtake them.
    writeNow(term, bytes);
    return;
  }
  let e = queues.get(sessionId);
  if (!e) {
    e = { term, chunks: [], bytes: 0, overflow: false };
    queues.set(sessionId, e);
  } else {
    // The terminal instance may have changed after an epoch rebuild; keep the latest one.
    e.term = term;
  }
  e.chunks.push(bytes);
  e.bytes += bytes.length;
  // Drain an oversized backlog to prevent unbounded memory growth; never discard it. During user input,
  // avoid a bulk flush and its parsing spike by marking the queue for fast per-frame draining instead.
  if (e.bytes >= MAX_QUEUE_BYTES) {
    if (inputActive()) {
      e.overflow = true;
      ensureDrain();
    } else {
      flushAll(sessionId);
    }
    return;
  }
  ensureDrain();
}

/** Starts the shared per-frame drain, which stops when every background queue is empty. */
function ensureDrain() {
  if (rafId) return;
  rafId = requestAnimationFrame(drain);
}

function drain() {
  rafId = 0;
  // Snapshot nonempty queues and remove empty ones so rotation is stable while the Map changes.
  const entries: Array<[string, QueueEntry]> = [];
  for (const [sid, e] of queues) {
    if (e.chunks.length === 0) {
      queues.delete(sid);
      continue;
    }
    entries.push([sid, e]);
  }
  const n = entries.length;
  if (n === 0) return;

  // Distribute one global budget fairly, starting at drainCursor and deferring the rest to the next frame.
  // Advancing the cursor each frame prevents early Map entries from consuming the budget every time.
  // During the input-yield window, reduce the budget to a trickle so keystrokes and IME composition take
  // priority; restore the normal budget outside that window.
  let budget = inputActive() ? INPUT_TRICKLE_BYTES : MAX_BYTES_PER_FRAME;
  const start = drainCursor % n;
  drainCursor = (drainCursor + 1) % n;
  let anyLeft = false;

  for (let i = 0; i < n; i++) {
    const [sid, e] = entries[(start + i) % n];
    // Fast-drain queues that crossed the memory limit with an independent budget. They do not consume the
    // global budget or obey input trickling because their memory usage would otherwise keep growing. Writes
    // remain limited to FLUSH_BLOCK_BYTES so the main thread can yield between blocks. Resume normal
    // throttling once the backlog falls below one quarter of the limit.
    if (e.overflow) {
      let remaining = OVERFLOW_FAST_BYTES;
      while (remaining > 0 && e.chunks.length) {
        const out = takeFrom(e, Math.min(remaining, FLUSH_BLOCK_BYTES));
        if (!out) break;
        remaining -= out.length;
        writeNow(e.term, out);
      }
      if (e.bytes < MAX_QUEUE_BYTES / 4) e.overflow = false;
      if (e.chunks.length) anyLeft = true;
      else queues.delete(sid);
      continue;
    }
    if (budget <= 0) {
      // Once the budget is exhausted, leave remaining queues for the next frame's rotated starting point.
      if (e.chunks.length) anyLeft = true;
      continue;
    }
    // Give this session at most the remaining frame budget. The final PTY read chunk is taken whole, so an
    // 8 KB read buffer may exceed the budget by about 8 KB. xterm does **not** time-slice within a block.
    const out = takeFrom(e, budget);
    if (out) {
      budget -= out.length;
      writeNow(e.term, out);
    }
    if (e.chunks.length) anyLeft = true;
    else queues.delete(sid);
  }
  if (anyLeft) ensureDrain();
}

/** Discards a session's queue on unmount so a disposed terminal cannot receive writes. */
export function discardTerminalOutput(sessionId: string) {
  queues.delete(sessionId);
}
