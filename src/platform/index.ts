//! Platform adapter entry point.
//!
//! Select the implementation at runtime and export the `platform` singleton and `env` environment view.
//! Application code consistently uses `import { platform } from "../platform"` (or another appropriate relative
//! path) instead of touching `@tauri-apps/*` / `electron` directly. ESLint's no-restricted-imports enforces this
//! rule, with platform/ itself exempt.

import { env } from "./env";
import { tauriPlatform } from "./tauri";
import type { Platform } from "./types";

/** Desktop Tauri and browser WS both use the Tauri implementation (the Electron shell was removed — HED-41). */
export const platform: Platform = tauriPlatform;

export { env };

export type {
  BadgeCapability,
  BrowserCapability,
  BrowserRect,
  BrowserStatePayload,
  ClipboardCapability,
  DialogCapability,
  NotifyCapability,
  NotifyPermission,
  OpenerCapability,
  Platform,
  PlatformEnv,
  PlatformKind,
  SaveFileOptions,
  TransportCapability,
  UnlistenFn,
  VelaCommandCapability,
  VelaCommandStatus,
  WindowCapability,
} from "./types";
