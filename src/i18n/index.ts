//! Lightweight dependency-free i18n module:
//! - The English dictionary is the sole key source; `I18nKey` derives from it and other dictionaries
//!   must satisfy the same type, making missing keys compile errors.
//! - Values are strings or `(params) => string` functions for language-specific interpolation/plurals.
//! - The persisted `vlx-lang` value is a Locale or "auto", which follows the system language.
//! - navigator.languages is matched exactly, then regionally (Traditional/Simplified Chinese,
//!   Brazilian Portuguese, or primary language), finally falling back to English.
//! - `t()` is synchronous for any module; `useT()` subscribes through useSyncExternalStore.

import { useSyncExternalStore } from "react";
import en from "./locales/en";
import zhCN from "./locales/zh-CN";
import zhTW from "./locales/zh-TW";
import ja from "./locales/ja";
import ko from "./locales/ko";
import fr from "./locales/fr";
import de from "./locales/de";
import es from "./locales/es";
import ptBR from "./locales/pt-BR";
import ru from "./locales/ru";
import vi from "./locales/vi";

/** Supported locales. */
export const LOCALES = [
  "en",
  "zh-CN",
  "zh-TW",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
  "pt-BR",
  "ru",
  "vi",
] as const;

export type Locale = (typeof LOCALES)[number];
/** User locale choice, or "auto" to follow the system. */
export type LangChoice = Locale | "auto";

/** Native locale names displayed in the settings dropdown. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  ja: "日本語",
  ko: "한국어",
  fr: "Français",
  de: "Deutsch",
  es: "Español",
  "pt-BR": "Português (Brasil)",
  ru: "Русский",
  vi: "Tiếng Việt",
};

/** English defines the key set and each value's string or function signature. */
export type Dict = typeof en;
export type I18nKey = keyof Dict;

const DICTS: Record<Locale, Dict> = {
  en,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  ja,
  ko,
  fr,
  de,
  es,
  "pt-BR": ptBR,
  ru,
  vi,
};

const STORAGE_KEY = "vlx-lang";

/** Map a BCP 47 language tag to a supported Locale, returning null when unknown. */
function mapTag(tag: string): Locale | null {
  const t = tag.toLowerCase();
  // Exact case-insensitive match.
  for (const loc of LOCALES) {
    if (t === loc.toLowerCase()) return loc;
  }
  // Chinese regions: Hant/TW/HK/MO use zh-TW; all others use zh-CN.
  if (t === "zh" || t.startsWith("zh-")) {
    if (
      t.includes("hant") ||
      t.startsWith("zh-tw") ||
      t.startsWith("zh-hk") ||
      t.startsWith("zh-mo")
    ) {
      return "zh-TW";
    }
    return "zh-CN";
  }
  // Map all Portuguese variants to pt-BR.
  if (t === "pt" || t.startsWith("pt-")) return "pt-BR";
  // Match other locales by primary language subtag, such as fr-CA to fr.
  const primary = t.split("-")[0];
  for (const loc of LOCALES) {
    if (primary === loc.toLowerCase()) return loc;
  }
  return null;
}

/** Detect the first supported navigator language, falling back to English. */
function detectSystemLocale(): Locale {
  try {
    const langs =
      typeof navigator !== "undefined" && navigator.languages?.length
        ? navigator.languages
        : [typeof navigator !== "undefined" ? navigator.language : ""];
    for (const tag of langs) {
      if (!tag) continue;
      const loc = mapTag(tag);
      if (loc) return loc;
    }
  } catch {
    /* Fall back to English when the environment does not support detection. */
  }
  return "en";
}

/** Read the persisted locale choice; absent or invalid values become "auto". */
export function loadLangChoice(): LangChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "auto") return "auto";
    if (v && (LOCALES as readonly string[]).includes(v)) return v as Locale;
  } catch {
    /* localStorage is unavailable. */
  }
  return "auto";
}

function resolveChoice(choice: LangChoice): Locale {
  return choice === "auto" ? detectSystemLocale() : choice;
}

let currentChoice: LangChoice = loadLangChoice();
let currentLocale: Locale = resolveChoice(currentChoice);

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function syncHtmlLang() {
  try {
    document.documentElement.lang = currentLocale;
  } catch {
    /* Ignore non-browser environments. */
  }
}
syncHtmlLang();

/** Effective locale after resolving auto. */
export function getLocale(): Locale {
  return currentLocale;
}

/** Current locale choice, possibly "auto". */
export function getLangChoice(): LangChoice {
  return currentChoice;
}

/** BCP 47 tag used for date/time localization APIs such as toLocaleString. */
export function dateLocale(): string {
  return currentLocale;
}

/** Set the locale choice, persist it, resolve it, update `<html lang>`, and notify subscribers. */
export function setLang(choice: LangChoice) {
  currentChoice = choice;
  currentLocale = resolveChoice(choice);
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    /* Without localStorage, apply only for this session. */
  }
  // Do not synchronize to the backend here: importing ipc/settingsSync into this low-level module
  // would form a transport -> i18n cycle. SettingsModal, the sole user entry point, calls pushSetting
  // after setLang instead (see ipc/settingsSync.ts).
  syncHtmlLang();
  for (const cb of listeners) cb();
}

/** Parameter tuple for function entries; string entries use an empty tuple. */
type Params<K extends I18nKey> = Dict[K] extends (...args: infer A) => string
  ? A
  : [];

/**
 * Return text in the current locale for direct use outside React. Fall back to English if a runtime
 * dictionary unexpectedly lacks a key despite compile-time checks.
 */
export function t<K extends I18nKey>(key: K, ...args: Params<K>): string {
  const dict = DICTS[currentLocale] ?? en;
  const entry = (dict[key] ?? en[key]) as string | ((...a: unknown[]) => string);
  return typeof entry === "function" ? entry(...args) : entry;
}

/** React hook that subscribes to locale changes and returns t. */
export function useT(): typeof t {
  useSyncExternalStore(subscribe, getLocale);
  return t;
}
