import { describe, expect, it } from "vitest";

import { compareVersions, sliceReleaseNotes } from "./updateNotes";

/** Mirror the real docs/changelog.md shape: headings include a v prefix and date, with sections separated by ---. */
const CHANGELOG = `# Changelog

> Created: 2026-07-09 16:10

All notable changes are documented here, newest first.

---

## v0.1.92 — 2026-07-09

### Fixed

- **No more false warnings.** The tunnel monitor used to misread the child exit.

---

## v0.1.91 — 2026-07-09 00:00

**First public release.**

### Session organisation

- A three-level tree — project, group, session.
`;

describe("compareVersions", () => {
  it("compares segments numerically rather than lexicographically", () => {
    // Lexical order places "0.1.9" after "0.1.10"; semantic version order must reverse that result.
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
  });

  it("treats missing segments as 0 when the counts differ", () => {
    expect(compareVersions("0.2", "0.2.0")).toBe(0);
    expect(compareVersions("0.2", "0.2.1")).toBeLessThan(0);
  });

  it("ignores the v prefix and any pre-release suffix", () => {
    expect(compareVersions("v0.1.92", "0.1.92")).toBe(0);
    expect(compareVersions("0.1.92-beta.1", "0.1.92")).toBe(0);
  });
});

describe("sliceReleaseNotes", () => {
  it("includes every intermediate section when several versions are skipped", () => {
    const out = sliceReleaseNotes(CHANGELOG, "0.1.88");
    expect(out).toContain("## v0.1.92");
    expect(out).toContain("## v0.1.91");
    expect(out).toContain("First public release");
  });

  it("keeps only the sections newer than the current version", () => {
    const out = sliceReleaseNotes(CHANGELOG, "0.1.91");
    expect(out).toContain("## v0.1.92");
    expect(out).not.toContain("## v0.1.91");
  });

  it("returns an empty string when already on the newest version", () => {
    expect(sliceReleaseNotes(CHANGELOG, "0.1.92")).toBe("");
  });

  it("drops the file header and the rules that end each section", () => {
    const out = sliceReleaseNotes(CHANGELOG, "0.1.91");
    expect(out.startsWith("## v0.1.92")).toBe(true);
    expect(out.trimEnd().endsWith("---")).toBe(false);
  });

  it("returns the text unchanged when no version heading is recognised, which beats showing nothing", () => {
    // This is the shape of the old placeholder notes.
    expect(sliceReleaseNotes("heddle 0.1.92", "0.1.91")).toBe("heddle 0.1.92");
  });

  it("does not treat a ## inside a code block as a version heading", () => {
    // The code-block line deliberately uses a version lower than current. If mistaken for a version heading, the
    // entire section, including the closing ```, would be removed as not newer than current and disappear from output.
    const md = ["## v2.0.0", "", "Example:", "", "```md", "## v0.0.1", "```", ""].join("\n");
    const out = sliceReleaseNotes(md, "1.0.0");
    expect(out.startsWith("## v2.0.0")).toBe(true);
    expect(out).toContain("## v0.0.1"); // Preserve it verbatim as body text in the v2.0.0 section.
    expect(out).toContain("```");
  });

  it("returns an empty string for empty notes", () => {
    expect(sliceReleaseNotes("   \n  ", "0.1.0")).toBe("");
  });
});
