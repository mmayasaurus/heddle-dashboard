//! Address-bar normalization unit tests ported from `#[test] mod tests` in `src-tauri/src/browser.rs`, ensuring
//! the Electron TypeScript rules match the Tauri Rust rules (architecture document §17 security model).

import { describe, expect, it } from "vitest";
import { normalizeBrowserUrl } from "./browserUrl";

describe("normalizeBrowserUrl", () => {
  it("passes a complete http/https URL through, adding only a trailing slash", () => {
    expect(normalizeBrowserUrl("https://github.com/a/b?x=1")).toBe("https://github.com/a/b?x=1");
    expect(normalizeBrowserUrl("http://example.com")).toBe("http://example.com/");
  });

  it("prefixes https:// for input that looks like a domain", () => {
    expect(normalizeBrowserUrl("github.com")).toBe("https://github.com/");
    expect(normalizeBrowserUrl("news.ycombinator.com/item?id=1")).toBe(
      "https://news.ycombinator.com/item?id=1",
    );
    expect(normalizeBrowserUrl("example.com:8080/path")).toBe("https://example.com:8080/path");
    expect(normalizeBrowserUrl("localhost:1420")).toBe("https://localhost:1420/");
  });

  it("sends a search term to Google", () => {
    const url = new URL(normalizeBrowserUrl("rust tauri webview"));
    expect(url.host).toBe("www.google.com");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toContain("rust");
    // A dot accompanied by spaces is still a search query.
    const url2 = new URL(normalizeBrowserUrl("what is tauri 2.0"));
    expect(url2.host).toBe("www.google.com");
  });

  it("rejects an illegal scheme", () => {
    expect(() => normalizeBrowserUrl("file:///etc/hosts")).toThrow();
    expect(() => normalizeBrowserUrl("ftp://example.com")).toThrow();
    // javascript:/data: lack "://", so non-domain handling turns them into harmless search queries; never preserve the original scheme.
    const url = new URL(normalizeBrowserUrl("javascript:alert(1)"));
    expect(url.host).toBe("www.google.com");
  });

  it("allows about:blank, case-insensitively", () => {
    expect(normalizeBrowserUrl("about:blank")).toBe("about:blank");
    expect(normalizeBrowserUrl("ABOUT:BLANK")).toBe("about:blank");
  });

  it("rejects empty and whitespace-only input", () => {
    expect(() => normalizeBrowserUrl("")).toThrow();
    expect(() => normalizeBrowserUrl("   ")).toThrow();
  });
});
