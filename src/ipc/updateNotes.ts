//! Release-note slicing: extract changelog sections newer than the user's installed version.
//!
//! `latest.json.notes` contains the complete docs/changelog.md written by scripts/lib-updater.sh.
//! The server returns this static text without knowing the client's installed version, so the client
//! compares it with `update.currentVersion` and renders only newer sections.
//!
//! A user on 0.1.88 therefore sees the complete 0.1.91 and 0.1.92 sections, not only the latest one.
//!
//! All three exports are pure functions without network or DOM access.

/** Version heading such as `## v0.1.92 — 2026-07-09`; the v prefix, brackets, and date are optional. */
const HEADING_RE = /^##\s+\[?v?(\d+(?:\.\d+)*)\]?/;

/** Fenced-code delimiters; `## ` inside a fence is not a version heading. */
const FENCE_RE = /^\s*(?:```|~~~)/;

/** Separator composed only of `---` or `***`. */
const RULE_RE = /^(?:-{3,}|\*{3,})$/;

/** Split a version into numeric segments, discarding prerelease and build metadata. */
function versionParts(version: string): number[] {
  const core = version.trim().replace(/^v/i, "").split(/[-+]/)[0];
  return core.split(".").map((seg) => {
    const n = Number.parseInt(seg, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

/**
 * Compare versions: positive when a is newer, negative when b is newer, zero when equal. Missing
 * segments count as zero, so `0.2` equals `0.2.0` and precedes `0.2.1`.
 */
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Trim trailing blank lines and separators, which delimit sections rather than belonging to one. */
function trimSection(lines: string[]): string {
  const out = [...lines];
  while (out.length > 0) {
    const last = out[out.length - 1].trim();
    if (last === "" || RULE_RE.test(last)) out.pop();
    else break;
  }
  return out.join("\n");
}

interface ReleaseNoteSection {
  version: string;
  markdown: string;
}

/** Parse changelog version sections, returning null for unsliceable legacy placeholder text. */
function releaseNoteSections(notes: string): ReleaseNoteSection[] | null {
  const lines = notes.split(/\r?\n/);
  const starts: { line: number; version: string }[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(lines[i]);
    if (m) starts.push({ line: i, version: m[1] });
  }
  if (starts.length === 0) return null;

  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].line : lines.length;
    return {
      version: start.version,
      markdown: trimSection(lines.slice(start.line, end)),
    };
  });
}

/**
 * Extract sections newer than `currentVersion` and reassemble them in their original newest-first order.
 *
 * @param notes Complete Markdown changelog from `update.body`.
 * @param currentVersion Installed version, such as `0.1.88`.
 * @returns Reassembled Markdown. If no version heading exists, preserve legacy placeholder text so
 *   the dialog still displays useful content.
 */
export function sliceReleaseNotes(notes: string, currentVersion: string): string {
  if (!notes.trim()) return "";

  const sections = releaseNoteSections(notes);
  if (!sections) return notes.trim();
  return sections
    .filter((section) => compareVersions(section.version, currentVersion) > 0)
    .map((section) => section.markdown)
    .join("\n\n")
    .trim();
}

/**
 * Merge a localized changelog with the English baseline by version:
 * - use localized content where available;
 * - fall back to English only for individual missing versions;
 * - when English is legacy placeholder text, prefer parseable localized content or retain the placeholder.
 */
export function localizeReleaseNotes(
  notes: string,
  localizedNotes: string,
  currentVersion: string,
): string {
  const baseSections = releaseNoteSections(notes);
  const translatedSections = releaseNoteSections(localizedNotes);

  if (!baseSections) {
    const translated = sliceReleaseNotes(localizedNotes, currentVersion);
    return translated || notes.trim();
  }
  if (!translatedSections) return sliceReleaseNotes(notes, currentVersion);

  return baseSections
    .filter((section) => compareVersions(section.version, currentVersion) > 0)
    .map((section) => {
      const translated = translatedSections.find(
        (candidate) => compareVersions(candidate.version, section.version) === 0,
      );
      return translated?.markdown || section.markdown;
    })
    .join("\n\n")
    .trim();
}
