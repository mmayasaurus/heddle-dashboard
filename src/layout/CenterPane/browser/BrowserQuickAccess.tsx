//! Quick-access bar for the built-in browser. Sites are configured centrally; extend it by appending to QUICK_ACCESS_SITES.
//! This component only renders and dispatches callbacks. BrowserView still navigates through browserNavigate to keep Tauri and Electron consistent.

import { siClaude, siGoogle, siGooglegemini, type SimpleIcon } from "simple-icons";
import { openAiMarkEl } from "../../../components/brandIcons";

export interface BrowserQuickSite {
  id: "chatgpt" | "claude" | "gemini" | "google";
  label: string;
  url: string;
  color: string;
  icon?: SimpleIcon;
}

export const QUICK_ACCESS_SITES: readonly BrowserQuickSite[] = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    url: "https://chatgpt.com/",
    color: "#10A37F",
  },
  {
    id: "claude",
    label: "Claude",
    url: "https://claude.ai/",
    color: `#${siClaude.hex}`,
    icon: siClaude,
  },
  {
    id: "gemini",
    label: "Gemini",
    url: "https://gemini.google.com/",
    color: `#${siGooglegemini.hex}`,
    icon: siGooglegemini,
  },
  {
    id: "google",
    label: "Google",
    url: "https://www.google.com/",
    color: `#${siGoogle.hex}`,
    icon: siGoogle,
  },
] as const;

function SimpleBrandIcon({ icon }: { icon: SimpleIcon }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={icon.path} />
    </svg>
  );
}

export function BrowserQuickAccess({
  label,
  onNavigate,
}: {
  label: string;
  onNavigate: (url: string) => void;
}) {
  return (
    <nav
      className="browser-quick-access"
      aria-label={label}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        minHeight: 32,
        padding: "3px 8px",
        overflowX: "auto",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-1)",
        flex: "none",
      }}
    >
      {QUICK_ACCESS_SITES.map((site) => (
        <button
          key={site.id}
          type="button"
          title={site.label}
          aria-label={site.label}
          onClick={() => onNavigate(site.url)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: 25,
            padding: "0 9px",
            flex: "none",
            border: "1px solid transparent",
            borderRadius: 6,
            background: "transparent",
            color: "var(--text-dim)",
            fontSize: 11.5,
            fontFamily: "inherit",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-3, rgba(128,128,128,0.12))";
            e.currentTarget.style.borderColor = "var(--border)";
            e.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.borderColor = "transparent";
            e.currentTarget.style.color = "var(--text-dim)";
          }}
        >
          <span
            aria-hidden="true"
            style={{ color: site.color, display: "inline-flex", alignItems: "center" }}
          >
            {site.icon ? <SimpleBrandIcon icon={site.icon} /> : openAiMarkEl(14)}
          </span>
          <span>{site.label}</span>
        </button>
      ))}
    </nav>
  );
}
