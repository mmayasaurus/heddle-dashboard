//! Mermaid rendering plugin injected into Milkdown (ProseMirror).
//!
//! To prevent formatting churn, it adds no document nodes and does not alter Markdown serialization.
//! Fenced Mermaid blocks remain unchanged; a noneditable widget decoration below each block renders
//! the diagram, while source mode continues to show the fence.
//!
//! Import every ProseMirror component through `@milkdown/kit/prose/*` to share Milkdown's instances;
//! otherwise decorations fail. This matches pmSearch.ts.
//!
//! Rendering schedule:
//! - Initialization builds decorations immediately when opening or switching modes.
//! - Edits only map decoration positions; after 300 ms idle, rebuild changed diagrams to avoid
//!   per-keystroke flicker.
//! - A documentElement `data-theme` observer rebuilds immediately after theme changes.

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { t } from "../../../i18n";
import { cachedMermaidSvg, renderMermaid, type DiagramTheme } from "./mermaid";

export const pmMermaidKey = new PluginKey<DecorationSet>("vlxMermaid");

/** Idle interval before rerendering changed diagrams. */
const REBUILD_DEBOUNCE_MS = 300;

function currentTheme(): DiagramTheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Defensively recognize Mermaid blocks: a code_block or block node marked by spec.code, with a
 * language/lang attribute equal to mermaid. Return its source or null. */
function mermaidSource(node: PMNode): string | null {
  const isCodeBlock = node.type.name === "code_block" || node.type.spec?.code === true;
  if (!isCodeBlock || !node.isBlock) return null;
  const attrs = (node.attrs ?? {}) as Record<string, unknown>;
  const lang = String(attrs.language ?? attrs.lang ?? "")
    .trim()
    .toLowerCase();
  return lang === "mermaid" ? node.textContent : null;
}

/** Create a diagram container, filling cached output synchronously or rendering asynchronously with an error fallback. */
function buildDiagramDom(theme: DiagramTheme, src: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "vlx-mermaid";
  wrap.contentEditable = "false";

  const cached = cachedMermaidSvg(theme, src);
  if (cached) {
    wrap.innerHTML = cached;
    return wrap;
  }

  wrap.classList.add("vlx-mermaid-loading");
  void renderMermaid(theme, src).then((res) => {
    wrap.classList.remove("vlx-mermaid-loading");
    if (res.svg) {
      wrap.innerHTML = res.svg;
    } else {
      wrap.classList.add("vlx-mermaid-error");
      // Use textContent so error messages can never inject HTML.
      wrap.textContent = `${t("doc.diagramError")}: ${res.error ?? ""}`;
    }
  });
  return wrap;
}

/** Add a widget after every Mermaid block. Keys contain ordinal, theme, and source so unchanged
 * diagrams reuse their DOM across rebuilds; source or theme changes create a new widget. */
function buildDecorations(doc: PMNode, theme: DiagramTheme): DecorationSet {
  const decos: Decoration[] = [];
  let idx = 0;
  doc.descendants((node, pos) => {
    const src = mermaidSource(node);
    if (src == null) return;
    idx += 1;
    if (!src.trim()) return; // Do not render empty blocks.
    const at = pos + node.nodeSize; // Position after the code block.
    const key = `mermaid:${idx}:${theme}:${src}`;
    decos.push(
      Decoration.widget(at, () => buildDiagramDom(theme, src), { key, side: 1 }),
    );
  });
  return DecorationSet.create(doc, decos);
}

export function pmMermaidPlugin(): Plugin<DecorationSet> {
  let debounceTimer: number | null = null;

  return new Plugin<DecorationSet>({
    key: pmMermaidKey,
    state: {
      init: (_config, state) => buildDecorations(state.doc, currentTheme()),
      apply(tr, prev) {
        // Rebuild metadata after debounce or theme change using the current document and theme.
        if (tr.getMeta(pmMermaidKey)) return buildDecorations(tr.doc, currentTheme());
        // Normal edits only remap positions and retain diagrams until the view's debounced rebuild.
        return prev.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return pmMermaidKey.getState(state) ?? DecorationSet.empty;
      },
    },
    view(view: EditorView) {
      const scheduleRebuild = () => {
        if (debounceTimer != null) clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
          debounceTimer = null;
          if (view.isDestroyed) return;
          view.dispatch(view.state.tr.setMeta(pmMermaidKey, true));
        }, REBUILD_DEBOUNCE_MS);
      };
      // Observe documentElement data-theme and rerender immediately without debounce.
      const observer = new MutationObserver(() => {
        if (view.isDestroyed) return;
        view.dispatch(view.state.tr.setMeta(pmMermaidKey, true));
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      return {
        update(_v, prevState) {
          // Rebuild changed diagrams after the document-edit debounce.
          if (!_v.state.doc.eq(prevState.doc)) scheduleRebuild();
        },
        destroy() {
          observer.disconnect();
          if (debounceTimer != null) clearTimeout(debounceTimer);
        },
      };
    },
  });
}
