//! Share modal for posting heddle to social platforms and copying its link. Weibo opens a prefilled web share;
//! WeChat Moments shows a locally generated QR code; Xiaohongshu copies the post text before opening its creator
//! center. Shared across desktop Tauri, Electron, and remote browser clients:
//!   - External links use platform.opener.openExternal (Tauri opener plugin, Electron shell, or window.open fallback).
//!   - Link copying uses copyText over the same unified IPC path.
//! Both entry points share store.shareOpen: the title-bar Share button on every platform and the macOS-only native
//! "Share us…" menu item.
//!
//! Brand icons use official simple-icons paths when available. LinkedIn was removed under its brand policy, like
//! OpenAI in brandIcons, so its official "in" path is embedded manually. Nearly black or white monochrome marks
//! such as X fall back to currentColor by luminance so they remain visible in both themes.

import {
  siFacebook,
  siReddit,
  siSinaweibo,
  siTelegram,
  siWechat,
  siWhatsapp,
  siX,
  siXiaohongshu,
  siYcombinator,
} from "simple-icons";
import { Backdrop } from "./Backdrop";
import Icons from "./Icons";
import { type I18nKey, useT } from "../i18n";
import { copyText } from "../ipc/info";
import { platform } from "../platform";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";

/** Public share URL and marketing text; always English rather than localized so shared posts are language-neutral. */
const SHARE_URL = "https://heddle.app";
const SHARE_TEXT = "The best terminal for AI coding";
const SHARE_COPY_TEXT = `${SHARE_TEXT} ${SHARE_URL}`;
const XIAOHONGSHU_CREATOR_URL = "https://creator.xiaohongshu.com/publish/publish?source=official";

/** Official LinkedIn "in" mark, embedded manually because simple-icons omits it under brand policy; viewBox 0 0 24 24. */
const LINKEDIN_PATH =
  "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z";

/** Monochrome logo fill: nearly black/white colors such as X's #000 blend into a theme background, so use currentColor by luminance. */
function brandFill(hex: string): string {
  const n = Number.parseInt(hex, 16);
  if (Number.isNaN(n)) return "currentColor";
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.22 || lum > 0.85 ? "currentColor" : `#${hex}`;
}

function BrandGlyph({ hex, path, size = 22 }: { hex: string; path: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={brandFill(hex)} role="img" aria-hidden>
      <path d={path} />
    </svg>
  );
}

type ShareTarget = {
  id: string;
  name: string;
  labelKey?: I18nKey;
  hex: string;
  path: string;
  action: "external" | "wechat-moments" | "xiaohongshu";
  url?: string;
};

/** Web-capable targets open prefilled share pages; WeChat Moments and Xiaohongshu use explicit desktop fallbacks. */
function targets(): ShareTarget[] {
  const u = encodeURIComponent(SHARE_URL);
  const text = encodeURIComponent(SHARE_TEXT);
  return [
    {
      id: "wechat-moments",
      name: "WeChat Moments",
      labelKey: "share.wechatMoments",
      hex: siWechat.hex,
      path: siWechat.path,
      action: "wechat-moments",
    },
    {
      id: "weibo",
      name: "Weibo",
      labelKey: "share.weibo",
      hex: siSinaweibo.hex,
      path: siSinaweibo.path,
      action: "external",
      url: `https://service.weibo.com/share/share.php?url=${u}&title=${text}`,
    },
    {
      id: "xiaohongshu",
      name: "Xiaohongshu",
      labelKey: "share.xiaohongshu",
      hex: siXiaohongshu.hex,
      path: siXiaohongshu.path,
      action: "xiaohongshu",
    },
    {
      id: "x",
      name: "X",
      hex: siX.hex,
      path: siX.path,
      action: "external",
      url: `https://twitter.com/intent/tweet?text=${text}&url=${u}`,
    },
    {
      id: "reddit",
      name: "Reddit",
      hex: siReddit.hex,
      path: siReddit.path,
      action: "external",
      url: `https://www.reddit.com/submit?url=${u}&title=${text}`,
    },
    {
      id: "hacker-news",
      name: "Hacker News",
      hex: siYcombinator.hex,
      path: siYcombinator.path,
      action: "external",
      url: `https://news.ycombinator.com/submitlink?u=${u}&t=${text}`,
    },
    {
      id: "linkedin",
      name: "LinkedIn",
      hex: "0A66C2",
      path: LINKEDIN_PATH,
      action: "external",
      url: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    },
    {
      id: "facebook",
      name: "Facebook",
      hex: siFacebook.hex,
      path: siFacebook.path,
      action: "external",
      url: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    },
    {
      id: "telegram",
      name: "Telegram",
      hex: siTelegram.hex,
      path: siTelegram.path,
      action: "external",
      url: `https://t.me/share/url?url=${u}&text=${text}`,
    },
    {
      id: "whatsapp",
      name: "WhatsApp",
      hex: siWhatsapp.hex,
      path: siWhatsapp.path,
      action: "external",
      url: `https://api.whatsapp.com/send?text=${text}%20${u}`,
    },
  ];
}

export function ShareModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"targets" | "wechat-moments">("targets");

  const openExternal = (url: string) => {
    void platform.opener.openExternal(url).catch(() => {});
    onClose();
  };

  const doCopy = () => {
    void copyText(SHARE_URL)
      .then(() => setCopied(true))
      .catch(() => {});
  };

  const activateTarget = (target: ShareTarget) => {
    if (target.action === "wechat-moments") {
      setView("wechat-moments");
      return;
    }
    if (target.action === "xiaohongshu") {
      // Start both operations from the click gesture so browser popup blockers do not suppress the creator page.
      // Clipboard failure must not strand the user in the modal; the creator center still opens for manual entry.
      void copyText(SHARE_COPY_TEXT).catch(() => {});
      openExternal(XIAOHONGSHU_CREATOR_URL);
      return;
    }
    if (target.url) openExternal(target.url);
  };

  return (
    <Backdrop onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        style={{
          width: 400,
          maxWidth: "92vw",
          background: "var(--bg-2)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--r-md)",
          boxShadow: "var(--shadow)",
          overflow: "hidden",
        }}
      >
        {/* Title bar. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "13px 16px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
            {t("share.title")}
          </span>
          <button
            onClick={onClose}
            title={t("common.close")}
            style={{
              width: 26,
              height: 26,
              display: "grid",
              placeItems: "center",
              background: "transparent",
              color: "var(--text-dim)",
              border: "none",
              borderRadius: 6,
              fontSize: 15,
              lineHeight: 1,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-active)";
              e.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--text-dim)";
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: "16px 18px 18px" }}>
          <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.5 }}>
            {t("share.subtitle")}
          </p>

          {view === "targets" ? (
            /* Platform grid: one rounded tile per platform, icon plus name. */
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 8,
              }}
            >
              {targets().map((s) => {
                const label = s.labelKey ? t(s.labelKey) : s.name;
                const title = s.action === "xiaohongshu" ? t("share.xiaohongshuAction") : label;
                return (
                  <button
                    key={s.id}
                    onClick={() => activateTarget(s)}
                    title={title}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 6,
                      padding: "12px 4px 9px",
                      background: "var(--bg-active)",
                      border: "1px solid var(--border)",
                      borderRadius: 10,
                      color: "var(--text)",
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = "var(--accent)";
                      e.currentTarget.style.background = "var(--accent-soft)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "var(--border)";
                      e.currentTarget.style.background = "var(--bg-active)";
                    }}
                  >
                    <BrandGlyph hex={s.hex} path={s.path} />
                    <span style={{ fontSize: 10.5, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                      {label}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 10,
                padding: "4px 0 2px",
              }}
            >
              <strong style={{ fontSize: 13, color: "var(--text)" }}>
                {t("share.wechatQrTitle")}
              </strong>
              <div
                style={{
                  display: "grid",
                  placeItems: "center",
                  padding: 8,
                  background: "#fff",
                  borderRadius: 10,
                }}
              >
                <QRCodeSVG value={SHARE_URL} size={176} level="M" marginSize={1} />
              </div>
              <p
                style={{
                  maxWidth: 300,
                  margin: 0,
                  color: "var(--text-dim)",
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  textAlign: "center",
                }}
              >
                {t("share.wechatQrHint")}
              </p>
              <button
                onClick={() => setView("targets")}
                style={{
                  padding: "6px 10px",
                  background: "var(--bg-active)",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  color: "var(--text-dim)",
                  fontSize: 11.5,
                  cursor: "pointer",
                }}
              >
                {t("share.backToPlatforms")}
              </button>
            </div>
          )}

          {/* Copy link. */}
          <button
            onClick={doCopy}
            style={{
              marginTop: 14,
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              padding: "9px 12px",
              background: copied ? "var(--accent-soft)" : "var(--bg-active)",
              border: `1px solid ${copied ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 8,
              color: copied ? "var(--accent)" : "var(--text)",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            <Icons.share size={14} />
            {copied ? t("share.copied") : t("share.copyLink")}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}
