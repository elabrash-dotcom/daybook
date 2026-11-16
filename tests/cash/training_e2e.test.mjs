// The whole workflow: detection -> frames uploaded -> user marks it false (real RLS update) -> example saved -> dataset -> ZIP.
// Real HTTP + real PostgreSQL (real migrations) + real handlers; Supabase Storage is emulated on disk (see pg_harness.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { pg, startServer, randomUUID } from "./pg_harness.mjs";
import { cashGate } from "../../supabase/functions/agent-gateway/cash.ts";
import { handleTrainingExport, handleTrainingReview } from "../../supabase/functions/agent-gateway/cash_training.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = "cashe2e_" + process.pid;
const psql = (db, sql, file) => { const r = spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-X", "-d", db, "-t", "-A", ...(file ? ["-f", file] : ["-c", sql])], { encoding: "utf8" }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
const sha = (b) => createHash("sha256").update(b).digest("hex");
const OWNER = randomUUID(), OTHER = randomUUID();
let pool, srv, camToken, now = Date.now(), failPaths = new Set();
const clock = () => now;
// Two different "photos" so a mix-up between raw and annotated would be caught.
const RAW = Buffer.concat([Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex"), Buffer.from("RAW-FRAME-ORIGINAL-".repeat(50)), Buffer.from("ffd9", "hex")]);
const ANN = Buffer.concat([Buffer.from("ffd8ffe000104a46494600010100000100010000", "hex"), Buffer.from("ANNOTATED-WITH-BOXES-".repeat(50)), Buffer.from("ffd9", "hex")]);
const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

const pgTrainingStore = () => ({
  async list(o, f) {
    const w = ["owner_id=$1", "status = any($2)", "store_key not ilike '%fairfield%'"], a = [o, f.status];
    if (f.store) { a.push(f.store); w.push(`store_key=$${a.length}`); } if (f.cls) { a.push(f.cls); w.push(`class_name=$${a.length}`); }
    const rows = (await pool.query(`select * from cash_training_examples where ${w.join(" and ")} order by detected_at desc limit ${f.limit} offset ${f.offset}`, a)).rows.map((r) => ({ ...r, detected_at: r.detected_at.toISOString() }));
    const total = +(await pool.query(`select count(*) from cash_training_examples where ${w.join(" and ")}`, a)).rows[0].count;
    return { rows, total };
  },
  async currentPaths(o, ids) { return Object.fromEntries((await pool.query("select id,snapshot_raw_path r,snapshot_annotated_path a from cash_events where owner_id=$1 and id=any($2::uuid[])", [o, ids])).rows.map((r) => [r.id, { raw: r.r, annotated: r.a }])); },
  async archives(o, ids) { return (await pool.query("select * from cash_training_assets($1,$2::uuid[])", [o, ids])).rows; },
  async download(p) { if (failPaths.has(p)) throw new Error("storage 503"); const f = path.join(srv.disk, p); return fs.existsSync(f) ? new Uint8Array(fs.readFileSync(f)) : null; },
  async review(o, id, a, n) { return (await pool.query("select cash_training_review($1,$2,$3,$4) r", [o, id, a, n])).rows[0].r; },
});

const extra = async (rq, rs, url, body) => {
  if (!url.pathname.startsWith("/cash/training/")) return false;
  const send = async (res) => { rs.writeHead(res.status, Object.fromEntries(res.headers)); rs.end(Buffer.from(await res.arrayBuffer())); return true; };
  const h = rq.headers.authorization ?? "", tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!tok) return send(reply({ error: "unauthorised" }, 401));
  const who = tok.startsWith("jwt:") ? { isDevice: false, ownerId: tok.slice(4) } : { isDevice: true, channel: "camera" };
  const gate = cashGate(who, url.pathname); if (gate) return send(reply({ error: gate.error }, gate.status));
  const req = new Request("http://x" + url.pathname + url.search, { method: rq.method, body: ["GET", "HEAD"].includes(rq.method) ? undefined : body });
  if (url.pathname === "/cash/training/export" && rq.method === "GET") return send(await handleTrainingExport(req, who.ownerId, pgTrainingStore(), reply, {}));
  if (url.pathname === "/cash/training/review" && rq.method === "POST") return send(await handleTrainingReview(req, who.ownerId, pgTrainingStore(), reply));
  return send(reply({ error: "not found" }, 404));
};

const call = async (method, p, { token = camToken, body, raw } = {}) => {
  const r = await fetch(srv.base + p, { method, headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? raw : JSON.stringify(body) });
  return r;
};
const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

// What the user's phone does: a real UPDATE as the `authenticated` role under row level security.
const userLabel = async (eventId, label, note = null, uid = OWNER) => {
  const c = await pool.connect();
  try { await c.query("begin"); await c.query("set local role authenticated"); await c.query("select set_config('request.jwt.claim.sub',$1,true)", [uid]);
    const r = await c.query("update cash_events set label=$2, label_note=$3 where id=$1", [eventId, label, note]); await c.query("commit"); return r.rowCount;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const eventRow = async (uid) => (await pool.query("select * from cash_events where event_uid=$1", [uid])).rows[0];
const sendEvent = (uid, extraFields = {}) => call("POST", "/cash/events", { body: { events: [{ event_id: uid, timestamp: new Date(now - 60e3).toISOString(), event_type: "cash", confidence: 0.77, track_id: 4, model_version: "yolo-cash-v3",
  detections: [{ label: "cash", conf: 0.77, bbox: { x1: 100, y1: 120, x2: 300, y2: 260 }, track_id: 4 }], frame_width: 1920, frame_height: 1080, ...extraFields }] } });
const upload = async (uid) => {
  const u = await json(await call("POST", "/cash/uploads", { body: { event_id: uid, kinds: ["raw", "annotated"] } }));
  assert.equal(u.ok, true, JSON.stringify(u));
  for (const [kind, bytes] of [["raw", RAW], ["annotated", ANN]]) { const r = await fetch(u.uploads[kind].url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: bytes }); assert.equal(r.status, 200, kind); }
  const c = await json(await call("POST", "/cash/assets/confirm", { body: { event_id: uid, kinds: ["raw", "annotated"] } })); assert.equal(c.ok, true, JSON.stringify(c));
};
const unzip = (bytes) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-")), "x.zip"); fs.writeFileSync(f, bytes);
  const t = spawnSync("python3", ["-I", "-c", "import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({'bad':z.testzip(),'names':z.namelist()}))", f], { encoding: "utf8" }); assert.equal(t.status, 0, t.stderr);
  const info = JSON.parse(t.stdout); assert.equal(info.bad, null);
  const read = (n) => { const r = spawnSync("python3", ["-I", "-c", "import zipfile,sys;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))", f, n]); assert.equal(r.status, 0); return Buffer.from(r.stdout); };
  return { names: info.names, read, json: (n) => JSON.parse(read(n).toString()) };
};
const exportZip = async (qs = "", token = "jwt:" + OWNER) => { const r = await call("GET", "/cash/training/export" + qs, { token }); return { r, zip: r.status === 200 ? unzip(Buffer.from(await r.arrayBuffer())) : null, body: r.status === 200 ? null : await json(r) }; };

test.before(async () => {
  psql("postgres", `create database ${DB}`);
  for (const f of ["supabase_stub.sql", "../../supabase/migrations/20261113_cash_audit_phase1.sql", "../../supabase/migrations/20261114_cash_retention.sql", "../../supabase/migrations/20261117_cash_training.sql"]) { const r = psql(DB, "", path.join(here, f)); assert.ok(r.ok, f + r.err); }
  psql(DB, `insert into auth.users(id,email) values ('${OWNER}','o@x'),('${OTHER}','p@x')`);
  pool = new pg.Pool({ host: process.env.PGHOST, port: +process.env.PGPORT, user: process.env.PGUSER, database: DB });
  srv = await startServer(pool, { clock, extra });
  const c = await json(await call("POST", "/admin/devices", { token: "jwt:" + OWNER, body: { label: "Jetson MCC", store_key: "mcc" } })); camToken = c.token;
});
test.after(async () => { srv?.close(); await pool?.end(); psql("postgres", `drop database if exists ${DB} with (force)`); });

let first, firstDir;
test("1-5: detection -> frames saved -> user marks it false -> example saved with hold, JSON and links", async () => {
  assert.equal((await json(await sendEvent("det-1"))).created, 1);
  await upload("det-1");
  const ev = await eventRow("det-1"); first = ev;
  assert.equal(await userLabel(ev.id, "false_detection", "it is a receipt, not cash"), 1);
  const ex = (await pool.query("select * from cash_training_examples where event_id=$1", [ev.id])).rows;
  assert.equal(ex.length, 1);
  const x = ex[0];
  assert.deepEqual([x.event_uid, x.store_key, x.camera_label, x.class_name, x.model_version, x.reason, x.image_state, x.status, x.hold_set, x.collected_by],
    ["det-1", "mcc", "Jetson MCC", "cash", "yolo-cash-v3", "it is a receipt, not cash", "ok", "collected", true, OWNER]);
  assert.equal(x.raw_path, ev.snapshot_raw_path); assert.equal(x.annotated_path, ev.snapshot_annotated_path);
  assert.equal(x.meta.detection.confidence, 0.77); assert.deepEqual([x.meta.detection.frame.width, x.meta.detection.frame.height], [1920, 1080]);
  assert.equal((await eventRow("det-1")).preserve, true);
  // the stored frames are exactly what the camera sent (originals untouched by labelling)
  assert.equal(sha(fs.readFileSync(path.join(srv.disk, ev.snapshot_raw_path))), sha(RAW));
  assert.equal(sha(fs.readFileSync(path.join(srv.disk, ev.snapshot_annotated_path))), sha(ANN));
});

test("6: the dataset exports as a valid ZIP with the untouched original, the annotated image and the JSON", async () => {
  const { r, zip } = await exportZip();
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "application/zip");
  const dirs = zip.names.filter((n) => n.endsWith("/meta.json")); assert.equal(dirs.length, 1);
  firstDir = dirs[0].replace("/meta.json", ""); assert.match(firstDir, /^mcc-jetson-mcc\/\d{4}-\d{2}-\d{2}\/cash\/det-1-/);
  assert.equal(sha(zip.read(`${firstDir}/raw.jpg`)), sha(RAW), "raw frame is byte-identical to what the camera uploaded");
  assert.equal(sha(zip.read(`${firstDir}/annotated.jpg`)), sha(ANN));
  assert.notEqual(sha(zip.read(`${firstDir}/raw.jpg`)), sha(zip.read(`${firstDir}/annotated.jpg`)));
  const m = zip.json(`${firstDir}/meta.json`);
  assert.deepEqual([m.schema, m.detection.event_uid, m.detection.class, m.detection.confidence, m.feedback.reason, m.model.version, m.camera.label, m.export.image_source], ["daybook.cash.false_detection/1", "det-1", "cash", 0.77, "it is a receipt, not cash", "yolo-cash-v3", "Jetson MCC", "original"]);
  assert.equal(m.detection.detections.length, 1); assert.ok(m.detection.bbox);
  const line = JSON.parse(zip.read("manifest.jsonl").toString().trim()); assert.deepEqual([line.event_uid, line.raw, line.annotated], ["det-1", "raw.jpg", "annotated.jpg"]);
});

test("duplicates: same detection re-sent, label toggled, label re-sent, note edited -> still exactly one example and one set of files", async () => {
  await sendEvent("det-1"); await sendEvent("det-1");                                   // camera retries
  await userLabel(first.id, "false_detection", "it is a receipt, not cash");            // same label again
  await userLabel(first.id, null); await userLabel(first.id, "false_detection", "edited"); // toggled
  assert.equal(+(await pool.query("select count(*) from cash_training_examples where event_uid='det-1'")).rows[0].count, 1);
  assert.equal(+(await pool.query("select count(*) from cash_events where event_uid='det-1'")).rows[0].count, 1);
  const { zip } = await exportZip(); assert.equal(zip.names.filter((n) => n.endsWith("/raw.jpg")).length, 1);
  assert.equal(zip.json(`${firstDir}/meta.json`).feedback.reason, "edited");
  const files = fs.readdirSync(path.join(srv.disk, first.snapshot_raw_path, ".."));
  assert.deepEqual(files.sort(), ["annotated.jpg", "raw.jpg"], "no extra copies in storage");
});

test("missing images: a detection whose upload never happened is still collected and exported with a warning", async () => {
  await sendEvent("det-2", { event_type: "card" });
  const ev = await eventRow("det-2"); assert.equal(ev.snapshot_raw_path, null);
  await userLabel(ev.id, "false_detection", "no frame");
  assert.equal((await pool.query("select image_state from cash_training_examples where event_id=$1", [ev.id])).rows[0].image_state, "missing");
  const { zip } = await exportZip(); const d = zip.names.find((n) => n.includes("/card/det-2-") && n.endsWith("meta.json"));
  assert.ok(d); const m = zip.json(d); assert.deepEqual([m.export.files.raw, m.export.files.annotated], [null, null]); assert.match(m.export.warnings.join(" "), /never uploaded/);
});

test("late frames: uploading after the label updates the example", async () => {
  const ev = await eventRow("det-2"); await upload("det-2");
  assert.equal((await pool.query("select image_state from cash_training_examples where event_id=$1", [ev.id])).rows[0].image_state, "ok");
  const { zip } = await exportZip(); const d = zip.names.find((n) => n.includes("/card/det-2-") && n.endsWith("raw.jpg")); assert.ok(d);
  assert.equal(sha(zip.read(d)), sha(RAW));
});

test("failed storage: a file that errors or vanished is skipped with a warning; the rest still exports", async () => {
  const ev = await eventRow("det-1");
  failPaths.add(ev.snapshot_annotated_path);
  let { r, zip } = await exportZip(); assert.equal(r.status, 200);
  assert.ok(!zip.names.includes(`${firstDir}/annotated.jpg`)); assert.match(zip.json(`${firstDir}/meta.json`).export.warnings[0], /storage error: storage 503/); assert.ok(zip.names.includes(`${firstDir}/raw.jpg`));
  failPaths.clear();
  const f = path.join(srv.disk, ev.snapshot_raw_path), keep = fs.readFileSync(f); fs.unlinkSync(f);
  ({ r, zip } = await exportZip()); assert.equal(r.status, 200); assert.ok(!zip.names.includes(`${firstDir}/raw.jpg`)); assert.match(zip.json(`${firstDir}/meta.json`).export.warnings.join(" "), /raw frame was not found/);
  fs.writeFileSync(f, keep);
});

test("review: excluded examples leave the default export and release our hold; they can be included again", async () => {
  const id = (await pool.query("select id from cash_training_examples where event_uid='det-2'")).rows[0].id;
  let r = await json(await call("POST", "/cash/training/review", { token: "jwt:" + OWNER, body: { id, action: "excluded", note: "poor quality" } })); assert.equal(r.ok, true);
  assert.equal((await eventRow("det-2")).preserve, false);
  let z = (await exportZip()).zip; assert.ok(!z.names.some((n) => n.includes("det-2-")));
  z = (await exportZip("?status=excluded")).zip; assert.ok(z.names.some((n) => n.includes("det-2-")));
  assert.equal((await json(await call("POST", "/cash/training/review", { token: "jwt:" + OWNER, body: { id, action: "include" } }))).ok, true);
  assert.equal((await eventRow("det-2")).preserve, true);
  assert.equal((await json(await call("POST", "/cash/training/review", { token: "jwt:" + OWNER, body: { id, action: "reviewed", note: "ok" } }))).ok, true);
  assert.equal((await pool.query("select status from cash_training_examples where id=$1", [id])).rows[0].status, "reviewed");
});

test("filters: by class and store; empty result is a clean 404", async () => {
  let z = (await exportZip("?class=card")).zip; assert.ok(z.names.every((n) => !n.includes("/cash/det-1")) && z.names.some((n) => n.includes("/card/")));
  const e = await exportZip("?class=nothing"); assert.equal(e.r.status, 404);
  assert.equal((await exportZip("?store=fairfield")).r.status, 404, "Fairfield is never exported");
  assert.equal((await exportZip("?status=bogus")).r.status, 400);
});

test("permissions: not signed in -> 401; camera token -> 403; another owner sees nothing and cannot review", async () => {
  assert.equal((await exportZip("", "")).r.status, 401);
  assert.equal((await exportZip("", camToken)).r.status, 403);
  assert.equal((await call("POST", "/cash/training/review", { token: camToken, body: { id: randomUUID(), action: "reviewed" } })).status, 403);
  assert.equal((await exportZip("", "jwt:" + OTHER)).r.status, 404);
  const id = (await pool.query("select id from cash_training_examples limit 1")).rows[0].id;
  assert.equal((await call("POST", "/cash/training/review", { token: "jwt:" + OTHER, body: { id, action: "excluded" } })).status, 404);
  assert.equal(await userLabel(first.id, "false_detection", "hijack", OTHER), 0, "another owner cannot label this event");
});

test("live detection is unaffected: ingestion and frame upload do no training work", async () => {
  const before = +(await pool.query("select count(*) from cash_training_examples")).rows[0].count;
  for (let i = 0; i < 5; i++) { await sendEvent("live-" + i); await upload("live-" + i); }
  assert.equal(+(await pool.query("select count(*) from cash_training_examples")).rows[0].count, before, "unlabelled events never create examples");
  const t = await pool.query("select count(*) from pg_trigger where tgname='cash_training_on_event' and tgenabled='O'"); assert.equal(+t.rows[0].count, 1);
  // the trigger only fires for false-labelled events: its WHEN clause keeps it off the ingestion path
  assert.match((await pool.query("select pg_get_triggerdef(oid) d from pg_trigger where tgname='cash_training_on_event'")).rows[0].d, /WHEN \(+new\.label = 'false_detection'.*old\.label = 'false_detection'/s);
});
