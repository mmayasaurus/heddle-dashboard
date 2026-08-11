//! Tests for the chunked loadFileBlob loader: consistent chunk assembly, progress callback order, immediate
//! cancellation, retries when mtime changes between chunks, and a "file is being written" error after three
//! continuously changing attempts.
//!
//! A mocked transport.invoke stands in for backend read_file_base64 and returns slices from an in-memory fake file.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./transport", () => ({
  invoke: vi.fn(),
  copyText: vi.fn(),
  openPath: vi.fn(),
}));

import { invoke } from "./transport";
import { FILE_BEING_WRITTEN, loadFileBlob } from "./info";

/** Convert bytes to Base64, matching the backend's independent encoding of each chunk. */
function b64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** In-memory fake file; mocked invoke slices by offset/maxLen and returns {base64, size, mtimeMs}. */
function mockFile(state: { bytes: Uint8Array; mtimeMs: number }) {
  vi.mocked(invoke).mockImplementation((cmd, args) => {
    expect(cmd).toBe("read_file_base64");
    const { offset, maxLen } = args as { offset: number; maxLen: number };
    const slice = state.bytes.slice(offset, offset + maxLen);
    return Promise.resolve({
      base64: b64(slice),
      size: state.bytes.length,
      mtimeMs: state.mtimeMs,
    }) as Promise<never>;
  });
}

function makeBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 7) % 251;
  return out;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("loadFileBlob", () => {
  it("joins multiple chunks: the bytes match the original file and the final mtime comes back", async () => {
    const state = { bytes: makeBytes(10), mtimeMs: 1000 };
    mockFile(state);

    const res = await loadFileBlob("/tmp/a.png", undefined, undefined, 4);
    expect(res).not.toBeNull();
    expect(res!.mtimeMs).toBe(1000);
    const got = new Uint8Array(await res!.blob.arrayBuffer());
    expect(got).toEqual(state.bytes);
    // Ten bytes in four-byte chunks require three requests (4 + 4 + 2).
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(3);
  });

  it("progress callbacks: one per chunk, with (received, total) rising monotonically to completion", async () => {
    const state = { bytes: makeBytes(10), mtimeMs: 1 };
    mockFile(state);

    const seq: Array<[number, number]> = [];
    await loadFileBlob("/tmp/a.png", (r, t) => seq.push([r, t]), undefined, 4);
    expect(seq).toEqual([
      [4, 10],
      [8, 10],
      [10, 10],
    ]);
  });

  it("empty file: a single request returns an empty Blob", async () => {
    const state = { bytes: new Uint8Array(0), mtimeMs: 5 };
    mockFile(state);
    const res = await loadFileBlob("/tmp/empty.png", undefined, undefined, 4);
    expect(res!.blob.size).toBe(0);
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });

  it("stops on cancellation: once isCancelled is true no further request is made and it returns null", async () => {
    const state = { bytes: makeBytes(10), mtimeMs: 1 };
    mockFile(state);

    let cancelled = false;
    const res = await loadFileBlob(
      "/tmp/a.png",
      () => {
        cancelled = true; // Cancel after receiving the first chunk.
      },
      () => cancelled,
      4,
    );
    expect(res).toBeNull();
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });

  it("mtime changes between chunks: discards what was read, restarts automatically, and returns the new content", async () => {
    const oldBytes = makeBytes(10);
    const newBytes = makeBytes(8).map((b) => b ^ 0xff);
    const state = { bytes: oldBytes, mtimeMs: 100 };
    mockFile(state);

    let calls = 0;
    vi.mocked(invoke).mockImplementation((cmd, args) => {
      expect(cmd).toBe("read_file_base64");
      calls++;
      if (calls === 2) {
        // Rewrite the file after the first chunk, changing both mtime and content.
        state.bytes = new Uint8Array(newBytes);
        state.mtimeMs = 200;
      }
      const { offset, maxLen } = args as { offset: number; maxLen: number };
      const slice = state.bytes.slice(offset, offset + maxLen);
      return Promise.resolve({
        base64: b64(slice),
        size: state.bytes.length,
        mtimeMs: state.mtimeMs,
      }) as Promise<never>;
    });

    const res = await loadFileBlob("/tmp/a.png", undefined, undefined, 4);
    const got = new Uint8Array(await res!.blob.arrayBuffer());
    expect(got).toEqual(new Uint8Array(newBytes));
    expect(res!.mtimeMs).toBe(200);
  });

  it("mtime still changing after three attempts: throws that the file is being written", async () => {
    // Every request returns a new mtime, so the second chunk of every attempt is necessarily inconsistent.
    let m = 0;
    vi.mocked(invoke).mockImplementation(() => {
      m += 1;
      return Promise.resolve({
        base64: b64(makeBytes(4)),
        size: 10,
        mtimeMs: m,
      }) as Promise<never>;
    });

    await expect(
      loadFileBlob("/tmp/a.png", undefined, undefined, 4),
    ).rejects.toThrow(FILE_BEING_WRITTEN);
  });
});
