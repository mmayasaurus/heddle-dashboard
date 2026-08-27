//! Read-only needs-Maya adapter. It reuses the existing visual strip while retaining the queue's
//! Linear issue identity and opening that issue externally on activation.

import { useMemo } from "react";
import { useT } from "../../../i18n";
import { platform } from "../../../platform";
import { NeedsHumanStrip, type NeedsHumanStripRow } from "./NeedsHumanStrip";
import type { NeedsMayaRow } from "./useCommsPoll";

interface NeedsMayaVisualRow extends NeedsHumanStripRow {
  id: string;
}

function relativeAge(ts: string, nowMs = Date.now()): string | undefined {
  const thenMs = new Date(ts).getTime();
  if (Number.isNaN(thenMs)) return undefined;
  const minutes = Math.max(0, Math.floor((nowMs - thenMs) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function NeedsMayaStrip({ rows, error }: { rows: NeedsMayaRow[]; error: string | null }) {
  const t = useT();
  const visualRows = useMemo<NeedsMayaVisualRow[]>(
    () =>
      rows.map((row) => ({
        id: row.issue,
        kind: "needs-maya",
        sender: `Agent ${row.agent}`,
        target: "Maya",
        body: row.ask,
        age: relativeAge(row.ts),
      })),
    [rows],
  );
  if (visualRows.length === 0) {
    return error ? <div className="comms-needs-more" data-testid="comms-needs-maya-error">{error}</div> : null;
  }

  return (
    <NeedsHumanStrip
      rows={visualRows}
      testId="comms-needs-maya"
      ariaLabel="needs-maya decisions"
      moreText={(count) => t("fleet.comms.needsMayaMore", count)}
      onRowClick={(visualRow) => {
        const row = rows.find((candidate) => candidate.issue === visualRow.id);
        if (row) void platform.opener.openExternal(row.linearUrl).catch(() => {});
      }}
    />
  );
}
