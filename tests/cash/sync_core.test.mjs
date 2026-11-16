import test from "node:test";
import assert from "node:assert/strict";
import { reportSyncState, eveningSyncStartMs, syncReasonText, REPORT_WAIT_MINUTES, SYNC_LABEL } from "../../supabase/functions/agent-gateway/cash_sync_core.ts";
import { SCHEDULES } from "../../supabase/functions/agent-gateway/stockwise_def.ts";
import { cashGate } from "../../supabase/functions/agent-gateway/cash.ts";

const DAY = "2026-11-16"; // AEDT (+11): 18:45 Sydney = 07:45 UTC
const start = eveningSyncStartMs(DAY);
const min = (n) => n * 60e3;

test("6:45 PM Sydney is computed correctly across daylight saving", () => {
  assert.equal(new Date(start).toISOString(), "2026-11-16T07:45:00.000Z");                     // summer time, +11
  assert.equal(new Date(eveningSyncStartMs("2026-07-01")).toISOString(), "2026-07-01T08:45:00.000Z"); // winter, +10
  assert.equal(new Date(eveningSyncStartMs("2026-10-03")).toISOString(), "2026-10-03T08:45:00.000Z"); // Sat before the 4 Oct change, still +10
  assert.equal(new Date(eveningSyncStartMs("2026-10-05")).toISOString(), "2026-10-05T07:45:00.000Z"); // Mon after it, +11
  assert.equal(new Date(eveningSyncStartMs("2027-04-03")).toISOString(), "2027-04-03T07:45:00.000Z"); // Sat before 4 Apr, +11
  assert.equal(new Date(eveningSyncStartMs("2027-04-05")).toISOString(), "2027-04-05T08:45:00.000Z"); // Mon after, +10
});

test("report: complete only when a sync arrived at/after 6:45 PM that day", () => {
  assert.deepEqual(reportSyncState({ nowMs: start + min(20), day: DAY, lastOkMs: start + min(1), eveningRun: { status: "done" } }), { state: "complete", reason: "ok" });
  assert.equal(reportSyncState({ nowMs: start + min(20), day: DAY, lastOkMs: start + min(30), eveningRun: null }).state, "complete", "a manual sync after 6:45 also counts");
  assert.equal(reportSyncState({ nowMs: start + min(20), day: DAY, lastOkMs: start - min(1), eveningRun: { status: "done" } }).reason, "no_data", "1pm data only");
});

test("report: waits while the 6:45 sync is still running, then flags it", () => {
  const run = { status: "running" };
  assert.deepEqual(reportSyncState({ nowMs: start + min(20), day: DAY, lastOkMs: start - min(300), eveningRun: run }), { state: "wait", reason: "running" });
  assert.equal(reportSyncState({ nowMs: start + min(REPORT_WAIT_MINUTES - 1), day: DAY, lastOkMs: null, eveningRun: run }).state, "wait");
  assert.deepEqual(reportSyncState({ nowMs: start + min(REPORT_WAIT_MINUTES + 1), day: DAY, lastOkMs: null, eveningRun: run }), { state: "stale", reason: "running_late" });
});

test("report: failed / did not run / no data are clearly stale, never silently complete", () => {
  assert.deepEqual(reportSyncState({ nowMs: start + min(20), day: DAY, lastOkMs: start - min(300), eveningRun: { status: "failed", error: "x" } }), { state: "stale", reason: "failed" });
  assert.deepEqual(reportSyncState({ nowMs: start + min(20), day: DAY, lastOkMs: start - min(300), eveningRun: null }), { state: "stale", reason: "not_run" });
  assert.deepEqual(reportSyncState({ nowMs: start + min(20), day: DAY, lastOkMs: null, eveningRun: null }), { state: "stale", reason: "not_run" });
  for (const r of ["failed", "no_data", "running_late", "not_run"]) assert.ok(syncReasonText(r, "boom").length > 10, r);
  assert.match(syncReasonText("failed", "boom"), /boom/);
});

test("a past day is judged by its own data, not by today's sync", () => {
  // lastOkMs passed in is the newest sync that arrived BEFORE the end of that day; a sync from the next morning must not count
  assert.equal(reportSyncState({ nowMs: start + 86400e3, day: DAY, lastOkMs: start - min(240), eveningRun: null }).state, "stale");
});

test("schedule definition: exactly two timed cash syncs, one manual-only, old 15-minute one gone", () => {
  const cash = SCHEDULES.runs.filter((r) => r.label.startsWith("cash_sync"));
  assert.deepEqual(cash.map((r) => r.label).sort(), ["cash_sync_1pm", "cash_sync_645pm", "cash_sync_manual"].sort());
  const timed = cash.filter((r) => r.cron);
  assert.equal(timed.length, 2);
  assert.equal(timed.find((r) => r.label === SYNC_LABEL.early).cron, "0 13 * * *");
  assert.equal(timed.find((r) => r.label === SYNC_LABEL.evening).cron, "45 18 * * *");
  assert.equal(SCHEDULES.timezone, "Australia/Sydney");
  assert.ok(!SCHEDULES.runs.some((r) => r.label === "cash_sync"), "legacy label removed from the definition");
  assert.ok(!SCHEDULES.runs.some((r) => /\*\/\d+/.test(r.cron ?? "")), "no step/interval schedules remain");
  const manual = cash.find((r) => r.label === SYNC_LABEL.manual);
  assert.equal(manual.manual, true); assert.equal(manual.cron, undefined);
  assert.equal(new Set(SCHEDULES.runs.map((r) => r.label)).size, SCHEDULES.runs.length, "labels are unique");
  assert.deepEqual(new Set(cash.map((r) => r.prompt)).size, 1, "all three use the same [CASH_SYNC] job");
  assert.ok(cash[0].prompt.startsWith("[CASH_SYNC]"));
});

test("unrelated schedules are unchanged", () => {
  const want = { morning: "30 8 * * *", early: "0 11 * * *", midday: "0 13 * * *", close: "15 18 * * 1-6", close_sun: "15 16 * * 0", week: "0 9 * * 1", catchup: "0 10 20-31 * *" };
  for (const [label, cron] of Object.entries(want)) assert.equal(SCHEDULES.runs.find((r) => r.label === label)?.cron, cron, label);
});

test("permissions: sync routes are Daybook-only; camera tokens and other devices are refused", () => {
  const user = { isDevice: false }, cam = { isDevice: true, channel: "camera" }, glasses = { isDevice: true, channel: "glasses" };
  for (const p of ["/cash/sync", "/cash/sync/status", "/cash/images", "/cash/review"]) {
    assert.equal(cashGate(user, p), null, "user " + p);
    assert.equal(cashGate(cam, p)?.status, 403, "camera " + p);
    assert.equal(cashGate(glasses, p)?.status, 403, "glasses " + p);
  }
  assert.equal(cashGate(cam, "/cash/events"), null); assert.equal(cashGate(cam, "/cash/ping"), null);
  assert.equal(cashGate(user, "/cash/events")?.status, 403);
});
