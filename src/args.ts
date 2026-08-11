//! Pure helpers for launch arguments passed to agent command lines.

/**
 * Normalize long dashes in launch arguments. macOS Smart Punctuation can replace two consecutive hyphens `--`
 * with an em dash `—` (or similarly an en dash `–`), turning `--model` into `—model`, which the agent CLI does
 * not recognize as a flag. A long dash in the launch-arguments field can only originate from an intended `--`,
 * so always restore it to `--`.
 */
export function normalizeArgDashes(s: string): string {
  return s.replace(/[—–]/g, "--");
}
