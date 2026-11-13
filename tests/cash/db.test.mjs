// Runs the real migration on a throwaway local PostgreSQL (needs PGHOST/PGPORT/PGUSER, e.g. the scratch server).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = "cashtest_" + process.pid;
const base = ["-v", "ON_ERROR_STOP=1", "-q", "-X"];
function psql(db, sql, file) {
  const args = [...base, "-d", db, "-t", "-A", ...(file ? ["-f", file] : ["-c", sql])];
  const r = spawnSync("psql", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
// run SQL as a role / user. Returns {ok,out,err}
const as = (role, uid, sql) =>
  psql(DB, `set role ${role}; ${uid ? `select set_config('request.jwt.claim.sub','${uid}',false);` : ""} ${sql}`);
const must = (r) => { assert.ok(r.ok, r.err); return r.out; };

const A = "aaaaaaaa-0000-0000-0000-000000000001", B = "bbbbbbbb-0000-0000-0000-000000000002";
const DEV_A = "dddddddd-0000-0000-0000-00000000000a", DEV_B = "dddddddd-0000-0000-0000-00000000000b";

test.before(() => {
  assert.ok(psql("postgres", "select 1").ok, "no local postgres reachable (set PGHOST/PGPORT/PGUSER)");
  must(psql("postgres", `create database ${DB}`));
  must(psql(DB, "", path.join(here, "supabase_stub.sql")));
  must(psql(DB, "", path.join(here, "../../supabase/migrations/20261113_cash_audit_phase1.sql")));
  must(psql(DB, `insert into auth.users(id,email) values ('${A}','a@x'),('${B}','b@x');
    insert into agent_devices(id,owner_id,label,channel,store_key,token_hash) values
      ('${DEV_A}','${A}','jetson','camera','mcc','h1'),('${DEV_B}','${B}','jetson','camera','mcc','h2');
    insert into cash_events(owner_id,device_id,store_key,event_uid,detected_at) values
      ('${A}','${DEV_A}','mcc','ev-A1', now()),('${B}','${DEV_B}','mcc','ev-B1', now());`));
});
test.after(() => { psql("postgres", `drop database if exists ${DB} with (force)`); });

test("migration is idempotent (second run succeeds)", () => {
  must(psql(DB, "", path.join(here, "../../supabase/migrations/20261113_cash_audit_phase1.sql")));
});

test("RLS enabled on both tables", () => {
  assert.equal(must(psql(DB, "select count(*) from pg_class where relname in ('cash_events','cash_pos_payments') and relrowsecurity")), "2");
});

test("owner sees only their own events", () => {
  assert.equal(must(as("authenticated", A, "select event_uid from cash_events")).split("\n").pop(), "ev-A1");
  assert.equal(must(as("authenticated", B, "select event_uid from cash_events")).split("\n").pop(), "ev-B1");
});

test("anon sees nothing and cannot read", () => {
  assert.equal(as("anon", null, "select * from cash_events").ok, false);
});

test("owner can set a label and note; stamp columns are filled by trigger", () => {
  must(as("authenticated", A, "update cash_events set label='confirmed_cash', label_note='checked' where event_uid='ev-A1'"));
  const out = must(psql(DB, "select label, labelled_by::text, (labelled_at is not null)::text from cash_events where event_uid='ev-A1'"));
  assert.equal(out, `confirmed_cash|${A}|true`);
});

test("owner cannot label someone else's event (0 rows touched)", () => {
  const out = must(as("authenticated", A, "with u as (update cash_events set label='false_detection' where event_uid='ev-B1' returning 1) select count(*) from u")).split("\n").pop();
  assert.equal(out, "0");
  assert.equal(must(psql(DB, "select coalesce(label,'none') from cash_events where event_uid='ev-B1'")), "none");
});

test("owner cannot change detection data, paths, owner or match columns", () => {
  for (const col of ["detected_at=now()", "confidence=0.5", "owner_id='" + B + "'", "match_status='matched'", "snapshot_raw_path='x'", "raw='{}'", "labelled_by='" + B + "'"]) {
    assert.equal(as("authenticated", A, `update cash_events set ${col} where event_uid='ev-A1'`).ok, false, col);
  }
});

test("label values are constrained", () => {
  assert.equal(as("authenticated", A, "update cash_events set label='bogus' where event_uid='ev-A1'").ok, false);
});

test("authenticated users cannot insert or delete events or payments", () => {
  assert.equal(as("authenticated", A, `insert into cash_events(owner_id,device_id,store_key,event_uid,detected_at) values ('${A}','${DEV_A}','mcc','x1',now())`).ok, false);
  assert.equal(as("authenticated", A, "delete from cash_events").ok, false);
  assert.equal(as("authenticated", A, `insert into cash_pos_payments(owner_id,store_id,store_key,source,source_uuid,source_ref,paid_at,business_date,cash_amount) values ('${A}',gen_random_uuid(),'mcc','invoice','u','I1',now(),current_date,5)`).ok, false);
});

test("service role can insert; duplicate (device, event_uid) is rejected by the unique key", () => {
  const ins = (uid) => psql(DB, `set role service_role; insert into cash_events(owner_id,device_id,store_key,event_uid,detected_at) values ('${A}','${DEV_A}','mcc','${uid}',now())`);
  must(ins("ev-A2"));
  assert.equal(ins("ev-A2").ok, false);
});

test("insert ... on conflict do nothing: the retry writes nothing and keeps the first row", () => {
  const one = (conf) => must(psql(DB, `with i as (insert into cash_events(owner_id,device_id,store_key,event_uid,detected_at,confidence) values ('${A}','${DEV_A}','mcc','ev-A3',now(),${conf}) on conflict (device_id,event_uid) do nothing returning 1) select count(*) from i`));
  assert.equal(one(0.9), "1");
  assert.equal(one(0.1), "0");
  assert.equal(must(psql(DB, "select confidence from cash_events where event_uid='ev-A3' and device_id='" + DEV_A + "'")), "0.9");
});

test("same event_uid on a different device is a different event", () => {
  must(psql(DB, `set role service_role; insert into cash_events(owner_id,device_id,store_key,event_uid,detected_at) values ('${B}','${DEV_B}','mcc','ev-A2',now())`));
});

test("check constraints: confidence range, bad uid, '..' uid, bad store_key, foreign-owner storage path", () => {
  const ins = (cols, vals) => psql(DB, `set role service_role; insert into cash_events(owner_id,device_id,store_key,event_uid,detected_at${cols}) values ('${A}','${DEV_A}','mcc','c-${Math.random().toString(36).slice(2)}',now()${vals})`);
  assert.equal(ins(",confidence", ",1.5").ok, false);
  assert.equal(ins(",confidence", ",0.93").ok, true);
  assert.equal(psql(DB, `set role service_role; insert into cash_events(owner_id,device_id,store_key,event_uid,detected_at) values ('${A}','${DEV_A}','mcc','bad uid!',now())`).ok, false);
  assert.equal(psql(DB, `set role service_role; insert into cash_events(owner_id,device_id,store_key,event_uid,detected_at) values ('${A}','${DEV_A}','mcc','a..b',now())`).ok, false);
  assert.equal(psql(DB, `set role service_role; insert into cash_events(owner_id,device_id,store_key,event_uid,detected_at) values ('${A}','${DEV_A}','MCC Store','zz',now())`).ok, false);
  assert.equal(ins(",snapshot_raw_path", `,'${B}/mcc/x.jpg'`).ok, false);
  assert.equal(ins(",snapshot_raw_path", `,'${A}/mcc/x.jpg'`).ok, true);
});

test("a POS payment can only be matched to one event; 'matched' needs a payment", () => {
  must(psql(DB, `set role service_role; insert into cash_pos_payments(id,owner_id,store_id,store_key,source,source_uuid,source_ref,paid_at,business_date,cash_amount) values ('99999999-0000-0000-0000-000000000001','${A}',gen_random_uuid(),'mcc','invoice','u1','I1',now(),current_date,50)`));
  must(psql(DB, `set role service_role; update cash_events set match_status='matched', matched_payment_id='99999999-0000-0000-0000-000000000001' where event_uid='ev-A1'`));
  assert.equal(psql(DB, `set role service_role; update cash_events set match_status='matched', matched_payment_id='99999999-0000-0000-0000-000000000001' where event_uid='ev-A2' and owner_id='${A}'`).ok, false);
  assert.equal(psql(DB, `set role service_role; update cash_events set match_status='matched' where event_uid='ev-A2' and owner_id='${A}'`).ok, false);
});

test("POS payments: unique per source record and payment; owner isolation on read", () => {
  const dup = psql(DB, `set role service_role; insert into cash_pos_payments(owner_id,store_id,store_key,source,source_uuid,source_ref,paid_at,business_date,cash_amount) values ('${A}',gen_random_uuid(),'mcc','invoice','u1','I1',now(),current_date,50)`);
  assert.equal(dup.ok, false);
  assert.equal(must(as("authenticated", A, "select count(*) from cash_pos_payments")).split("\n").pop(), "1");
  assert.equal(must(as("authenticated", B, "select count(*) from cash_pos_payments")).split("\n").pop(), "0");
});

test("deleting a device that has events is blocked", () => {
  assert.equal(psql(DB, `delete from agent_devices where id='${DEV_A}'`).ok, false);
});

test("agent_devices: camera needs a store; old channels still work; unknown channel refused", () => {
  const ins = (ch, sk) => psql(DB, `insert into agent_devices(owner_id,label,channel,store_key,token_hash) values ('${A}','t','${ch}',${sk},'h-${Math.random()}')`);
  assert.equal(ins("camera", "null").ok, false);
  assert.equal(ins("camera", "'mobiletek'").ok, true);
  assert.equal(ins("glasses", "null").ok, true);
  assert.equal(ins("robot", "null").ok, false);
  assert.equal(ins("camera", "'Bad Key'").ok, false);
});

test("snapshot bucket exists and is private with a size/mime limit", () => {
  assert.equal(must(psql(DB, "select public::text||'|'||file_size_limit||'|'||array_to_string(allowed_mime_types,',') from storage.buckets where id='cash-snapshots'")), "false|10485760|image/jpeg,image/png,video/mp4");
});

test("cash_events is in the realtime publication", () => {
  // The stub server runs with wal_level=replica, which still lets the publication catalog be queried.
  assert.equal(must(psql(DB, "select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename='cash_events'")), "1");
});
