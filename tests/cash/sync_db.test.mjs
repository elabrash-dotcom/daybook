// Manual sync lock, settle and RLS on real PostgreSQL (real migrations).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = "cashsync_" + process.pid;
const psql = (db, sql, file) => { const r = spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-X", "-d", db, "-t", "-A", ...(file ? ["-f", file] : ["-c", sql])], { encoding: "utf8" }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
const q = (sql) => { const r = psql(DB, sql); assert.ok(r.ok, r.err + "\n" + sql); return r.out; };
const lastLine = (s) => s.split("\n").pop();
const A = "aaaaaaaa-0000-0000-0000-000000000001", B = "bbbbbbbb-0000-0000-0000-000000000002", AG = "cccccccc-0000-0000-0000-00000000000a";
const claim = (o = A) => JSON.parse(q(`select public.cash_sync_claim('${o}')`));

test.before(() => {
  assert.ok(psql("postgres", "select 1").ok, "no local postgres");
  assert.ok(psql("postgres", `create database ${DB}`).ok);
  for (const f of ["supabase_stub.sql", "phase2_stub.sql", "../../supabase/migrations/20261113_cash_audit_phase1.sql", "../../supabase/migrations/20261115_cash_audit_phase2.sql", "../../supabase/migrations/20261116_cash_sync.sql"]) { const r = psql(DB, "", path.join(here, f)); assert.ok(r.ok, f + ": " + r.err); }
  q(`insert into auth.users(id,email) values ('${A}','a@x'),('${B}','b@x'); insert into public.agents(id,owner_id,slug) values ('${AG}','${A}','stockwise');`);
});
test.after(() => { psql("postgres", `drop database if exists ${DB} with (force)`); });

test("migration re-runs cleanly (additive, idempotent)", () => {
  assert.ok(psql(DB, "", path.join(here, "../../supabase/migrations/20261116_cash_sync.sql")).ok);
});

test("claim: first press wins, second is refused with the same job; one active job in the table", () => {
  const first = claim(); assert.equal(first.ok, true);
  const second = claim(); assert.deepEqual([second.ok, second.reason, second.job_id], [false, "already_running", first.job_id]);
  assert.equal(q("select count(*) from cash_sync_jobs where status in ('starting','running')"), "1");
  assert.equal(psql(DB, `insert into cash_sync_jobs(owner_id) values ('${A}')`).ok, false, "the unique index itself refuses a second active job");
});

test("claim under parallel presses: exactly one run is allowed", async () => {
  q(`update cash_sync_jobs set status='done', finished_at=now()`);
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((res) => {
    const p = spawn("psql", ["-X", "-q", "-t", "-A", "-d", DB, "-c", `select public.cash_sync_claim('${A}')`]); let out = "";
    p.stdout.on("data", (d) => (out += d)); p.on("close", () => res(JSON.parse(out.trim().split("\n").pop())));
  })));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok && r.reason === "already_running").length, 7);
});

test("settle: a finished agent run closes the job and frees the lock; a failed run records its error", () => {
  const id = q("select id from cash_sync_jobs where status in ('starting','running')");
  q(`update cash_sync_jobs set status='running', session_id='sess_1' where id='${id}'`);
  q(`insert into agent_runs(owner_id,agent_id,schedule_label,status,session_id) values ('${A}','${AG}','cash_sync_manual','failed','sess_1')`);
  q(`update agent_runs set error='StockWise unreachable' where session_id='sess_1'`);
  const next = claim(); assert.equal(next.ok, true, "lock freed because the run had finished");
  assert.equal(q(`select status||'|'||error from cash_sync_jobs where id='${id}'`), "failed|StockWise unreachable");
});

test("a sync that never finishes times out so the button cannot stay stuck", () => {
  q(`update cash_sync_jobs set created_at = now() - interval '25 minutes' where status in ('starting','running')`);
  assert.equal(claim().ok, true);
  assert.match(q("select string_agg(error, ',') from cash_sync_jobs where error like 'timed out%'"), /timed out/);
});

test("a scheduled sync that is running blocks a manual one; a finished one does not", () => {
  q(`update cash_sync_jobs set status='done', finished_at=now()`);
  q(`insert into agent_runs(owner_id,agent_id,schedule_label,status,session_id) values ('${A}','${AG}','cash_sync_645pm','running','sess_sched')`);
  assert.deepEqual([claim().ok, claim().reason], [false, "scheduled_running"]);
  q(`update agent_runs set status='done' where session_id='sess_sched'`);
  assert.equal(claim().ok, true);
});

test("sync log counts, and RLS: owner reads own rows, others nothing, app cannot write, claim is service-only", () => {
  q(`insert into cash_sync_log(owner_id,accepted,new_count) values ('${A}',3,2),('${A}',0,0)`);
  const as = (uid, sql) => psql(DB, `set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false); ${sql}`);
  assert.equal(lastLine(as(A, "select count(*) from cash_sync_log").out), "2");
  assert.equal(lastLine(as(B, "select count(*) from cash_sync_log").out), "0");
  assert.equal(lastLine(as(B, "select count(*) from cash_sync_jobs").out), "0");
  assert.ok(+lastLine(as(A, "select count(*) from cash_sync_jobs").out) >= 1);
  for (const sql of ["insert into cash_sync_log(owner_id,accepted,new_count) values (auth.uid(),1,1)", "update cash_sync_log set new_count=99", "delete from cash_sync_log", "update cash_sync_jobs set status='done'", "delete from cash_sync_jobs", `select public.cash_sync_claim('${A}')`]) assert.equal(as(A, sql).ok, false, sql);
  assert.equal(psql(DB, `set role anon; select count(*) from cash_sync_log`).ok, false);
});

test("another owner is not blocked by this owner's running sync", () => {
  const b = claim(B); assert.equal(b.ok, true);
});

test("log and job constraints", () => {
  assert.equal(psql(DB, `insert into cash_sync_log(owner_id,accepted,new_count) values ('${A}',-1,0)`).ok, false);
  assert.equal(psql(DB, `insert into cash_sync_jobs(owner_id,status) values ('${B}','weird')`).ok, false);
  assert.equal(psql(DB, `update cash_daily_reports set pos_sync_state='maybe'`).ok, true, "no rows to violate");
  assert.equal(psql(DB, `insert into cash_daily_reports(owner_id,store_key,store_name,business_date,pos_cash_count,pos_cash_amount,camera_event_count,matched_count,unmatched_camera_count,pos_without_detection_count,needs_review_count,body_text,pos_sync_state) values ('${A}','mcc','x','2026-11-16',0,0,0,0,0,0,0,'x','maybe')`).ok, false);
});
