// Phase 2 migration on real PostgreSQL: reconciliation function, audit trail, manual review, RLS.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = "cashp2_" + process.pid;
const psql = (db, sql, file) => { const r = spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-X", "-d", db, "-t", "-A", ...(file ? ["-f", file] : ["-c", sql])], { encoding: "utf8" }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
const q = (sql) => { const r = psql(DB, sql); assert.ok(r.ok, r.err + "\n" + sql); return r.out; };
const last = (s) => s.split("\n").pop();
const OWN = "aaaaaaaa-0000-0000-0000-000000000001", OTH = "bbbbbbbb-0000-0000-0000-000000000002", DEV = "dddddddd-0000-0000-0000-00000000000a";
const POS_STORE = "744a2cca-638a-41ee-ae7c-9930877b7c7c";
const NOW = "2026-11-15 06:00:00+00";
const ev = (id, mins) => `insert into cash_events(id,owner_id,device_id,store_key,event_uid,detected_at,received_at) values ('${id}','${OWN}','${DEV}','mcc','u-${id.slice(-3)}', timestamptz '${NOW}' - interval '${mins} minutes', timestamptz '${NOW}' - interval '${mins} minutes');`;
const pay = (id, mins, secs = 0) => `insert into cash_pos_payments(id,owner_id,store_id,store_key,source,source_uuid,source_ref,paid_at,business_date,cash_amount,total_amount) values ('${id}','${OWN}','${POS_STORE}','mcc','invoice','s-${id.slice(-3)}','INV${id.slice(-3)}', timestamptz '${NOW}' - interval '${mins} minutes' + interval '${secs} seconds','2026-11-15',25,25);`;
const E = (n) => `eeeeeeee-0000-0000-0000-000000000${String(n).padStart(3, "0")}`, P = (n) => `99999999-0000-0000-0000-000000000${String(n).padStart(3, "0")}`;
const apply = (matches = [], revE = [], revP = []) => q(`select public.cash_apply_reconciliation('${OWN}','mcc',timestamptz '${NOW}' - interval '72 hours',timestamptz '${NOW}' + interval '1 hour','${JSON.stringify(matches)}'::jsonb,'{${revE.join(",")}}'::uuid[],'{${revP.join(",")}}'::uuid[],0,timestamptz '${NOW}')`);
const audit = () => +q("select count(*) from cash_match_audit");

test.before(() => {
  assert.ok(psql("postgres", "select 1").ok, "no local postgres");
  q.db = DB; assert.ok(psql("postgres", `create database ${DB}`).ok);
  for (const f of ["supabase_stub.sql", "phase2_stub.sql", "../../supabase/migrations/20261113_cash_audit_phase1.sql", "../../supabase/migrations/20261115_cash_audit_phase2.sql"]) { const r = psql(DB, "", path.join(here, f)); assert.ok(r.ok, f + ": " + r.err); }
  q(`insert into auth.users(id,email) values ('${OWN}','o@x'),('${OTH}','p@x'); insert into agent_devices(id,owner_id,label,channel,store_key,token_hash) values ('${DEV}','${OWN}','cam','camera','mcc','h');
     insert into cash_reconciliation_settings(owner_id,store_key,pos_store_id,store_name) values ('${OWN}','mcc','${POS_STORE}','MCC Eastern Creek');`);
});
test.after(() => { psql("postgres", `drop database if exists ${DB} with (force)`); });

test("migration re-runs cleanly (idempotent) and schedules exactly one tick job", () => {
  const r = psql(DB, "", path.join(here, "../../supabase/migrations/20261115_cash_audit_phase2.sql")); assert.ok(r.ok, r.err);
  assert.equal(q("select count(*) from cron.job where jobname='cash-audit-phase2-tick'"), "1");
  assert.equal(q("select schedule from cron.job where jobname='cash-audit-phase2-tick'"), "*/5 * * * *");
});

test("matching: pair is matched, payment links back, one audit row; a repeat tick adds none (no audit noise)", () => {
  q(ev(E(1), 30) + pay(P(1), 30, -20));
  apply([{ event_id: E(1), payment_id: P(1), delta_seconds: 20 }]);
  assert.equal(q(`select match_status||'|'||matched_payment_id from cash_events where id='${E(1)}'`), `matched|${P(1)}`);
  assert.equal(q(`select reconciliation_status||'|'||matched_event_id from cash_pos_payments where id='${P(1)}'`), `matched|${E(1)}`);
  assert.equal(audit(), 1);
  assert.equal(q("select actor||'|'||old_status||'|'||new_status from cash_match_audit"), "automatic|pending|matched");
  apply([{ event_id: E(1), payment_id: P(1), delta_seconds: 20 }]); apply([{ event_id: E(1), payment_id: P(1), delta_seconds: 20 }]);
  assert.equal(audit(), 1, "unchanged results must not write audit rows");
});

test("pending vs unmatched by age; false_detection label is ignored; POS without camera detection", () => {
  q(ev(E(2), 3) + ev(E(3), 45) + ev(E(4), 50) + pay(P(2), 60));
  q(`update cash_events set label='false_detection' where id='${E(4)}'`);
  apply([{ event_id: E(1), payment_id: P(1), delta_seconds: 20 }]);
  assert.equal(q(`select match_status from cash_events where id='${E(2)}'`), "pending");
  assert.equal(q(`select match_status from cash_events where id='${E(3)}'`), "unmatched");
  assert.equal(q(`select match_status from cash_events where id='${E(4)}'`), "ignored");
  assert.equal(q(`select reconciliation_status from cash_pos_payments where id='${P(2)}'`), "pos_without_detection");
  assert.equal(q(`select count(*) from cash_match_audit where event_id='${E(3)}'`), "1", "one audit row for the pending->unmatched change");
});

test("ambiguous items are held for review", () => {
  q(ev(E(5), 100) + pay(P(3), 100, 4));
  apply([{ event_id: E(1), payment_id: P(1), delta_seconds: 20 }], [E(5)], [P(3)]);
  assert.equal(q(`select match_status from cash_events where id='${E(5)}'`), "needs_review");
  assert.equal(q(`select reconciliation_status from cash_pos_payments where id='${P(3)}'`), "needs_review");
});

test("manual match: locked, audited as manual with the reviewer, survives automatic runs, cannot be stolen", () => {
  q(`select public.cash_manual_reconciliation('${OWN}','${E(5)}','match','${P(3)}','checked the till roll')`);
  assert.equal(q(`select match_status||'|'||match_locked||'|'||match_method||'|'||match_reviewed_by from cash_events where id='${E(5)}'`), `matched|true|manual|${OWN}`);
  assert.equal(q(`select actor||'|'||changed_by from cash_match_audit where event_id='${E(5)}' order by id desc limit 1`), `manual|${OWN}`);
  apply([{ event_id: E(1), payment_id: P(1), delta_seconds: 20 }]);                       // automatic run must not touch it
  assert.equal(q(`select match_status||'|'||matched_payment_id from cash_events where id='${E(5)}'`), `matched|${P(3)}`);
  q(ev(E(6), 100));
  assert.equal(psql(DB, `select public.cash_manual_reconciliation('${OWN}','${E(6)}','match','${P(3)}',null)`).ok, false, "payment already matched manually");
  q(`select public.cash_manual_reconciliation('${OWN}','${E(5)}','clear',null,'not this one')`);
  assert.equal(q(`select match_status||'|'||coalesce(matched_payment_id::text,'none') from cash_events where id='${E(5)}'`), "unmatched|none");
  assert.equal(q(`select reconciliation_status from cash_pos_payments where id='${P(3)}'`), "pos_without_detection");
});

test("one payment can be matched to only one event (unique index) and matched needs a payment", () => {
  assert.equal(psql(DB, `update cash_events set match_status='matched' where id='${E(2)}'`).ok, false);
  assert.equal(psql(DB, `update cash_pos_payments set matched_event_id='${E(1)}' where id='${P(2)}'`).ok, false);
});

test("bad inputs and callers are refused", () => {
  assert.equal(psql(DB, `select public.cash_manual_reconciliation('${OWN}','${E(1)}','delete',null,null)`).ok, false);
  assert.equal(psql(DB, `select public.cash_apply_reconciliation('${OWN}','mcc',now(),now(),'{}'::jsonb,'{}','{}',0,now())`).ok, false, "matches must be an array");
  for (const role of ["anon", "authenticated"]) assert.equal(psql(DB, `set role ${role}; select public.cash_apply_reconciliation('${OWN}','mcc',now(),now(),'[]'::jsonb,'{}','{}',0,now())`).ok, false, role + " cannot run reconciliation");
  assert.equal(psql(DB, `set role authenticated; select public.cash_manual_reconciliation('${OWN}','${E(1)}','clear',null,null)`).ok, false, "authenticated cannot run manual RPC directly");
  assert.equal(psql(DB, `select set_config('request.jwt.claims','{"role":"authenticated"}',false); select public.cash_manual_reconciliation('${OWN}','${E(1)}','needs_review',null,null)`).ok, false, "a non-service JWT claim is refused");
});

test("RLS: owner reads own audit/settings/reports, other owner sees nothing, nobody writes from the app", () => {
  q(`insert into cash_daily_reports(owner_id,store_key,store_name,business_date,pos_cash_count,pos_cash_amount,camera_event_count,matched_count,unmatched_camera_count,pos_without_detection_count,needs_review_count,body_text) values ('${OWN}','mcc','MCC','2026-11-14',1,25,1,1,0,0,0,'x')`);
  const as = (uid, sql) => psql(DB, `set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false); ${sql}`);
  for (const t of ["cash_match_audit", "cash_reconciliation_settings", "cash_daily_reports"]) {
    assert.ok(+last(as(OWN, `select count(*) from ${t}`).out) >= 1, t + " visible to owner");
    assert.equal(last(as(OTH, `select count(*) from ${t}`).out), "0", t + " hidden from other");
    assert.equal(as(OWN, `delete from ${t}`).ok, false, t + " no delete");
    assert.equal(psql(DB, `set role anon; select 1 from ${t}`).ok, false, t + " no anon");
  }
  assert.equal(as(OWN, `update cash_reconciliation_settings set window_seconds=500`).ok, false);
  assert.equal(as(OWN, `update cash_events set match_status='matched' where id='${E(2)}'`).ok, false, "app cannot set match status directly");
});

test("settings are validated", () => {
  assert.equal(psql(DB, `update cash_reconciliation_settings set window_seconds=5`).ok, false);
  assert.equal(psql(DB, `update cash_reconciliation_settings set clock_offset_seconds=999`).ok, false);
  assert.equal(psql(DB, `insert into cash_reconciliation_settings values ('${OWN}','mcc2','${POS_STORE}','dup')`).ok, false, "one store key per POS store");
});
