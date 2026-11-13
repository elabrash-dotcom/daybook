// End-to-end over real HTTP, real PostgreSQL (real migration), real handlers, emulated storage.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pg, startServer, randomUUID, sha } from "./pg_harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = "cashint_" + process.pid;
const psql = (db, sql, file) => { const r = spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-X", "-d", db, "-t", "-A", ...(file ? ["-f", file] : ["-c", sql])], { encoding: "utf8" }); return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() }; };
const OWNER = randomUUID(), OTHER = randomUUID();
let pool, srv, now = Date.now(), camToken, camId, adm = (t) => ({ authorization: "Bearer " + t });
const clock = () => now;
const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");

const call = async (method, p, { token = camToken, body, headers } = {}) => {
  const r = await fetch(srv.base + p, { method, headers: { ...(token ? adm(token) : {}), "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j };
};
const sydneyIso = (ms) => new Date(ms).toISOString(); // device may send UTC or offset; both are tested elsewhere
const event = (id, extra = {}) => ({ event_id: id, timestamp: sydneyIso(now - 60e3), event_type: "cash_handover", confidence: 0.88, track_id: 7,
  detections: [{ label: "cash", conf: 0.88, bbox: { x1: 100, y1: 120, x2: 300, y2: 260 }, track_id: 7 }], frame_width: 1920, frame_height: 1080, ...extra });

test.before(async () => {
  psql("postgres", `create database ${DB}`);
  assert.ok(psql(DB, "", path.join(here, "supabase_stub.sql")).ok);
  assert.ok(psql(DB, "", path.join(here, "../../supabase/migrations/20261113_cash_audit_phase1.sql")).ok);
  psql(DB, `insert into auth.users(id,email) values ('${OWNER}','o@x'),('${OTHER}','p@x')`);
  pool = new pg.Pool({ host: process.env.PGHOST, port: +process.env.PGPORT, user: process.env.PGUSER, database: DB });
  srv = await startServer(pool, { clock });
});
test.after(async () => { srv?.close(); await pool?.end(); psql("postgres", `drop database if exists ${DB} with (force)`); });

test("admin creates a camera device over HTTP; token works; list never shows it", async () => {
  const c = await call("POST", "/admin/devices", { token: "jwt:" + OWNER, body: { label: "Jetson MCC", store_key: "mcc" } });
  assert.equal(c.status, 200); camToken = c.body.token; camId = c.body.id;
  assert.match(camToken, /^dvc_/);
  const l = await call("GET", "/admin/devices", { token: "jwt:" + OWNER });
  assert.ok(!JSON.stringify(l.body).includes(camToken));
  assert.equal((await call("GET", "/cash/ping")).body.store_key, "mcc");
});

test("auth: no token / bad token / user JWT on /cash / camera on other routes", async () => {
  assert.equal((await call("GET", "/cash/ping", { token: null })).status, 401);
  assert.equal((await call("GET", "/cash/ping", { token: "dvc_nope" })).status, 401);
  assert.equal((await call("POST", "/cash/events", { token: "jwt:" + OWNER, body: event("x") })).status, 403);
  for (const p of ["/feed", "/message", "/admin/devices", "/status"]) assert.equal((await call("GET", p)).status, 403, p);
  assert.equal((await call("GET", "/cash/images")).status, 403);
});

test("full device sequence: events -> uploads -> PUT files -> confirm -> owner sees signed images", async () => {
  const e = await call("POST", "/cash/events", { body: { events: [event("jet-0001")] } });
  assert.deepEqual([e.status, e.body.created], [200, 1]);
  const up = await call("POST", "/cash/uploads", { body: { event_id: "jet-0001", kinds: ["raw", "annotated"] } });
  assert.equal(up.status, 200);
  for (const k of ["raw", "annotated"]) {
    const u = up.body.uploads[k];
    assert.equal(u.content_type, "image/jpeg");
    const put = await fetch(u.url, { method: "PUT", headers: { "content-type": u.content_type }, body: Buffer.concat([JPEG, Buffer.from(k)]) });
    assert.equal(put.status, 200, k);
  }
  const conf = await call("POST", "/cash/assets/confirm", { body: { event_id: "jet-0001", kinds: ["raw", "annotated"] } });
  assert.deepEqual([conf.body.ok, conf.body.confirmed], [true, ["raw", "annotated"]]);
  const row = (await pool.query("select id, snapshot_raw_path, snapshot_annotated_path, bbox, confidence, track_id from cash_events where event_uid='jet-0001'")).rows[0];
  assert.ok(row.snapshot_raw_path.startsWith(OWNER + "/mcc/")); assert.equal(row.confidence, 0.88); assert.equal(row.track_id, "7");
  assert.deepEqual(row.bbox, { x: 100, y: 120, w: 200, h: 140, norm: false, label: "cash", confidence: 0.88, track_id: "7" });
  const im = await call("POST", "/cash/images", { token: "jwt:" + OWNER, body: { event_ids: [row.id] } });
  assert.equal(im.status, 200);
  const got = await fetch(im.body.items[row.id].raw);
  assert.equal(got.status, 200); assert.ok(Buffer.from(await got.arrayBuffer()).toString().endsWith("raw"));
  assert.equal(im.body.items[row.id].clip, null);
});

test("images are private: other owner gets nothing; tampered/expired links refused; no anonymous access", async () => {
  const id = (await pool.query("select id, snapshot_raw_path p from cash_events where event_uid='jet-0001'")).rows[0];
  const other = await call("POST", "/cash/images", { token: "jwt:" + OTHER, body: { event_ids: [id.id] } });
  assert.deepEqual(other.body.items, {});
  assert.equal((await call("POST", "/cash/images", { token: null, body: { event_ids: [id.id] } })).status, 401);
  assert.equal((await call("POST", "/cash/images", { token: "jwt:" + OWNER, body: { event_ids: ["../x"] } })).status, 400);
  const ok = (await call("POST", "/cash/images", { token: "jwt:" + OWNER, body: { event_ids: [id.id] } })).body.items[id.id].raw;
  assert.equal((await fetch(ok.replace(/sig=[0-9a-f]+/, "sig=00"))).status, 403);
  assert.equal((await fetch(srv.base + "/storage/view/" + id.p)).status, 403); // unsigned
  now += 11 * 60e3;                                                        // 11 minutes later
  assert.equal((await fetch(ok)).status, 403);                             // link expired (10 min)
  now -= 11 * 60e3;
});

test("upload guards: wrong mime, tampered link, expired link", async () => {
  await call("POST", "/cash/events", { body: event("jet-0002") });
  const up = (await call("POST", "/cash/uploads", { body: { event_id: "jet-0002", kinds: ["raw"] } })).body.uploads.raw;
  assert.equal((await fetch(up.url, { method: "PUT", headers: { "content-type": "text/html" }, body: "<x>" })).status, 415);
  assert.equal((await fetch(up.url.replace(/sig=[0-9a-f]+/, "sig=00"), { method: "PUT", headers: { "content-type": "image/jpeg" }, body: JPEG })).status, 403);
  now += 3 * 3600e3;
  assert.equal((await fetch(up.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: JPEG })).status, 403);
  now -= 3 * 3600e3;
});

test("confirm before upload reports missing; after upload reports confirmed (retry-safe)", async () => {
  const before = await call("POST", "/cash/assets/confirm", { body: { event_id: "jet-0002", kinds: ["raw"] } });
  assert.deepEqual([before.body.ok, before.body.missing], [false, ["raw"]]);
  const up = (await call("POST", "/cash/uploads", { body: { event_id: "jet-0002", kinds: ["raw"] } })).body.uploads.raw;
  assert.equal((await fetch(up.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: JPEG })).status, 200);
  for (let i = 0; i < 2; i++) assert.equal((await call("POST", "/cash/assets/confirm", { body: { event_id: "jet-0002", kinds: ["raw"] } })).body.ok, true);
});

test("idempotent over HTTP: same batch twice -> one row each", async () => {
  const batch = { events: [event("dup-1"), event("dup-2")] };
  assert.equal((await call("POST", "/cash/events", { body: batch })).body.created, 2);
  const again = await call("POST", "/cash/events", { body: batch });
  assert.deepEqual([again.body.created, again.body.duplicate], [0, 2]);
  assert.equal(+(await pool.query("select count(*) c from cash_events where event_uid like 'dup-%'")).rows[0].c, 2);
});

test("backward compatible: legacy event (no boxes/confidence/track/snapshots) is accepted and viewable", async () => {
  const r = await call("POST", "/cash/events", { body: { event_id: "legacy-1", ts: Math.floor((now - 120e3) / 1000), type: "cash" } });
  assert.deepEqual([r.status, r.body.created], [200, 1]);
  const row = (await pool.query("select id, bbox, confidence, track_id, snapshot_raw_path, snapshot_annotated_path, detections from cash_events where event_uid='legacy-1'")).rows[0];
  assert.deepEqual([row.bbox, row.confidence, row.track_id, row.snapshot_raw_path, row.detections], [null, null, null, null, []]);
  const im = await call("POST", "/cash/images", { token: "jwt:" + OWNER, body: { event_ids: [row.id] } });
  assert.deepEqual(im.body.items[row.id], { raw: null, annotated: null, clip: null });
});

test("legacy single snapshot: kind 'snapshot' is stored as the annotated frame", async () => {
  await call("POST", "/cash/events", { body: event("legacy-2") });
  const up = await call("POST", "/cash/uploads", { body: { event_id: "legacy-2", kinds: ["snapshot"] } });
  assert.deepEqual(Object.keys(up.body.uploads), ["annotated"]);
  assert.equal((await fetch(up.body.uploads.annotated.url, { method: "PUT", headers: { "content-type": "image/jpeg" }, body: JPEG })).status, 200);
  assert.equal((await call("POST", "/cash/assets/confirm", { body: { event_id: "legacy-2", kinds: ["snapshot"] } })).body.ok, true);
  assert.ok((await pool.query("select snapshot_annotated_path p from cash_events where event_uid='legacy-2'")).rows[0].p.endsWith("/annotated.jpg"));
});

test("the app (authenticated role + RLS) sees only own events and can label them with the four labels", () => {
  const as = (uid, sql) => psql(DB, `set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false); ${sql}`);
  const mine = as(OWNER, "select count(*) from cash_events").out.split("\n").pop();
  assert.ok(+mine >= 5);
  assert.equal(as(OTHER, "select count(*) from cash_events").out.split("\n").pop(), "0");
  for (const l of ["confirmed_cash", "false_detection", "unsure", "other"]) assert.ok(as(OWNER, `update cash_events set label='${l}', label_note='n' where event_uid='dup-1'`).ok, l);
  assert.equal(as(OWNER, "update cash_events set label='correct_sale' where event_uid='dup-1'").ok, false);
});

test("revoked device is refused immediately", async () => {
  assert.equal((await call("POST", "/admin/devices/revoke", { token: "jwt:" + OWNER, body: { id: camId } })).body.ok, true);
  assert.equal((await call("GET", "/cash/ping")).status, 401);
});

test("secrets in an event never reach the database", async () => {
  const c = await call("POST", "/admin/devices", { token: "jwt:" + OWNER, body: { label: "j2", store_key: "mcc" } });
  const r = await call("POST", "/cash/events", { token: c.body.token, body: event("leak-1", { rtsp_url: "rtsp://admin:Hunter2@10.0.0.9/s", password: "Hunter2", note: "cam rtsp://u:p@1.2.3.4/x" }) });
  assert.equal(r.body.created, 1);
  const dump = psql(DB, "select raw::text from cash_events where event_uid='leak-1'").out;
  for (const bad of ["Hunter2", "rtsp://", "10.0.0.9", "1.2.3.4"]) assert.ok(!dump.includes(bad), bad);
});
