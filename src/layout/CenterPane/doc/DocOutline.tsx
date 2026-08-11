//! Document outline: parse ATX headings (# through ######) from Markdown, ignoring # inside fenced code blocks,
//! and list them with hierarchical indentation. Clicking a heading scrolls to the Nth heading in the ProseMirror
//! DOM in WYSIWYG mode or to its line number in source mode. Both derive from the same Markdown, so their indices
//! align naturally. DocView controls parsing on load, reload, and debounced edits; this component only renders
//! and handles clicks.

import { useT } from "../../../i18n";

export interface OutlineHeading {
  /** 1~6。 */
  level: number;
  text: string;
  /** Zero-based line number in the parsed text, used for source-mode navigation. */
  line: number;
}

/** Parse ATX headings from Markdown, skipping every line inside ``` / ~~~ fenced code blocks. */
export function parseOutline(md: string): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  const lines = md.split("\n");
  let fence: string | null = null; // Current fence marker (` or ~); null when outside a fence.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      const ch = f[1][0];
      if (fence == null) fence = ch;
      else if (ch === fence) fence = null;
      continue;
    }
    if (fence != null) continue;
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    // Remove an optional closing # sequence and surrounding whitespace; ATX permits "## heading ##".
    const text = m[2].replace(/\s+#+\s*$/, "").trim();
    if (text) out.push({ level: m[1].length, text, line: i });
  }
  return out;
}

/** Outline list displayed in the sidebar's Outline tab. */
export function DocOutline({
  headings,
  onJump,
}: {
  headings: OutlineHeading[];
  onJump: (idx: number) => void;
}) {
  const t = useT();
  if (headings.length === 0) {
    return <div className="docview-tree-empty">{t("doc.outlineEmpty")}</div>;
  }
  // Indent relative to the shallowest level so a document beginning at ## does not waste horizontal space.
  const minLevel = Math.min(...headings.map((h) => h.level));
  return (
    <div className="docview-outline">
      {headings.map((h, i) => (
        <div
          key={`${h.line}:${h.text}`}
          className={"docview-outline-row lv" + h.level}
          style={{ paddingLeft: 10 + (h.level - minLevel) * 13 }}
          title={h.text}
          onClick={() => onJump(i)}
        >
          {h.text}
        </div>
      ))}
    </div>
  );
}
