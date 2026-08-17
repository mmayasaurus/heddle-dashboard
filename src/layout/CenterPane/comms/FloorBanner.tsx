//! Floor-hold banner (approved mock card 05). Renders only while a room's `floor` is non-null.
//! The countdown is re-derived from `Date.now()` on every render this component receives new
//! `floor` props (i.e. once per transcript poll tick) — deliberately NOT a per-second ticking
//! timer, per the HED-74b spec.

import { useT } from "../../../i18n";
import type { CommsFloor } from "./useCommsPoll";

/** "m:ss" countdown to `untilTs`, clamped at 0:00. Null when untilTs is missing/unparseable. */
function relativeCountdown(untilTs: string, nowMs: number): string | null {
  const until = new Date(untilTs).getTime();
  if (Number.isNaN(until)) return null;
  const diffSec = Math.max(0, Math.round((until - nowMs) / 1000));
  const m = Math.floor(diffSec / 60);
  const s = diffSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export interface FloorBannerProps {
  floor: CommsFloor | null;
}

export function FloorBanner({ floor }: FloorBannerProps) {
  const t = useT();
  if (!floor) return null;

  const lease = floor.untilTs ? relativeCountdown(floor.untilTs, Date.now()) : null;

  return (
    <div className="comms-floor" data-testid="comms-floor-banner" role="status">
      <span>{t("fleet.comms.floorHolds", floor.holder)}</span>
      {lease != null && (
        <span className="comms-floor-lease" data-testid="comms-floor-lease">
          {lease}
        </span>
      )}
    </div>
  );
}
