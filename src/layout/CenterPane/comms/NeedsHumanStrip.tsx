//! Pinned needs-human/permission-request queue (approved mock card 04). Sourced from the rooms
//! payload (ALL targets, not just the active room), so it stays visible whichever room is open.
//! Shows up to 3 rows; a row click switches to the flagging agent's conversation and highlights
//! the message when it is present in that view. No reply affordance in this read-only PR.

import { useT } from "../../../i18n";
import type { CommsNeedsHumanRow } from "./useCommsPoll";

const VISIBLE_ROWS = 3;
/** The backend caps needsHuman at this many rows — when the list is exactly this long, the
 *  overflow count below is only a floor (the real total could be higher), so it gets a trailing
 *  "+" the same way the strip badge's capped count does. */
const NEEDS_HUMAN_CAP = 50;

export interface NeedsHumanStripProps {
  rows: CommsNeedsHumanRow[];
  onRowClick: (row: CommsNeedsHumanRow) => void;
}

export function NeedsHumanStrip({ rows, onRowClick }: NeedsHumanStripProps) {
  const t = useT();
  if (rows.length === 0) return null;

  const shown = rows.slice(0, VISIBLE_ROWS);
  const extra = rows.length - shown.length;

  return (
    <div className="comms-needs" data-testid="comms-needs-human" role="list" aria-label={t("fleet.comms.needsHuman")}>
      {shown.map((row) => (
        <div
          key={row.id}
          className="comms-needs-row"
          role="listitem"
          tabIndex={0}
          data-testid={`comms-needs-row-${row.id}`}
          onClick={() => {
            onRowClick(row);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onRowClick(row);
            }
          }}
        >
          <span className="comms-needs-tag">{row.kind}</span>
          <span className="comms-needs-from">
            {row.sender} → {row.target}
          </span>
          <span className="comms-needs-txt">{row.body}</span>
        </div>
      ))}
      {extra > 0 && (
        <div className="comms-needs-more" data-testid="comms-needs-more">
          {t("fleet.comms.needsHumanMore", extra)}
          {rows.length === NEEDS_HUMAN_CAP && "+"}
        </div>
      )}
    </div>
  );
}
