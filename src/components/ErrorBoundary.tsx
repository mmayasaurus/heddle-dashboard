import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[heddle] React render crash:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <CrashScreen error={this.state.error} />;
  }
}

function CrashScreen({ error }: { error: Error }) {
  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>
          {t("err.renderTitle")}
        </div>
        <div style={{ fontSize: 12, color: "#999", marginBottom: 14 }}>
          {t("err.renderDesc")}
        </div>

        <div style={msgStyle}>{error.message}</div>

        {error.stack && (
          <pre style={stackStyle}>{cleanStack(error.stack)}</pre>
        )}

        <button onClick={() => location.reload()} style={btnStyle}>
          {t("err.reload")}
        </button>
      </div>
    </div>
  );
}

function cleanStack(stack: string): string {
  return stack
    .split("\n")
    .filter((l) => !l.includes("node_modules"))
    .slice(0, 15)
    .join("\n");
}

const containerStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "grid",
  placeItems: "center",
  background: "#1a1a1a",
  color: "#e0e0e0",
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  zIndex: 99999,
};

const cardStyle: React.CSSProperties = {
  maxWidth: 560,
  width: "90%",
  padding: 28,
  background: "#242424",
  border: "1px solid #333",
  borderRadius: 12,
};

const msgStyle: React.CSSProperties = {
  padding: "10px 12px",
  background: "#2a1a1a",
  border: "1px solid #5c2020",
  borderRadius: 6,
  color: "#ff8080",
  fontSize: 12.5,
  lineHeight: 1.5,
  wordBreak: "break-word",
  marginBottom: 10,
};

const stackStyle: React.CSSProperties = {
  margin: 0,
  marginBottom: 16,
  padding: "10px 12px",
  background: "#1e1e1e",
  border: "1px solid #333",
  borderRadius: 6,
  fontSize: 11,
  lineHeight: 1.5,
  color: "#aaa",
  overflow: "auto",
  maxHeight: 200,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

const btnStyle: React.CSSProperties = {
  padding: "8px 20px",
  border: "none",
  borderRadius: 6,
  background: "#4a9eff",
  color: "#fff",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
