// Retention of training evidence: 180 days from collection, then released automatically unless a person also holds the frames.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = "cashret_" + process.pid, M = (f) => path.join(here, "../../supabase/migrations", f);
const psql = (db, sql, file) => { const r = spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-X", "-d", db, "-t", "-A", ...(file ? ["-f", file] : ["-c", sql])], { encoding: "utf8" }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
const q = (sql) => { const r = psql(DB, sql); assert.ok(r.ok, r.err + "\n" + sql); return r.out; };
const A = "aaaaaaaa-0000-0000-0000-000000000001", B = "bbbbbbbb-0000-0000-0000-000000000002", DEV = "dddddddd-0000-0000-0000-00000000000d";
const as = (uid, sql) => psql(DB, `set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false); ${sql}`);
const day = (n) => `now() + interval '${n} days'`;
let n = 0;
const ev = (extra = "") => { const id = crypto.randomUUID(), uid = "r-" + ++n;
  q(`insert into cash_events(id,owner_id,device_id,store_key,event_uid,detected_at,kind,confidence,snapshot_raw_path,snapshot_annotated_path) values ('${id}','${A}','${DEV}','mcc','${uid}',now(),'cash',0.8,'${A}/mcc/d/${uid}/raw.jpg','${A}/mcc/d/${uid}/annotated.jpg')`);
  if (extra) q(extra.replaceAll("$ID", id)); return { id, uid }; };
const label = (id, v) => q(`update cash_events set label=${v ? `'${v}'` : "null"} where id='${id}'`);
const ex = (id) => JSON.parse(q(`select row_to_json(x) from (select id,status,hold_set,hold_until,hold_released_at,hold_release_reason, extract(epoch from hold_until - collected_at)/86400 as days from cash_training_examples where event_id='${id}') x`));
const ev1 = (id) => JSON.parse(q(`select row_to_json(x) from (select preserve,user_hold from cash_events where id='${id}') x`));
const expire = (inDays) => +q(`select cash_training_expire(${day(inDays)})`);

test.before(() => {
  assert.ok(psql("postgres", `create database ${DB}`).ok);
  for (const f of [path.join(here, "supabase_stub.sql"), path.join(here, "phase2_stub.sql"), M("20261113_cash_audit_phase1.sql"), M("20261114_cash_retention.sql")]) assert.ok(psql(DB, "", f).ok, f);
  // a hold that already exists BEFORE the training migration is a person's hold
  q(`insert into auth.users(id,email) values ('${A}','a@x'),('${B}','b@x'); insert into agent_devices(id,owner_id,label,channel,token_hash,store_key) values ('${DEV}','${A}','Cam','camera','h','mcc')`);
  ev(`update cash_events set preserve=true where id='$ID'`);
  const r = psql(DB, "", M("20261117_cash_training.sql")); assert.ok(r.ok, r.err);
});
test.after(() => { psql("postgres", `drop database if exists ${DB} with (force)`); });

test("holds that existed before the migration are recorded as people's holds; re-running the migration does not reclassify training holds", () => {
  assert.equal(q("select count(*) from cash_events where preserve and user_hold"), "1");
  const e = ev(); label(e.id, "false_detection");
  assert.ok(psql(DB, "", M("20261117_cash_training.sql")).ok);
  assert.deepEqual(ev1(e.id), { preserve: true, user_hold: false }, "a training hold is not turned into a person's hold by a second run");
});

test("the policy default is 180 days and the hold ends exactly 180 days after collection", () => {
  assert.equal(q("select training_days from cash_retention.policy"), "180");
  const e = ev(); label(e.id, "false_detection"); const x = ex(e.id);
  assert.equal(x.hold_set, true); assert.ok(Math.abs(x.days - 180) < 0.01, "hold_until - collected_at = " + x.days);
});

test("nothing is released before 180 days; everything due is released after, automatically and idempotently", () => {
  const e = ev(); label(e.id, "false_detection");
  const before = expire(0); assert.equal(expire(179), 0 + (before - before), "nothing due at day 179 (other examples may exist but none are due)");
  assert.deepEqual(ev1(e.id), { preserve: true, user_hold: false });
  assert.ok(expire(181) >= 1);
  const x = ex(e.id); assert.deepEqual([x.hold_set, x.hold_release_reason, !!x.hold_released_at], [false, "expired", true]);
  assert.deepEqual(ev1(e.id), { preserve: false, user_hold: false }, "retention can now archive the frames in the normal way");
  assert.equal(expire(400), 0, "second run does nothing");
  assert.equal(q(`select count(*) from cash_retention.audit where event_id='${e.id}' and action='training hold released: expired'`), "1");
  assert.equal(q(`select count(*) from cash_retention.audit where event_id='${e.id}' and action='release'`), "1", "the existing hold audit log records the release too");
});

test("a person's own hold survives the expiry: only the training hold is released", () => {
  const e = ev(); label(e.id, "false_detection");
  q(`update cash_events set user_hold=true where id='${e.id}'`);                       // "Keep permanently"
  expire(181);
  assert.deepEqual(ev1(e.id), { preserve: true, user_hold: true }); assert.equal(ex(e.id).hold_set, false);
  const m = ev(`update cash_events set preserve=true where id='$ID'`); label(m.id, "false_detection"); expire(181);   // person held first
  assert.deepEqual(ev1(m.id), { preserve: true, user_hold: true });
});

test("pressing 'Release evidence hold' cannot drop frames that are still under the training hold", () => {
  const e = ev(); label(e.id, "false_detection");
  const r = as(A, `update cash_events set preserve=false where id='${e.id}'`); assert.ok(r.ok, r.err);
  assert.deepEqual(ev1(e.id), { preserve: true, user_hold: false }, "still held for training");
  const m = ev(); q(`update cash_events set preserve=true where id='${m.id}'`); label(m.id, "false_detection");   // person + training
  as(A, `update cash_events set preserve=false where id='${m.id}'`);
  assert.deepEqual(ev1(m.id), { preserve: true, user_hold: false }, "the person's hold is gone, the training hold keeps the frames");
  expire(181); assert.deepEqual(ev1(m.id), { preserve: false, user_hold: false });
  const free = ev(); as(A, `update cash_events set preserve=true where id='${free.id}'`); assert.deepEqual(ev1(free.id), { preserve: true, user_hold: true });
  as(A, `update cash_events set preserve=false where id='${free.id}'`); assert.deepEqual(ev1(free.id), { preserve: false, user_hold: false }, "ordinary manual hold and release work as before");
});

test("excluding releases the training hold immediately (without overriding a person's hold); including restarts 180 days", () => {
  const e = ev(); label(e.id, "false_detection"); const id = ex(e.id).id;
  const rv = (a, oid = A) => JSON.parse(q(`select cash_training_review('${oid}','${id}','${a}',null)`));
  assert.equal(rv("excluded").ok, true);
  let x = ex(e.id); assert.deepEqual([x.hold_set, x.hold_release_reason, x.status], [false, "excluded", "excluded"]);
  assert.deepEqual(ev1(e.id), { preserve: false, user_hold: false });
  assert.equal(rv("include").ok, true); x = ex(e.id); assert.ok(x.hold_set && Math.abs((Date.parse(q(`select ${day(180)}`)) - Date.parse(q(`select hold_until from cash_training_examples where id='${id}'`))) / 864e5) < 0.01);
  assert.deepEqual(ev1(e.id), { preserve: true, user_hold: false });
  q(`update cash_events set user_hold=true where id='${e.id}'`); rv("excluded");
  assert.deepEqual(ev1(e.id), { preserve: true, user_hold: true }, "excluded, but a person's hold stays");
});

test("an expired example stays collected, is not re-held by later edits, and can be re-included", () => {
  const e = ev(); label(e.id, "false_detection"); const id = ex(e.id).id; expire(181);
  q(`update cash_events set label_note='late edit' where id='${e.id}'`);
  assert.deepEqual([ex(e.id).hold_set, ev1(e.id).preserve, ex(e.id).status], [false, false, "collected"], "a note edit does not restart retention");
  q(`select cash_training_review('${A}','${id}','include',null)`); assert.deepEqual([ex(e.id).hold_set, ev1(e.id).preserve], [true, true]);
});

test("changing the policy changes new holds; a bad value is refused", () => {
  q("update cash_retention.policy set training_days=7");
  const e = ev(); label(e.id, "false_detection"); assert.ok(Math.abs(ex(e.id).days - 7) < 0.01);
  assert.equal(psql(DB, "update cash_retention.policy set training_days=0").ok, false);
  q("update cash_retention.policy set training_days=180");
});

test("the daily job is registered once (and again only as the same single job)", () => {
  assert.equal(q("select count(*) from cron.job where jobname='cash-training-retention'"), "1");
  assert.ok(psql(DB, "", M("20261117_cash_training.sql")).ok);
  assert.equal(q("select count(*)||'|'||min(schedule)||'|'||min(command) from cron.job where jobname='cash-training-retention'"), "1|17 3 * * *|select public.cash_training_expire()");
});

test("expiry and review functions are service-only; the app cannot extend or shorten a hold", () => {
  const e = ev(); label(e.id, "false_detection");
  for (const sql of ["select cash_training_expire()", `select cash_training_release_hold(gen_random_uuid(),'x')`, `select cash_training_place_hold(gen_random_uuid())`, `update cash_training_examples set hold_until=now()+interval '9999 days'`]) assert.equal(as(A, sql).ok, false, sql);
});

test("export still works for an expired example: archived copy is used once the retention worker has moved the originals", () => {
  const e = ev(); label(e.id, "false_detection"); expire(181);
  q(`insert into cash_retention.assets(event_id,kind,original,archive,source_sha,archive_sha,original_deleted) values ('${e.id}','raw','o','${A}/archive/${e.uid}.webp','s','a',true)`);
  assert.equal(q(`select archive from cash_training_assets('${A}', array['${e.id}']::uuid[])`), `${A}/archive/${e.uid}.webp`);
});
