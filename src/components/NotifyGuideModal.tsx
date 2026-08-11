//! Notification-enablement guide shown when system permission is denied and the OS will no longer display its
//! authorization prompt. It directs users to enable notifications manually in system settings; macOS also gets
//! an Open System Settings button linked directly to Notifications. Controlled by notifyGuideOpen in the store
//! and mounted at the App root like other modals.

import { useT } from "../i18n";
import type { I18nKey } from "../i18n";
import { platform } from "../platform";
import { useTermStore } from "../store/termStore";
import { Backdrop } from "./Backdrop";

/** Select the instruction text key for the current operating system. */
function notifyStepsKey(): I18nKey {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return "settings.notifyStepsMac";
  if (/Win/i.test(ua)) return "settings.notifyStepsWin";
  if (/Linux/i.test(ua)) return "settings.notifyStepsLinux";
  return "settings.notifyStepsBrowser";
}

function isMac(): boolean {
  return /Mac/i.test(navigator.userAgent);
}

export function NotifyGuideModal() {
  const t = useT();
  const open = useTermStore((s) => s.notifyGuideOpen);
  const setOpen = useTermStore((s) => s.setNotifyGuideOpen);
  if (!open) return null;

  // macOS: open the Notifications settings page directly; capability core grants opener:allow-open-url.
  const openSystemSettings = () => {
    void platform.opener
      .openExternal("x-apple.systempreferences:com.apple.preference.notifications")
      .catch(() => {});
  };

  return (
    <Backdrop onClose={() => setOpen(false)} zIndex={10000}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380,
          maxWidth: "90vw",
          background: "var(--bg-app)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 20,
          color: "var(--text-primary)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
          {t("settings.notify")}
        </div>
        <div
          style={{
            fontSize: 12.5,
            lineHeight: 1.6,
            color: "var(--text-dim)",
            marginBottom: 16,
          }}
        >
          {t("settings.notifyDeniedHint")} {t(notifyStepsKey())}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {isMac() && (
            <button
              onClick={openSystemSettings}
              style={{
                padding: "6px 14px",
                fontSize: 12,
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              {t("settings.notifyOpenSettings")}
            </button>
          )}
          <button
            onClick={() => setOpen(false)}
            style={{
              padding: "6px 14px",
              fontSize: 12,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
          >
            {t("common.gotIt")}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}
