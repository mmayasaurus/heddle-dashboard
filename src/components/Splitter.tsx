//! Draggable divider that reports the pixel delta for each mouse movement.

import { useT } from "../i18n";

interface SplitterProps {
  onDrag: (deltaX: number) => void;
}

export function Splitter({ onDrag }: SplitterProps) {
  const t = useT();
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    let last = e.clientX;
    const onMove = (ev: MouseEvent) => {
      onDrag(ev.clientX - last);
      last = ev.clientX;
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        width: 5,
        flex: "0 0 auto",
        cursor: "col-resize",
        background: "transparent",
        position: "relative",
        zIndex: 5,
      }}
      title={t("splitter.dragToResize")}
    >
      <div
        style={{
          position: "absolute",
          left: 2,
          top: 0,
          bottom: 0,
          width: 1,
          background: "var(--border)",
        }}
      />
    </div>
  );
}
