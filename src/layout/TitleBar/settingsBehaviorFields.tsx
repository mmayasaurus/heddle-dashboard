//! Settings fields for terminal image pasting, automatic pasted-image cleanup, and system notifications.
//! Extracted from SettingsModal as self-contained stateful blocks; shared Seg and Field components
//! live in settingsParts.

import { useEffect, useState } from "react";
import { useT, type I18nKey } from "../../i18n";
import { cleanPastedImages as runCleanPastedImages } from "../../ipc/commands";
import { isTauri, isRemoteWindow } from "../../ipc/transport";
import { env } from "../../platform";
import {
  getEffectiveNotifyPermission,
  requestEffectiveNotifyPermission,
  type NotifyPermission,
} from "../../notify";
import { useTermStore } from "../../store/termStore";
import { Field, Seg } from "./settingsParts";

/** Coarsely detect the current UI platform for notification-settings guidance. Plain browsers and
 * mobile remote access map to browser; native main and remote windows use the user agent to select
 * macOS, Windows, or Linux. This follows shortcutRegistry/transport without adding dependencies. */
type OsKind = "mac" | "windows" | "linux" | "browser";
function detectOs(): OsKind {
  if (!isTauri && !isRemoteWindow && !env.isElectron) return "browser";
  const ua = navigator.userAgent || (navigator as any).platform || "";
  if (/Mac|iPhone|iPad/i.test(ua)) return "mac";
  if (/Win/i.test(ua)) return "windows";
  return "linux";
}

/** Format cleanup sizes as B, KB, or MB, which covers expected temporary-image sizes. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Automatic pasted-image cleanup setting. Its persisted cross-shell toggle controls backend cleanup
 * at startup and shutdown; an immediate action clears vlx-uploads and reports item count and space freed. */
export function CleanImagesField() {
  const t = useT();
  const cleanOn = useTermStore((s) => s.cleanPastedImages);
  const setCleanOn = useTermStore((s) => s.setCleanPastedImages);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const runClean = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const { removed, freedBytes } = await runCleanPastedImages();
      setMsg(
        removed > 0
          ? t("settings.cleanImagesResult", removed, formatBytes(freedBytes))
          : t("settings.cleanImagesEmpty"),
      );
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Field label={t("settings.cleanImages")}>
        <Seg<"on" | "off">
          value={cleanOn ? "on" : "off"}
          options={[
            ["on", t("common.on")],
            ["off", t("common.off")],
          ]}
          onChange={(v) => setCleanOn(v === "on")}
        />
      </Field>
      <div
        style={{
          marginTop: 8,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span style={{ flex: 1, fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)" }}>
          {msg ?? t("settings.cleanImagesHint")}
        </span>
        <button
          onClick={() => void runClean()}
          disabled={busy}
          style={{
            flex: "none",
            padding: "5px 14px",
            fontSize: 11.5,
            borderRadius: 5,
            border: "1px solid var(--border)",
            background: "var(--bg-active)",
            color: "var(--text)",
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {t("settings.cleanImagesNow")}
        </button>
      </div>
    </>
  );
}

/** Terminal image-paste mode: paste a file path or use native image paste. It appears in every shell,
 * but native mode is disabled for browser/remote agents whose clipboard is on another machine; those
 * always upload a path. The value persists in vlx-settings across shells and affects the next paste.
 * TerminalView.onPasteCapture performs the dispatch; see the image-paste design document. */
export function ImagePasteModeField() {
  const t = useT();
  const mode = useTermStore((s) => s.imagePasteMode);
  const setMode = useTermStore((s) => s.setImagePasteMode);
  // Remote/browser agents run on another machine and cannot reliably read this device's clipboard.
  // Keep the setting visible, but allow native mode only in a same-machine desktop shell.
  const nativeAvailable = env.isTauri || env.isElectron;
  const effectiveMode = nativeAvailable ? mode : "upload";
  return (
    <>
      <Field label={t("settings.imagePasteMode")}>
        <Seg<"upload" | "agent">
          value={effectiveMode}
          options={[
            ["upload", t("settings.imagePasteUpload")],
            ["agent", t("settings.imagePasteAgent")],
          ]}
          disabledOptions={nativeAvailable ? [] : ["agent"]}
          onChange={(v) => setMode(v)}
        />
      </Field>
      <div style={{ marginTop: 8 }}>
        <span style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)" }}>
          {t(nativeAvailable ? "settings.imagePasteHint" : "settings.imagePasteRemoteHint")}
        </span>
      </div>
    </>
  );
}

/** Application-wide system-notification toggle. Disabling it suppresses system popups but preserves
 * sidebar unread dots and Dock badges; store.notifyRaw owns the gate. When enabled without permission,
 * show either a permission action or OS-specific guidance after denial. Environments without the
 * Notification API show an unavailable explanation instead of a toggle. */
export function NotificationField() {
  const t = useT();
  const notifyEnabled = useTermStore((s) => s.notifyEnabled);
  const toggleNotify = useTermStore((s) => s.toggleNotify);
  const [perm, setPerm] = useState<NotifyPermission | null>(null);
  const [busy, setBusy] = useState(false);
  const os = detectOs();

  useEffect(() => {
    let alive = true;
    void getEffectiveNotifyPermission().then((p) => {
      if (alive) setPerm(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  const stepsKey: I18nKey =
    os === "mac"
      ? "settings.notifyStepsMac"
      : os === "windows"
        ? "settings.notifyStepsWin"
        : os === "linux"
          ? "settings.notifyStepsLinux"
          : "settings.notifyStepsBrowser";

  const requestPerm = async () => {
    setBusy(true);
    try {
      setPerm(await requestEffectiveNotifyPermission());
    } finally {
      setBusy(false);
    }
  };

  // When enabling, request permission if needed; a prior denial returns denied and reveals guidance.
  const onToggle = (on: boolean) => {
    if (on === notifyEnabled) return;
    toggleNotify();
    if (on && perm !== "granted" && perm !== "unsupported") void requestPerm();
  };

  // Show permission or OS guidance only while enabled without system authorization.
  const needGuide =
    notifyEnabled && (perm === "default" || perm === "denied");

  return (
    <>
      <Field label={t("settings.notify")}>
        {perm === "unsupported" ? (
          <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
            {t("settings.notifyUnsupported")}
          </span>
        ) : (
          <Seg<"on" | "off">
            value={notifyEnabled ? "on" : "off"}
            options={[
              ["on", t("common.on")],
              ["off", t("common.off")],
            ]}
            onChange={(v) => onToggle(v === "on")}
          />
        )}
      </Field>

      {needGuide && (
        <div
          style={{
            marginTop: 10,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 8,
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--text-dim)",
          }}
        >
          <span>
            {perm === "denied"
              ? `${t("settings.notifyDeniedHint")} ${t(stepsKey)}`
              : t("settings.notifyOffHint")}
          </span>
          {/* Offer a permission prompt before a decision; after denial, direct the user to system settings. */}
          {perm === "default" && (
            <button
              onClick={requestPerm}
              disabled={busy}
              style={{
                padding: "4px 14px",
                fontSize: 11.5,
                borderRadius: 5,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: busy ? "default" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {t("settings.notifyAllow")}
            </button>
          )}
        </div>
      )}
    </>
  );
}
