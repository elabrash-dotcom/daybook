// False-detection training examples on real PostgreSQL with the real migrations (phase 1, retention, training).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = "cashtrain_" + process.pid;
const psql = (db, sql, file) => { const r = spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-X", "-d", db, "-t", "-A", ...(file ? ["-f", file] : ["-c", sql])], { encoding: "utf8" }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
const q = (sql) => { const r = psql(DB, sql); assert.ok(r.ok, r.err + "\n" + sql); return r.out; };
const A = "aaaaaaaa-0000-0000-0000-000000000001", B = "bbbbbbbb-0000-0000-0000-000000000002", DEV = "dddddddd-0000-0000-0000-00000000000d";
const as = (uid, sql) => psql(DB, `set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false); ${sql}`);
let n = 0;
const ev = (extra = "") => { const id = crypto.randomUUID(), uid = "evt-" + ++n;
  q(`insert into cash_events(id,owner_id,device_id,store_key,event_uid,detected_at,kind,confidence,track_id,bbox,detections,frame_width,frame_height,raw,snapshot_raw_path,snapshot_annotated_path)
     values ('${id}','${A}','${DEV}','mcc','${uid}','2026-11-16 03:00:00+00','cash',0.81,'7','{"x":0.1,"y":0.2,"w":0.3,"h":0.2,"norm":true}','[{"x":0.1,"y":0.2,"w":0.3,"h":0.2,"norm":true,"label":"cash","confidence":0.81}]',1920,1080,'{"conf_threshold_used":0.5,"model_version":"yolo-cash-v3"}','${A}/mcc/2026-11-16/${uid}/raw.jpg','${A}/mcc/2026-11-16/${uid}/annotated.jpg')`);
  if (extra) q(extra.replaceAll("$ID", id));
  return { id, uid }; };
const label = (id, v, note = "null") => q(`update cash_events set label=${v === null ? "null" : `'${v}'`}, label_note=${note === "null" ? "null" : `'${note}'`} where id='${id}'`);
const count = (w = "true") => +q(`select count(*) from cash_training_examples where ${w}`);

test.before(() => {
  assert.ok(psql("postgres", "select 1").ok, "no local postgres");
  assert.ok(psql("postgres", `create database ${DB}`).ok);
  for (const f of ["supabase_stub.sql", "../../supabase/migrations/20261113_cash_audit_phase1.sql", "../../supabase/migrations/20261114_cash_retention.sql", "../../supabase/migrations/20261117_cash_training.sql"]) { const r = psql(DB, "", path.join(here, f)); assert.ok(r.ok, f + ": " + r.err); }
  q(`insert into auth.users(id,email) values ('${A}','a@x'),('${B}','b@x'); insert into agent_devices(id,owner_id,label,channel,token_hash,store_key) values ('${DEV}','${A}','MCC Jetson D3','camera','h','mcc')`);
});
test.after(() => { psql("postgres", `drop database if exists ${DB} with (force)`); });

test("migration re-runs cleanly (additive, idempotent)", () => {
  assert.ok(psql(DB, "", path.join(here, "../../supabase/migrations/20261117_cash_training.sql")).ok);
});

test("a normal event or any other label collects nothing", () => {
  const e = ev(); label(e.id, "confirmed_cash"); label(e.id, "unsure"); label(e.id, "other"); label(e.id, null);
  assert.equal(count(), 0);
});

test("marking an event false creates one complete example linked to the event, with all metadata", () => {
  const e = ev(); label(e.id, "false_detection", "reflection on the till");
  assert.equal(count(`event_id='${e.id}'`), 1);
  const r = JSON.parse(q(`select row_to_json(x) from (select event_uid, camera_label, store_key, class_name, confidence, model_version, reason, raw_path, annotated_path, image_state, status, hold_set, meta from cash_training_examples where event_id='${e.id}') x`));
  assert.deepEqual([r.event_uid, r.camera_label, r.store_key, r.class_name, r.model_version, r.reason, r.image_state, r.status, r.hold_set], [e.uid, "MCC Jetson D3", "mcc", "cash", "yolo-cash-v3", "reflection on the till", "ok", "collected", true]);
  assert.equal(r.raw_path, `${A}/mcc/2026-11-16/${e.uid}/raw.jpg`);
  assert.equal(r.annotated_path, `${A}/mcc/2026-11-16/${e.uid}/annotated.jpg`);
  const m = r.meta;
  assert.equal(m.schema, "daybook.cash.false_detection/1");
  assert.deepEqual([m.detection.event_id, m.detection.event_uid, m.detection.class, m.detection.confidence, m.detection.track_id, m.detection.frame.width, m.detection.frame.height, m.detection.conf_threshold], [e.id, e.uid, "cash", 0.81, "7", 1920, 1080, 0.5]);
  assert.deepEqual(m.detection.bbox, { x: 0.1, y: 0.2, w: 0.3, h: 0.2, norm: true });
  assert.equal(m.detection.detections.length, 1);
  assert.deepEqual([m.camera.label, m.camera.store_key, m.model.version, m.feedback.label, m.feedback.reason], ["MCC Jetson D3", "mcc", "yolo-cash-v3", "false_detection", "reflection on the till"]);
  assert.ok(m.detection.detected_at && m.feedback.labelled_at);
});

test("the original frames are protected by the existing evidence hold, and the hold is audited", () => {
  const e = ev(); label(e.id, "false_detection");
  assert.equal(q(`select preserve from cash_events where id='${e.id}'`), "t");
  assert.equal(q(`select count(*) from cash_retention.audit where event_id='${e.id}' and action='hold'`), "1");
});

test("image paths are never changed: the example only points at them", () => {
  const e = ev(); const before = q(`select snapshot_raw_path||'|'||snapshot_annotated_path from cash_events where id='${e.id}'`);
  label(e.id, "false_detection", "x"); label(e.id, null); label(e.id, "false_detection", "y");
  assert.equal(q(`select snapshot_raw_path||'|'||snapshot_annotated_path from cash_events where id='${e.id}'`), before);
});

test("duplicates: re-labelling, note edits and toggling never create a second example", () => {
  const e = ev();
  label(e.id, "false_detection", "one"); label(e.id, "false_detection", "two"); label(e.id, null); label(e.id, "false_detection", "three");
  assert.equal(count(`event_id='${e.id}'`), 1);
  assert.equal(q(`select reason from cash_training_examples where event_id='${e.id}'`), "three");
  assert.equal(psql(DB, `insert into cash_training_examples(owner_id,event_uid,device_id,store_key,detected_at,meta) values ('${A}','${e.uid}','${DEV}','mcc',now(),'{}')`).ok, false, "the unique key itself refuses a twin");
  assert.equal(q(`select count(*) from cash_training_examples where event_uid='${e.uid}'`), "1");
});

test("missing frames: example is still collected and says which frame is missing", () => {
  const none = ev(`update cash_events set snapshot_raw_path=null, snapshot_annotated_path=null where id='$ID'`); label(none.id, "false_detection");
  const raw = ev(`update cash_events set snapshot_annotated_path=null where id='$ID'`); label(raw.id, "false_detection");
  const ann = ev(`update cash_events set snapshot_raw_path=null where id='$ID'`); label(ann.id, "false_detection");
  assert.equal(q(`select image_state from cash_training_examples where event_id='${none.id}'`), "missing");
  assert.equal(q(`select image_state from cash_training_examples where event_id='${raw.id}'`), "raw_only");
  assert.equal(q(`select image_state from cash_training_examples where event_id='${ann.id}'`), "annotated_only");
});

test("incomplete metadata: no kind, no confidence, no model, no note, no camera name", () => {
  const e = ev(`update cash_events set kind=null, confidence=null, bbox=null, detections='[]', frame_width=null, frame_height=null, raw='{}' where id='$ID'`);
  q(`update agent_devices set label='x' where false`);
  label(e.id, "false_detection");
  const r = JSON.parse(q(`select row_to_json(x) from (select class_name, confidence, model_version, reason, meta from cash_training_examples where event_id='${e.id}') x`));
  assert.deepEqual([r.class_name, r.confidence, r.model_version, r.reason], ["unknown", null, null, null]);
  assert.equal(r.meta.detection.class, "unknown");
});

test("a frame that arrives after the label updates the example (no duplicate)", () => {
  const e = ev(`update cash_events set snapshot_raw_path=null, snapshot_annotated_path=null where id='$ID'`); label(e.id, "false_detection");
  q(`update cash_events set snapshot_raw_path='${A}/mcc/d/${e.uid}/raw.jpg', snapshot_annotated_path='${A}/mcc/d/${e.uid}/annotated.jpg' where id='${e.id}'`);
  assert.equal(q(`select image_state||'|'||raw_path from cash_training_examples where event_id='${e.id}'`), `ok|${A}/mcc/d/${e.uid}/raw.jpg`);
  assert.equal(count(`event_id='${e.id}'`), 1);
});

test("archived originals are flagged as archived (re-encoded copy), not pretended to be originals", () => {
  const e = ev(); q(`insert into cash_retention.assets(event_id,kind,original,archive,source_sha,archive_sha,original_deleted) values ('${e.id}','raw','o','${A}/archive/x.webp','s','a',true)`);
  label(e.id, "false_detection");
  assert.equal(q(`select image_state from cash_training_examples where event_id='${e.id}'`), "archived");
  assert.equal(q(`select archive from cash_training_assets('${A}', array['${e.id}']::uuid[])`), `${A}/archive/x.webp`);
});

test("withdrawing the false label releases the training hold, but never a person's hold", () => {
  const e = ev(); label(e.id, "false_detection");
  label(e.id, null);
  assert.equal(q(`select status||'|'||hold_set||'|'||hold_release_reason from cash_training_examples where event_id='${e.id}'`), "withdrawn|false|withdrawn");
  assert.equal(q(`select preserve from cash_events where id='${e.id}'`), "f");
  const mine = ev(`update cash_events set preserve=true where id='$ID'`);                       // a person held it first
  assert.equal(q(`select user_hold from cash_events where id='${mine.id}'`), "t");
  label(mine.id, "false_detection");
  assert.equal(q(`select hold_set from cash_training_examples where event_id='${mine.id}'`), "t", "the training hold is recorded as well");
  label(mine.id, null);
  assert.equal(q(`select preserve||'|'||user_hold from cash_events where id='${mine.id}'`), "true|true", "the person's own hold is untouched");
  label(e.id, "false_detection");
  assert.equal(q(`select status||'|'||hold_set from cash_training_examples where event_id='${e.id}'`), "collected|true", "re-labelling re-activates the same example");
  assert.equal(q(`select preserve from cash_events where id='${e.id}'`), "t");
});

test("review actions: reviewed, excluded (releases our hold), include again", () => {
  const e = ev(); label(e.id, "false_detection");
  const id = q(`select id from cash_training_examples where event_id='${e.id}'`);
  const rv = (a, note = "null") => JSON.parse(q(`select cash_training_review('${A}','${id}','${a}',${note === "null" ? "null" : `'${note}'`})`));
  assert.equal(rv("reviewed", "good example").ok, true);
  assert.equal(q(`select status||'|'||review_note from cash_training_examples where id='${id}'`), "reviewed|good example");
  assert.equal(rv("excluded").ok, true);
  assert.equal(q(`select preserve||'|'||hold_set||'|'||hold_release_reason from cash_events e join cash_training_examples x on x.event_id=e.id where e.id='${e.id}'`), "false|false|excluded");
  assert.equal(rv("reviewed").ok, false, "excluded must be included again first");
  label(e.id, "false_detection", "edit"); // a note edit never resurrects an excluded example
  assert.equal(q(`select status from cash_training_examples where id='${id}'`), "excluded");
  assert.equal(rv("include").ok, true);
  assert.equal(q(`select status||'|'||hold_set from cash_training_examples where id='${id}'`), "collected|true");
  assert.equal(q(`select preserve from cash_events where id='${e.id}'`), "t");
  assert.equal(rv("nonsense").ok, false);
  assert.equal(JSON.parse(q(`select cash_training_review('${B}','${id}','reviewed',null)`)).ok, false, "another owner cannot review it");
});

test("the example outlives the event: metadata and link-by-uid stay when the event expires", () => {
  const e = ev(); label(e.id, "false_detection");
  q(`update cash_events set preserve=false where id='${e.id}'; delete from cash_events where id='${e.id}'`);
  assert.equal(q(`select (event_id is null)::text||'|'||(meta->'detection'->>'event_uid')||'|'||(event_uid) from cash_training_examples where event_uid='${e.uid}'`), `true|${e.uid}|${e.uid}`);
});

test("backfill collects earlier false labels once", () => {
  q(`alter table cash_events disable trigger cash_training_on_event`);
  const e = ev(); label(e.id, "false_detection"); // trigger off: simulates an event labelled before the migration
  q(`alter table cash_events enable trigger cash_training_on_event`);
  assert.equal(count(`event_id='${e.id}'`), 0);
  assert.ok(+q(`select cash_training_backfill('${A}')`) >= 1);
  assert.equal(count(`event_id='${e.id}'`), 1);
  assert.equal(+q(`select cash_training_backfill('${A}')`), 0, "second run adds nothing");
});

test("RLS: owner reads own examples only; the app cannot write, edit or delete; helper functions are service-only", () => {
  const read = (u) => +as(u, "select count(*) from cash_training_examples").out.split("\n").pop();
  assert.ok(read(A) > 0); assert.equal(read(B), 0);
  for (const sql of ["update cash_training_examples set status='excluded'", "delete from cash_training_examples", `insert into cash_training_examples(owner_id,event_uid,device_id,store_key,detected_at,meta) values (auth.uid(),'z','${DEV}','mcc',now(),'{}')`,
    `select cash_training_review('${A}', gen_random_uuid(), 'reviewed', null)`, `select cash_training_backfill('${A}')`, `select * from cash_training_assets('${A}', array[]::uuid[])`]) assert.equal(as(A, sql).ok, false, sql);
  assert.equal(psql(DB, "set role anon; select count(*) from cash_training_examples").ok, false);
});

test("the app's existing label update still works for the owner, and the collection runs under their own update", () => {
  const e = ev();
  const r = as(A, `update cash_events set label='false_detection', label_note='from app' where id='${e.id}'`); assert.ok(r.ok, r.err);
  assert.equal(count(`event_id='${e.id}' and reason='from app' and collected_by='${A}'`), 1);
  assert.equal(as(B, `update cash_events set label='false_detection' where id='${e.id}'`).out.includes("UPDATE 1"), false, "another owner cannot label it");
});

test("a failing collection never blocks labelling; it is logged and a backfill recovers it", () => {
  q(`alter table cash_training_examples add constraint boom check (class_name <> 'boom') not valid`);
  const e = ev(`update cash_events set kind='boom' where id='$ID'`);
  const r = psql(DB, `update cash_events set label='false_detection', label_note='n' where id='${e.id}'`);
  assert.ok(r.ok, "the label must still save: " + r.err);
  assert.equal(q(`select label from cash_events where id='${e.id}'`), "false_detection");
  assert.equal(count(`event_id='${e.id}'`), 0);
  assert.match(q(`select action from cash_retention.audit where event_id='${e.id}' and action like 'training collect failed%'`), /boom|training collect failed/);
  q(`alter table cash_training_examples drop constraint boom`);
  assert.equal(+q(`select cash_training_backfill('${A}')`) >= 1, true);
  assert.equal(count(`event_id='${e.id}'`), 1);
});
