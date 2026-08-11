//! Mermaid rendering helper with theme configuration, serialized rendering, DOMPurify sanitization,
//! and a cache keyed by theme and source.
//!
//! Adapted from Orca's MermaidBlock for vlx theme and security conventions:
//! - `mermaid.render()` mutates global DOM state, including element IDs and parser state, so a
//!   single promise chain serializes all renders. After each render the chain collapses to one
//!   resolved promise, allowing captured source and containers to be collected.
//! - DOMPurify sanitizes the resulting SVG as defense in depth, even though Mermaid strict mode
//!   already sanitizes it. This matches the image viewer's controlled-SVG policy.
//! - Results are cached by `theme:source`, avoiding flicker and rerendering when decorations rebuild.

import mermaid from "mermaid";
import DOMPurify from "dompurify";

export type DiagramTheme = "dark" | "light";

/** Serialize all Mermaid renders to prevent concurrent global-state mutations. */
let queue: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task, task).then(() => {
    // Collapse to a resolved promise so closures capturing source and containers can be collected.
    queue = Promise.resolve();
  });
}

/** Rendered SVG cache keyed by `${theme}:${src}`. */
const svgCache = new Map<string, string>();

function cacheKey(theme: DiagramTheme, src: string): string {
  return `${theme}:${src}`;
}

/** Return a cached SVG for the same theme and source, allowing synchronous decoration. */
export function cachedMermaidSvg(theme: DiagramTheme, src: string): string | undefined {
  return svgCache.get(cacheKey(theme, src));
}

let idSeq = 0;

export interface MermaidResult {
  svg?: string;
  error?: string;
}

/**
 * Render Mermaid source to a sanitized SVG. Return cached output immediately; otherwise enqueue
 * the render. Syntax and other failures return `{ error }` for graceful display without disrupting the editor.
 */
export function renderMermaid(theme: DiagramTheme, src: string): Promise<MermaidResult> {
  const key = cacheKey(theme, src);
  const hit = svgCache.get(key);
  if (hit) return Promise.resolve({ svg: hit });

  return new Promise<MermaidResult>((resolve) => {
    enqueue(async () => {
      // Initialize inside the serialized task so another render cannot change the theme before render().
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: theme === "dark" ? "dark" : "default",
      });
      const renderId = `vlx-mermaid-${idSeq++}`;
      try {
        const { svg } = await mermaid.render(renderId, src);
        const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } });
        svgCache.set(key, clean);
        resolve({ svg: clean });
      } catch (e) {
        // Mermaid inserts a temporary `d{renderId}` error element into the document on failure; remove it.
        document.getElementById(`d${renderId}`)?.remove();
        resolve({ error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
}
