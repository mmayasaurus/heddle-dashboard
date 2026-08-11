//! Data model and extension classifiers for center-pane document tabs opened by `vopen`. Extracted
//! from termStore because these types and helpers are self-contained and shared by DocView.

import { genId } from "../genId";

/**
 * Document content type used by DocView dispatch:
 * markdown supports WYSIWYG and source modes; image uses the built-in viewer; code uses the source
 * editor with filename-based language highlighting and plain-text fallback.
 */
export type DocKind = "markdown" | "code" | "image";

export interface DocTab {
  /** `"doc-" + genId()`, used as the visible openTabs ID. */
  id: string;
  /** Canonical absolute path suitable for exact deduplication. New drafts use an empty path until
   * their first Save As assigns the real path. */
  path: string;
  /** Basename displayed in the tab bar. */
  title: string;
  /** Content type controlling editor/viewer dispatch; only Markdown exposes a mode switch. */
  kind: DocKind;
  /** Current editor mode; meaningful for Markdown, while code/image retain the source placeholder. */
  mode: "wysiwyg" | "source";
  /** Unsaved-change flag used by the tab indicator and close confirmation; always false for images. */
  dirty: boolean;
  /** Pending close confirmation set for dirty tabs so DocView renders the three-way prompt. */
  pendingClose: boolean;
  /**
   * Refresh generation. Incrementing asks DocView to reread disk after deduplicated `view` focus or
   * the tab refresh action. Unsaved changes trigger the external-change banner instead of being lost.
   */
  reloadNonce: number;
  /** New unsaved draft with an empty path. DocView skips disk I/O and uses Save As. Existing files
   * opened by view leave this undefined; setDocTabPath clears it after persistence. */
  isNew?: boolean;
}

/** Markdown-family extensions start as kind=markdown in WYSIWYG mode. */
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);

/** Image extensions use kind=image and the built-in viewer. */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);

/** Classify by extension; all other files, including extensionless paths, are code. */
export function docKindOf(path: string): DocKind {
  const title = path.split("/").pop() || path;
  const ext = title.includes(".") ? title.split(".").pop()!.toLowerCase() : "";
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "code";
}

/** Create document-tab metadata for a path. */
export function makeDocTab(path: string): DocTab {
  const title = path.split("/").pop() || path;
  const kind = docKindOf(path);
  return {
    id: `doc-${genId()}`,
    path,
    title,
    kind,
    mode: kind === "markdown" ? "wysiwyg" : "source",
    dirty: false,
    pendingClose: false,
    reloadNonce: 0,
  };
}
