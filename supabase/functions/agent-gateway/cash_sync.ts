// Cash Audit: manual "Sync POS Now" and sync status. Uses the existing StockWise agent and the existing ingestion endpoint:
// pressing the button starts the agent's manual-only deployment, which fetches from StockWise itself and posts to /ingest/cash-sync.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { AgentRow } from "./cma.ts";
import { MANUAL_SYNC_LABEL } from "./cma.ts";
import { SYNC_LABEL, STALE_JOB_MINUTES } from "./cash_sync_core.ts";

type Out = { status: number; body: Record<string, unknown> };
type RunNow = (sb: SupabaseClient, row: AgentRow, label: string) => Promise<{ id: string; session_id: string }>;

const REASON_TEXT: Record<string, string> = {
  already_running: "A sync is already running. Wait for it to finish.",
  scheduled_running: "A scheduled sync is running right now. Wait for it to finish.",
};

// POST /cash/sync (Daybook login) or /internal/cash/ops {action:"sync"} (cron key). Starts a REAL StockWise fetch through the agent.
export async function startManualSync(sb: SupabaseClient, row: AgentRow, via: "button" | "ops", runNow: RunNow): Promise<Out> {
  const cfg = row.config ?? {};
  if (!cfg.deployments?.[MANUAL_SYNC_LABEL]) return { status: 409, body: { ok: false, reason: "not_set_up", error: "Sync Now isn't set up yet. Open Agents → Setup and tap Update (or Create) once." } };
  if (!cfg.sw_cred_id) return { status: 409, body: { ok: false, reason: "no_stockwise", error: "Connect StockWise first (Agents → Setup)." } };
  // Atomic lock: at most one manual sync can be starting/running, and none while a scheduled sync is running.
  const { data: claim, error: ce } = await sb.rpc("cash_sync_claim", { p_owner: row.owner_id, p_via: via, p_stale_minutes: STALE_JOB_MINUTES });
  if (ce) throw ce;
  if (!claim?.ok) return { status: 409, body: { ok: false, reason: claim?.reason ?? "busy", error: REASON_TEXT[claim?.reason] ?? "A sync is already running.", job_id: claim?.job_id ?? null } };
  const jobId = claim.job_id as string;
  try {
    const run = await runNow(sb, row, MANUAL_SYNC_LABEL);
    await sb.from("cash_sync_jobs").update({ status: "running", session_id: run.session_id }).eq("id", jobId);
    return { status: 202, body: { ok: true, job_id: jobId } };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    await sb.from("cash_sync_jobs").update({ status: "failed", finished_at: new Date().toISOString(), error: msg }).eq("id", jobId);
    return { status: 502, body: { ok: false, reason: "start_failed", error: "Couldn't start the sync: " + msg, job_id: jobId } };
  }
}

// GET /cash/sync/status: progress of a running sync, the last successful sync, and the scheduled runs.
export async function syncStatus(sb: SupabaseClient, row: AgentRow, heal: (sessionId: string) => Promise<unknown>): Promise<Record<string, unknown>> {
  const ownerId = row.owner_id;
  const settle = () => sb.rpc("cash_sync_settle", { p_owner: ownerId, p_stale_minutes: STALE_JOB_MINUTES });
  await settle();
  let { data: job } = await sb.from("cash_sync_jobs").select("id,status,session_id,created_at,finished_at,error").eq("owner_id", ownerId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (job && (job.status === "starting" || job.status === "running") && job.session_id) {
    try { await heal(job.session_id); await settle(); } catch (_) { /* a missed webhook is retried on the next poll */ }
    ({ data: job } = await sb.from("cash_sync_jobs").select("id,status,session_id,created_at,finished_at,error").eq("id", job.id).maybeSingle());
  }
  let imported = 0, accepted = 0;
  if (job) {
    const { data: logs } = await sb.from("cash_sync_log").select("new_count,accepted").eq("job_id", job.id);
    for (const l of logs ?? []) { imported += l.new_count; accepted += l.accepted; }
  }
  const { data: last } = await sb.from("cash_sync_log").select("received_at,new_count,accepted").eq("owner_id", ownerId).order("received_at", { ascending: false }).limit(1).maybeSingle();
  const since = new Date(Date.now() - 36 * 3600e3).toISOString();
  const { data: runs } = await sb.from("agent_runs").select("schedule_label,status,started_at,finished_at,error")
    .eq("owner_id", ownerId).in("schedule_label", [SYNC_LABEL.early, SYNC_LABEL.evening]).gte("started_at", since).order("started_at", { ascending: false }).limit(6);
  const active = !!job && (job.status === "starting" || job.status === "running");
  return {
    ok: true,
    ready: !!row.config?.deployments?.[MANUAL_SYNC_LABEL] && !!row.config?.sw_cred_id,
    active: active ? { job_id: job!.id, status: job!.status, started_at: job!.created_at } : null,
    last_job: job ? { job_id: job.id, status: job.status, started_at: job.created_at, finished_at: job.finished_at, error: job.error, imported, accepted } : null,
    last_ok: last ? { at: last.received_at, new_count: last.new_count, accepted: last.accepted } : null,
    scheduled: runs ?? [],
    server_time: new Date().toISOString(),
  };
}
