//! Right-side Files tab: lazily loads the real directory tree from the session cwd, with Git badges,
//! hidden-item filtering, search, file preview, and create/edit/delete context actions. Extracted from
//! RightPanel; FileNodeT, FileRow, ConfirmModal, and related helpers remain private to this tab.

import { useEffect, useRef, useState } from "react";
import Icons from "../../components/Icons";
import { Backdrop } from "../../components/Backdrop";
import { fileIcon } from "./fileIcons";
import { highlight } from "./highlight";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { FormModal } from "../../components/FormModal";
import { useT } from "../../i18n";
import {
  copyText,
  createDir,
  createFile,
  deletePath,
  listDir,
  readFilePreview,
  renamePath,
  revealPath,
  type DirEntry,
  type FilePreview,
} from "../../ipc/info";
import { useTermStore } from "../../store/termStore";
/* ===================== Files: real tree, preview, and one-level lazy loading ===================== */

interface FileNodeT {
  name: string;
  /** Absolute path. */
  path: string;
  isDir: boolean;
  /** Whether this is a dot-prefixed hidden item, omitted when showHidden is off. */
  isHidden: boolean;
  badge?: string | null;
  open?: boolean;
  /** Whether children have been loaded from the backend. */
  loaded?: boolean;
  loading?: boolean;
  children?: FileNodeT[];
}

/** Convert a backend DirEntry to a frontend node with an absolute path. */
function toNode(e: DirEntry, parentPath: string): FileNodeT {
  return {
    name: e.name,
    path: `${parentPath}/${e.name}`,
    isDir: e.isDir,
    isHidden: e.isHidden,
    badge: e.gitBadge,
    open: false,
    loaded: false,
  };
}

/** Parent of an absolute path, used to target and refresh create/rename operations. */
function parentPathOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/** Find a tree node by absolute path to locate directories that need refreshing. */
function findNodeByPath(root: FileNodeT | null, path: string): FileNodeT | null {
  if (!root) return null;
  if (root.path === path) return root;
  for (const c of root.children || []) {
    const f = findNodeByPath(c, path);
    if (f) return f;
  }
  return null;
}

/** Whether a node name or loaded descendant matches the lowercase query. */
function nodeMatches(node: FileNodeT, q: string): boolean {
  if (node.name.toLowerCase().includes(q)) return true;
  return (node.children || []).some((c) => nodeMatches(c, q));
}

/** Flatten currently visible rows for keyboard navigation, using the renderer's expand/filter rules. */
function flattenVisible(root: FileNodeT, showHidden: boolean, q: string): FileNodeT[] {
  const out: FileNodeT[] = [];
  const walk = (node: FileNodeT) => {
    out.push(node);
    if (!node.isDir) return;
    const open = q ? true : !!node.open;
    if (!open) return;
    let kids = (node.children || []).filter((c) => showHidden || !c.isHidden);
    if (q) kids = kids.filter((c) => nodeMatches(c, q));
    kids.forEach(walk);
  };
  walk(root);
  return out;
}

/** Render project outline icons with muted type colors from fileIcons.tsx. Strokes use currentColor,
 * and directories switch between folder and folderOpen according to `open`. */
function renderFileIcon(name: string, isDir: boolean, open = false) {
  const { icon, color } = fileIcon(name, isDir, open);
  const Cmp = Icons[icon] ?? Icons.file;
  return <Cmp size={isDir ? 14 : 13} style={{ color }} />;
}

function FileRow({
  node,
  depth,
  selPath,
  focusPath,
  showHidden,
  filter,
  onFile,
  onOpen,
  onDir,
  onContext,
}: {
  node: FileNodeT;
  depth: number;
  selPath: string | null;
  focusPath: string | null;
  showHidden: boolean;
  /** Lowercase trimmed query; forces matching directories open and hides nonmatching items. */
  filter: string;
  onFile: (n: FileNodeT) => void;
  onOpen: (n: FileNodeT) => void;
  onDir: (n: FileNodeT) => void;
  onContext: (e: React.MouseEvent, n: FileNodeT) => void;
}) {
  const t = useT();
  // Each depth gets a 13px indentation cell with a subtle `.ind` guide for legible nesting.
  const inds =
    depth > 0 ? (
      <span className="inds">
        {Array.from({ length: depth }, (_, i) => (
          <i key={i} className="ind" />
        ))}
      </span>
    ) : null;
  // Filtering forces expansion; clearing the query restores node.open.
  const open = filter ? true : !!node.open;
  const focusCls = focusPath === node.path ? " kbd-focus" : "";
  if (node.isDir) {
    // When hidden items are off, omit a dot-prefixed directory and its entire subtree.
    let kids = (node.children || []).filter((c) => showHidden || !c.isHidden);
    if (filter) kids = kids.filter((c) => nodeMatches(c, filter));
    return (
      <div>
        <div
          className={"file-row" + (node.isHidden ? " hidden-entry" : "") + focusCls}
          onClick={() => onDir(node)}
          onContextMenu={(e) => onContext(e, node)}
        >
          {inds}
          <span className="tw">{open ? <Icons.chevD size={13} /> : <Icons.chevR size={13} />}</span>
          <span className="ic">{renderFileIcon(node.name, true, open)}</span>
          <span className="nm">{node.name}</span>
        </div>
        {open &&
          (node.loading ? (
            // While loading children, show an indented spinner row instead of an empty expansion.
            <div className="file-row loading-row">
              <span className="inds">
                {Array.from({ length: depth + 1 }, (_, i) => (
                  <i key={i} className="ind" />
                ))}
              </span>
              <span className="tw">
                <span className="spin" style={{ display: "inline-flex" }}>
                  <Icons.restart size={12} />
                </span>
              </span>
              <span className="nm" style={{ color: "var(--text-faint)" }}>
                {t("common.loading")}
              </span>
            </div>
          ) : (
            kids.map((c) => (
              <FileRow
                key={c.path}
                node={c}
                depth={depth + 1}
                selPath={selPath}
                focusPath={focusPath}
                showHidden={showHidden}
                filter={filter}
                onFile={onFile}
                onOpen={onOpen}
                onDir={onDir}
                onContext={onContext}
              />
            ))
          ))}
      </div>
    );
  }
  return (
    <div
      className={
        "file-row" +
        (selPath === node.path ? " sel" : "") +
        (node.isHidden ? " hidden-entry" : "") +
        focusCls
      }
      onClick={() => onFile(node)}
      onDoubleClick={() => onOpen(node)}
      onContextMenu={(e) => onContext(e, node)}
    >
      {inds}
      <span className="tw leaf" />
      <span className="ic">{renderFileIcon(node.name, false)}</span>
      <span className="nm">{node.name}</span>
      {node.badge && <span className={"gb gb-" + node.badge}>{node.badge}</span>}
    </div>
  );
}

export function FilesTab({ rootPath, rootName }: { rootPath: string | null; rootName: string | null }) {
  const t = useT();
  const [root, setRoot] = useState<FileNodeT | null>(null);
  const [sel, setSel] = useState<FileNodeT | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  // Preview is explicit: clicks only select; the context-menu Preview action loads the bottom pane.
  // previewNode is independent of selection, and null hides the preview pane.
  const [previewNode, setPreviewNode] = useState<FileNodeT | null>(null);
  // Resizable preview-pane height in pixels; the flex tree consumes the remaining space.
  const [previewH, setPreviewH] = useState(220);
  // Hide dotfiles by default, like system file browsers. The header toggle is in-memory only.
  const [showHidden, setShowHidden] = useState(false);
  // Context menu state; creation targets the clicked node's containing directory.
  const [menu, setMenu] = useState<{ x: number; y: number; node: FileNodeT } | null>(null);
  // Create/rename dialog state. Create within `dir`; rename `node` and refresh its containing `dir`.
  const [dialog, setDialog] = useState<
    { mode: "newFile" | "newDir" | "rename"; dir: FileNodeT; node?: FileNodeT } | null
  >(null);
  // Delete confirmation state and containing directory to refresh afterward.
  const [del, setDel] = useState<{ node: FileNodeT; dir: FileNodeT } | null>(null);
  // Dismissible operation error such as a duplicate name or insufficient permission.
  const [err, setErr] = useState<string | null>(null);
  // Quick filter state: filterOn controls visibility; q is the normalized value passed to the tree.
  const [filterOn, setFilterOn] = useState(false);
  const [filter, setFilter] = useState("");
  // Keyboard focus row, independent of selected preview; focusing a file also previews it.
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  // Container for the tree and preview, whose height bounds preview resizing.
  const wrapRef = useRef<HTMLDivElement>(null);
  const q = filter.trim().toLowerCase();

  // Rebuild the root and load its first level when the session root changes.
  useEffect(() => {
    setSel(null);
    setPreview(null);
    setPreviewNode(null);
    if (!rootPath) {
      setRoot(null);
      return;
    }
    const node: FileNodeT = {
      name: rootName || rootPath.split("/").filter(Boolean).pop() || rootPath,
      path: rootPath,
      isDir: true,
      isHidden: false,
      open: true,
      loaded: false,
      loading: true,
    };
    setRoot(node);
    let cancelled = false;
    listDir(rootPath)
      .then((kids) => {
        if (cancelled) return;
        node.children = kids.map((k) => toNode(k, rootPath));
        node.loaded = true;
        node.loading = false;
        setRoot({ ...node });
      })
      .catch(() => {
        if (cancelled) return;
        node.children = [];
        node.loaded = true;
        node.loading = false;
        setRoot({ ...node });
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, rootName]);

  // Toggle a directory, fetching its children before the first expansion.
  const onDir = async (node: FileNodeT) => {
    if (node.loaded) {
      node.open = !node.open;
      setRoot((r) => (r ? { ...r } : r));
      return;
    }
    node.loading = true;
    node.open = true;
    setRoot((r) => (r ? { ...r } : r));
    try {
      const kids = await listDir(node.path);
      node.children = kids.map((k) => toNode(k, node.path));
    } catch {
      node.children = [];
    }
    node.loaded = true;
    node.loading = false;
    setRoot((r) => (r ? { ...r } : r));
  };

  // Clicking a file selects it without previewing; Preview is an explicit context-menu action.
  const onFile = (node: FileNodeT) => {
    setSel(node);
  };

  // Preview selects a file and loads its contents into the bottom pane.
  const doPreview = async (node: FileNodeT) => {
    if (node.isDir) return;
    setSel(node);
    setPreviewNode(node);
    setPreview(null);
    try {
      setPreview(await readFilePreview(node.path));
    } catch {
      setPreview({ content: t("panel.cantRead"), truncated: false, binary: false });
    }
  };

  // Close the preview pane.
  const closePreview = () => {
    setPreviewNode(null);
    setPreview(null);
  };

  // Resize preview vertically, clamping its bounds to the container height.
  const startPreviewResize = (e: React.MouseEvent) => {
    e.preventDefault();
    let last = e.clientY;
    const onMove = (ev: MouseEvent) => {
      const dy = ev.clientY - last;
      last = ev.clientY;
      setPreviewH((h) => {
        const cap = (wrapRef.current?.clientHeight ?? 600) - 160;
        const max = cap > 120 ? cap : 120;
        return Math.max(80, Math.min(max, h - dy));
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "row-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Double-click a file to open it in the center document editor.
  const onOpen = (node: FileNodeT) => {
    if (!node.isDir) useTermStore.getState().openDocTab(node.path);
  };

  // Reload a directory's immediate children after mutation while keeping it expanded.
  const reloadDir = async (node: FileNodeT) => {
    try {
      node.children = (await listDir(node.path)).map((k) => toNode(k, node.path));
    } catch {
      node.children = [];
    }
    node.loaded = true;
    node.open = true;
    setRoot((r) => (r ? { ...r } : r));
  };

  // Open the context menu at the pointer; create in the directory itself or a file's parent.
  const onContext = (e: React.MouseEvent, node: FileNodeT) => {
    e.preventDefault();
    e.stopPropagation();
    setErr(null);
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  // The header + is equivalent to opening the root context menu beneath the button.
  const onPlus = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setErr(null);
    if (root) setMenu({ x: r.left, y: r.bottom + 4, node: root });
  };

  // Display path relative to the root for Copy Relative Path.
  const relativeTo = (p: string) =>
    root && p === root.path
      ? root.name
      : root && p.startsWith(root.path + "/")
        ? p.slice(root.path.length + 1)
        : p;

  // Open a scratch terminal at a directory or a file's parent by passing cwd to newScratchTab.
  const openInTerminal = (node: FileNodeT) => {
    const dir = node.isDir ? node.path : parentPathOf(node.path);
    const nm = dir.split("/").filter(Boolean).pop() || dir;
    useTermStore.getState().newScratchTab({ cwd: dir, name: nm });
  };

  // Scroll the keyboard-focused row into view.
  useEffect(() => {
    if (!focusPath) return;
    treeRef.current?.querySelector(".kbd-focus")?.scrollIntoView({ block: "nearest" });
  }, [focusPath]);

  // Focus a row and preview it when it is a file.
  const focusRow = (n: FileNodeT) => {
    setFocusPath(n.path);
    if (!n.isDir) void onFile(n);
  };

  // Tree keys: arrows navigate/expand/collapse, and Enter opens a file or expands a directory.
  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    if (!root) return;
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Enter"].includes(e.key)) return;
    const rows = flattenVisible(root, showHidden, q);
    if (!rows.length) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = rows.findIndex((n) => n.path === focusPath);
    const cur = idx >= 0 ? rows[idx] : null;
    const isOpen = (n: FileNodeT) => (q ? true : !!n.open);
    switch (e.key) {
      case "ArrowDown":
        focusRow(rows[idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1)]);
        break;
      case "ArrowUp":
        focusRow(rows[idx <= 0 ? 0 : idx - 1]);
        break;
      case "ArrowRight":
        if (cur?.isDir && !isOpen(cur)) void onDir(cur);
        else if (cur?.isDir && idx + 1 < rows.length) focusRow(rows[idx + 1]);
        break;
      case "ArrowLeft":
        if (cur?.isDir && isOpen(cur)) void onDir(cur);
        else if (cur) {
          const parent = rows.find((n) => n.path === parentPathOf(cur.path));
          if (parent) focusRow(parent);
        }
        break;
      case "Enter":
        if (cur?.isDir) void onDir(cur);
        else if (cur) onOpen(cur);
        break;
    }
  };

  // Build node-specific actions for open, reveal, refresh, create, copy path, rename, and delete.
  const menuItems = (node: FileNodeT): MenuItem[] => {
    const dir = node.isDir ? node : findNodeByPath(root, parentPathOf(node.path)) ?? root!;
    const isRoot = !!root && node.path === root.path;
    const parent = findNodeByPath(root, parentPathOf(node.path)) ?? root!;
    return [
      {
        label: t("files.newFile"),
        icon: <Icons.filePlus size={14} />,
        onClick: () => {
          setErr(null);
          setDialog({ mode: "newFile", dir });
        },
      },
      {
        label: t("files.newFolder"),
        icon: <Icons.folder size={14} />,
        onClick: () => {
          setErr(null);
          setDialog({ mode: "newDir", dir });
        },
      },
      { separator: true, label: "" },
      // Group editor (files only), terminal, and file-manager open/reveal actions.
      ...(!node.isDir
        ? ([
            {
              label: t("panel.preview"),
              icon: <Icons.eye size={14} />,
              onClick: () => void doPreview(node),
            },
            {
              label: t("panel.openInEditor"),
              icon: <Icons.code size={14} />,
              onClick: () => onOpen(node),
            },
          ] as MenuItem[])
        : []),
      {
        label: t("files.openInTerminal"),
        icon: <Icons.terminal size={14} />,
        onClick: () => openInTerminal(node),
      },
      {
        label: t("files.revealInFinder"),
        icon: <Icons.reveal size={14} />,
        onClick: () => void revealPath(node.path),
      },
      {
        label: t("common.refresh"),
        icon: <Icons.restart size={14} />,
        onClick: () => void reloadDir(dir),
      },
      { separator: true, label: "" },
      {
        label: t("files.copyPath"),
        icon: <Icons.copy size={14} />,
        onClick: () => void copyText(node.path),
      },
      {
        label: t("files.copyRelPath"),
        icon: <Icons.copy size={14} />,
        onClick: () => void copyText(relativeTo(node.path)),
      },
      { separator: true, label: "" },
      {
        label: t("common.rename"),
        icon: <Icons.rename size={14} />,
        disabled: isRoot,
        onClick: () => {
          setErr(null);
          setDialog({ mode: "rename", dir: parent, node });
        },
      },
      {
        label: t("common.delete"),
        icon: <Icons.trash size={14} />,
        danger: true,
        disabled: isRoot,
        onClick: () => {
          setErr(null);
          setDel({ node, dir: parent });
        },
      },
    ];
  };

  // Submit a create or rename operation.
  const submitDialog = async (rawName: string) => {
    const name = rawName.trim();
    if (!dialog || !name) return;
    const d = dialog;
    setDialog(null);
    try {
      if (d.mode === "rename" && d.node) {
        const to = `${parentPathOf(d.node.path)}/${name}`;
        if (to === d.node.path) return; // The name did not change.
        await renamePath(d.node.path, to);
        if (sel?.path === d.node.path) setSel(null);
        if (previewNode?.path === d.node.path) closePreview();
        await reloadDir(d.dir);
      } else {
        const path = `${d.dir.path}/${name}`;
        if (d.mode === "newFile") {
          await createFile(path);
          await reloadDir(d.dir);
          useTermStore.getState().openDocTab(path); // Open a new file immediately for editing.
        } else {
          await createDir(path);
          await reloadDir(d.dir);
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  // Execute deletion after confirmation.
  const doDelete = async () => {
    if (!del) return;
    const d = del;
    setDel(null);
    try {
      await deletePath(d.node.path);
      // Clear selection and preview when they reference the deleted item or a descendant.
      if (sel && (sel.path === d.node.path || sel.path.startsWith(d.node.path + "/"))) {
        setSel(null);
      }
      if (
        previewNode &&
        (previewNode.path === d.node.path || previewNode.path.startsWith(d.node.path + "/"))
      ) {
        closePreview();
      }
      await reloadDir(d.dir);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (!root) {
    return (
      <div className="insp-section" style={{ color: "var(--text-faint)" }}>
        {t("panel.noSession")}
      </div>
    );
  }

  const showPreview = !!previewNode;

  return (
    <div ref={wrapRef} style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div className="files-head">
        <span className="files-path" title={root.path}>{root.name}</span>
        <button
          className={"files-toggle" + (filterOn ? " on" : "")}
          title={t("files.filterPlaceholder")}
          aria-label={t("files.filterPlaceholder")}
          aria-pressed={filterOn}
          onClick={() => setFilterOn((v) => { if (v) setFilter(""); return !v; })}
        >
          <Icons.search size={13} />
        </button>
        <button className="files-toggle" title={t("files.newTooltip")} aria-label={t("files.newTooltip")} onClick={onPlus}>
          <Icons.filePlus size={13} />
        </button>
        <button
          className={"files-toggle" + (showHidden ? " on" : "")}
          title={showHidden ? t("panel.hideHidden") : t("panel.showHidden")}
          aria-label={showHidden ? t("panel.hideHidden") : t("panel.showHidden")}
          aria-pressed={showHidden}
          onClick={() => setShowHidden((v) => !v)}
        >
          {showHidden ? <Icons.eye size={13} /> : <Icons.eyeOff size={13} />}
        </button>
      </div>
      {filterOn && (
        <div className="files-filter">
          <Icons.search size={12} />
          <input
            autoFocus
            value={filter}
            placeholder={t("files.filterPlaceholder")}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFilter("");
                setFilterOn(false);
              }
            }}
          />
          {filter && (
            <button
              className="files-filter-clear"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={() => setFilter("")}
            >
              <Icons.x size={12} />
            </button>
          )}
        </div>
      )}
      {err && (
        <div className="files-err" title={err} onClick={() => setErr(null)}>
          {err}
        </div>
      )}
      <div
        ref={treeRef}
        tabIndex={0}
        className="files-tree"
        style={{ flex: "1 1 0", overflowY: "auto", minHeight: 0, outline: "none" }}
        onKeyDown={onTreeKeyDown}
        onContextMenu={(e) => {
          // Right-clicking empty tree space creates in the root directory.
          e.preventDefault();
          setErr(null);
          if (root) setMenu({ x: e.clientX, y: e.clientY, node: root });
        }}
      >
        <FileRow
          node={root}
          depth={0}
          selPath={sel?.path ?? null}
          focusPath={focusPath}
          showHidden={showHidden}
          filter={q}
          onFile={onFile}
          onOpen={onOpen}
          onDir={onDir}
          onContext={onContext}
        />
      </div>
      {showPreview && previewNode && (
        <>
          {/* Vertically draggable divider between the file tree and the preview pane. */}
          <div
            onMouseDown={startPreviewResize}
            title={t("splitter.dragToResize")}
            style={{ flex: "0 0 5px", cursor: "row-resize", position: "relative", zIndex: 5 }}
          >
            <div
              style={{ position: "absolute", left: 0, right: 0, top: 2, height: 1, background: "var(--border)" }}
            />
          </div>
          <div
            className="preview"
            style={{ flex: `0 0 ${previewH}px`, minHeight: 0, display: "flex", flexDirection: "column" }}
          >
            <div className="preview-head">
              {renderFileIcon(previewNode.name, false)}
              {previewNode.name}
              {previewNode.badge && <span className={"gb gb-" + previewNode.badge}>{previewNode.badge}</span>}
              <button
                title={t("panel.openInEditorTooltip")}
                style={{
                  marginLeft: "auto",
                  padding: "1px 8px",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "var(--r-sm)",
                  fontSize: 11,
                  color: "var(--text)",
                  flex: "none",
                }}
                onClick={() => useTermStore.getState().openDocTab(previewNode.path)}
              >
                {t("panel.openInEditor")}
              </button>
              <button
                title={t("common.close")}
                aria-label={t("common.close")}
                onClick={closePreview}
                style={{
                  flex: "none",
                  display: "grid",
                  placeItems: "center",
                  width: 20,
                  height: 20,
                  borderRadius: "var(--r-sm)",
                  border: "none",
                  background: "transparent",
                  color: "var(--text-faint)",
                  cursor: "pointer",
                }}
              >
                <Icons.x size={13} />
              </button>
            </div>
            <pre style={{ flex: 1, overflow: "auto" }}>
              {preview == null ? (
                t("common.loading")
              ) : preview.binary ? (
                t("panel.binary")
              ) : (
                <>
                  {highlight(preview.content)}
                  {preview.truncated ? t("panel.truncated") : null}
                </>
              )}
            </pre>
          </div>
        </>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.node)} onClose={() => setMenu(null)} />
      )}
      {dialog && (
        <FormModal
          title={
            dialog.mode === "rename"
              ? t("common.rename")
              : dialog.mode === "newDir"
                ? t("files.newFolder")
                : t("files.newFile")
          }
          fields={[{ key: "name", label: t("files.nameLabel"), required: true, autoFocus: true }]}
          initial={dialog.mode === "rename" ? { name: dialog.node?.name ?? "" } : undefined}
          submitLabel={dialog.mode === "rename" ? t("common.rename") : t("common.create")}
          onSubmit={(v) => void submitDialog(v.name)}
          onCancel={() => setDialog(null)}
        />
      )}
      {del && (
        <ConfirmModal
          body={t("files.deleteConfirm", del.node.name)}
          confirmLabel={t("common.delete")}
          onConfirm={() => void doDelete()}
          onCancel={() => setDel(null)}
        />
      )}
    </div>
  );
}

/** File deletion confirmation, separate from sessionMenu to avoid coupling file and session semantics. */
function ConfirmModal({
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <Backdrop onClose={onCancel}>
      <div
        style={{
          width: 340,
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 18,
          boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 18 }}>
          {body}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="vlx-btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            className="vlx-btn vlx-btn-primary"
            style={{ background: "var(--status-error)", borderColor: "var(--status-error)" }}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}
