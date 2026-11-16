// Cash Audit POS sync: pure decisions (no network, no database). Tested under Node; runs unchanged in Deno.
import { sydneyWallToUtcMs } from "./cash_core.ts";

export const SYNC_LABEL = { early: "cash_sync_1pm", evening: "cash_sync_645pm", manual: "cash_sync_manual" } as const;
export const EVENING_HOUR = 18, EVENING_MINUTE = 45;
export const REPORT_WAIT_MINUTES = 45; // the 7:05 PM report waits for a running 6:45 PM sync until 7:30 PM, then is sent with a warning
export const STALE_JOB_MINUTES = 20;   // a sync that has not finished by then is treated as failed

// The moment the 6:45 PM sync is due on a Sydney calendar day (YYYY-MM-DD). Daylight saving safe.
export function eveningSyncStartMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return sydneyWallToUtcMs(y, m, d, EVENING_HOUR, EVENING_MINUTE, 0);
}

export type EveningRun = { status: string; error?: string | null } | null;
export type SyncState = {
  state: "complete" | "wait" | "stale";
  reason: "ok" | "running" | "running_late" | "failed" | "no_data" | "not_run";
};

// Decide whether the daily report may present POS data as complete.
//  - lastOkMs: when the newest successful ingestion for that day arrived (any sync, scheduled or manual), or null
//  - eveningRun: the 6:45 PM agent run of that day, if one was recorded
export function reportSyncState(f: { nowMs: number; day: string; lastOkMs: number | null; eveningRun: EveningRun }): SyncState {
  const start = eveningSyncStartMs(f.day);
  if (f.lastOkMs !== null && f.lastOkMs >= start) return { state: "complete", reason: "ok" };
  const run = f.eveningRun;
  if (run && run.status === "running") {
    return f.nowMs < start + REPORT_WAIT_MINUTES * 60e3 ? { state: "wait", reason: "running" } : { state: "stale", reason: "running_late" };
  }
  if (run && run.status === "failed") return { state: "stale", reason: "failed" };
  if (run && run.status === "done") return { state: "stale", reason: "no_data" }; // finished but never posted anything
  return { state: "stale", reason: "not_run" };
}

export function syncReasonText(reason: SyncState["reason"], error?: string | null): string {
  switch (reason) {
    case "failed": return "the 6:45 PM POS sync failed" + (error ? " (" + error.slice(0, 80) + ")" : "");
    case "no_data": return "the 6:45 PM POS sync finished without sending any data";
    case "running": case "running_late": return "the 6:45 PM POS sync had not finished";
    case "not_run": return "the 6:45 PM POS sync did not run";
    default: return "";
  }
}
