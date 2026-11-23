// Tests tools/export-false-detections.mjs against a local stand-in for Daybook (auth, events table, signed image links).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)), SCRIPT = path.join(here, "../../tools/export-false-detections.mjs");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const PASSWORD = "S3cret-pass-word!", OWNER = "owner-1";
const jpg = (seed, n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), createHash("sha256").update(seed).digest().subarray(0, 4), randomBytes(n), Buffer.from([0xff, 0xd9])]);

// 130 events labelled false (+ 4 Fairfield, + 6 with other labels that must never be exported)
const events = [], files = new Map(), calls = [];
for (let i = 0; i < 130; i++) {
  const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, uid = `evt-${i}`;
  const raw = `${OWNER}/mcc/2026-11-${14 + (i % 8)}/${uid}/raw.jpg`, ann = i % 13 === 5 ? null : `${OWNER}/mcc/2026-11-${14 + (i % 8)}/${uid}/annotated.jpg`;
  files.set(raw, jpg(raw, 20000 + i * 100)); if (ann) files.set(ann, jpg(ann, 30000 + i * 90));
  events.push({ id, owner_id: OWNER, device_id: "dddddddd-0000-0000-0000-00000000000d", store_key: "mcc", event_uid: uid, detected_at: new Date(Date.UTC(2026, 10, 14 + (i % 8), 3, i % 60, 5)).toISOString(), kind: "cash", confidence: 0.5 + (i % 40) / 100, track_id: String(i), bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.2, norm: true }, detections: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.2, norm: true, label: "cash" }], frame_width: 1920, frame_height: 1080, raw: { conf_threshold_used: 0.5, model_version: "yolo-v3" }, snapshot_raw_path: raw, snapshot_annotated_path: ann, label: "false_detection", label_note: i % 3 ? "receipt" : null, labelled_at: "2026-11-20T01:00:00Z", labelled_by: OWNER, match_status: "unmatched", matched_payment_id: null });
}
const MISSING_RAW = events[7].snapshot_raw_path, FLAKY_RAW = events[9].snapshot_raw_path;
const extra = [...Array(4)].map((_, i) => ({ ...events[0], id: `ffffffff-0000-4000-8000-00000000000${i}`, event_uid: `fair-${i}`, store_key: "mccfairfield" })).concat([...Array(6)].map((_, i) => ({ ...events[1], id: `eeeeeeee-0000-4000-8000-00000000000${i}`, event_uid: `other-${i}`, label: "confirmed_cash" })));
const table = [...events, ...extra];
let flakyHits = 0, server, base;

test.before(async () => {
  server = http.createServer(async (rq, rs) => {
    const u = new URL(rq.url, "http://x"); const chunks = []; for await (const c of rq) chunks.push(c); const body = Buffer.concat(chunks).toString();
    calls.push(rq.method + " " + u.pathname);
    const J = (o, s = 200) => { rs.writeHead(s, { "content-type": "application/json" }); rs.end(JSON.stringify(o)); };
    const authed = rq.headers.authorization === "Bearer tok-owner" && rq.headers.apikey;
    if (u.pathname === "/auth/v1/token") { const b = JSON.parse(body); return b.password === PASSWORD ? J({ access_token: "tok-owner" }) : J({ error_description: "Invalid login credentials" }, 400); }
    if (u.pathname.startsWith("/obj/")) {
      const p = decodeURIComponent(u.pathname.slice(5));
      if (p === MISSING_RAW) { rs.writeHead(404); return rs.end("{}"); }
      if (p === FLAKY_RAW && flakyHits++ < 1) { rs.writeHead(500); return rs.end("{}"); }
      const f = files.get(p); if (!f) { rs.writeHead(404); return rs.end(); } rs.writeHead(200, { "content-type": "image/jpeg" }); return rs.end(f);
    }
    if (!authed) return J({ error: "unauthorised" }, 401);
    if (u.pathname === "/rest/v1/cash_events" && rq.method === "GET") {
      let rows = table.slice(); const q = u.searchParams;
      if (q.get("label") === "eq.false_detection") rows = rows.filter((r) => r.label === "false_detection");
      if (q.get("store_key") === "not.ilike.*fairfield*") rows = rows.filter((r) => !/fairfield/i.test(r.store_key));
      rows.sort((a, b) => a.detected_at.localeCompare(b.detected_at) || a.id.localeCompare(b.id));
      const off = +q.get("offset") || 0, lim = Math.min(+q.get("limit") || 1000, 1000); return J(rows.slice(off, off + lim));
    }
    if (u.pathname.endsWith("/admin/devices")) return J({ ok: true, devices: [{ id: events[0].device_id, label: "MCC Jetson D3" }] });
    if (u.pathname.endsWith("/cash/images") && rq.method === "POST") {
      const ids = JSON.parse(body).event_ids; if (!Array.isArray(ids) || ids.length > 50) return J({ error: "event_ids must be 1-50 event uuids" }, 400);
      const items = {}; for (const id of ids) { const e = table.find((x) => x.id === id); if (e) items[id] = { raw: e.snapshot_raw_path && `${base}/obj/${encodeURIComponent(e.snapshot_raw_path)}`, annotated: e.snapshot_annotated_path && `${base}/obj/${encodeURIComponent(e.snapshot_annotated_path)}`, clip: null }; }
      return J({ ok: true, items });
    }
    J({ error: "not found" }, 404);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const run = (args = [], env = {}) => new Promise((res) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-")), out = []; const p = spawn("node", [SCRIPT, ...args], { cwd: dir, env: { ...process.env, DAYBOOK_URL: base, DAYBOOK_KEY: "pub", DAYBOOK_EMAIL: "o@x", DAYBOOK_PASSWORD: PASSWORD, EXPORT_PAGE: "50", EXPORT_BATCH: "20", ...env } });
  p.stdout.on("data", (d) => out.push(d)); p.stderr.on("data", (d) => out.push(d)); p.on("close", (code) => res({ code, out: Buffer.concat(out).toString(), dir }));
});
const py = (zip, code, ...a) => { const r = spawnSync("python3", ["-I", "-c", code, zip, ...a], { maxBuffer: 1 << 28 }); assert.equal(r.status, 0, r.stderr.toString()); return r.stdout; };

test("exports ALL false detections (130, past the page size of 50) as a valid ZIP with byte-identical images", async () => {
  calls.length = 0; flakyHits = 0;
  const r = await run(["--out", "out.zip"]); assert.equal(r.code, 0, r.out);
  const zip = path.join(r.dir, "out.zip"); assert.ok(fs.existsSync(zip)); assert.ok(!fs.existsSync(zip + ".part"));
  const info = JSON.parse(py(zip, "import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({'bad':z.testzip(),'names':z.namelist()}))"));
  assert.equal(info.bad, null, "every CRC checks out");
  const metas = info.names.filter((n) => n.endsWith("/meta.json")); assert.equal(metas.length, 130, "all 130, none of the Fairfield or other-label rows");
  assert.ok(info.names.every((n) => !/fair-|other-/.test(n)));
  const read = (n) => py(zip, "import zipfile,sys;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))", n);
  const dirOf = (uid) => metas.find((m) => m.includes(`/${uid}-`)).replace("/meta.json", "");
  for (const i of [0, 1, 6, 8, 50, 129]) {                                    // original and annotated bytes are exactly what was stored
    const e = events[i]; assert.equal(sha(read(dirOf(e.event_uid) + "/raw.jpg")), sha(files.get(e.snapshot_raw_path)), "raw " + i);
    if (e.snapshot_annotated_path) assert.equal(sha(read(dirOf(e.event_uid) + "/annotated.jpg")), sha(files.get(e.snapshot_annotated_path)), "annotated " + i);
  }
  const m = JSON.parse(read(dirOf("evt-0") + "/meta.json"));
  assert.deepEqual([m.detection.event_uid, m.detection.confidence, m.detection.class, m.camera.label, m.camera.store_key, m.feedback.label, m.model.version, m.detection.frame.width], ["evt-0", 0.5, "cash", "MCC Jetson D3", "mcc", "false_detection", "yolo-v3", 1920]);
  assert.deepEqual(m.detection.bbox, { x: 0.1, y: 0.2, w: 0.3, h: 0.2, norm: true }); assert.ok(m.detection.detected_at && m.feedback.labelled_at);
  assert.match(dirOf("evt-0"), /^mcc-mcc-jetson-d3\/2026-11-1\d\/cash\/evt-0-/);
  const lines = read("manifest.jsonl").toString().trim().split("\n"); assert.equal(lines.length, 130);
  const csv = read("manifest.csv").toString(); assert.equal(csv.trim().split("\n").length, 131); assert.match(csv, /^﻿event_uid,event_id,detected_at,store,camera_id,camera,class,confidence/);
  assert.match(read("README.md").toString(), /originals exactly as stored/);
});

test("missing and flaky files: retried once, 404 reported, export still completes and lists what is missing", async () => {
  flakyHits = 0; const r = await run(["--out", "o2.zip"]); assert.equal(r.code, 0, r.out);
  const zip = path.join(r.dir, "o2.zip"); const names = JSON.parse(py(zip, "import zipfile,sys,json;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))"));
  assert.ok(names.some((n) => n.includes("/evt-9-") && n.endsWith("raw.jpg")), "the flaky file was retried and saved");
  assert.ok(!names.some((n) => n.includes("/evt-7-") && n.endsWith("raw.jpg")), "the 404 file is absent");
  const rep = py(zip, "import zipfile,sys;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read('export-report.txt'))").toString();
  assert.match(rep, /evt-7: raw frame: file not found in storage/); assert.match(rep, /evt-5: annotated frame was never uploaded/); assert.match(r.out, /had a missing frame/);
});

test("read-only: only GET requests to the data, and POST only for sign-in and signed image links", async () => {
  calls.length = 0; await run(["--out", "o3.zip"]);
  const bad = calls.filter((c) => !/^GET \/(rest\/v1\/cash_events|functions\/v1\/agent-gateway\/admin\/devices|obj\/)|^POST \/(auth\/v1\/token|functions\/v1\/agent-gateway\/cash\/images)$/.test(c.replace(/(\/obj\/).*/, "$1")));
  assert.deepEqual(bad, []); assert.ok(!calls.some((c) => /^(PATCH|PUT|DELETE)/.test(c)));
});

test("dry run counts and downloads nothing; --limit exports just that many", async () => {
  const d = await run(["--dry-run"]); assert.equal(d.code, 0); assert.match(d.out, /Found 130 false detections/); assert.deepEqual(fs.readdirSync(d.dir), []);
  const l = await run(["--limit", "5", "--out", "five.zip"]); assert.equal(l.code, 0); assert.match(l.out, /Found 5 false detections/);
  assert.equal(JSON.parse(py(path.join(l.dir, "five.zip"), "import zipfile,sys,json;print(json.dumps([n for n in zipfile.ZipFile(sys.argv[1]).namelist() if n.endswith('meta.json')]))")).length, 5);
});

test("wrong password stops cleanly; the password is never printed", async () => {
  const r = await run(["--out", "x.zip"], { DAYBOOK_PASSWORD: "wrong-pass" }); assert.equal(r.code, 1); assert.match(r.out, /Sign-in failed: Invalid login credentials/); assert.ok(!r.out.includes("wrong-pass")); assert.deepEqual(fs.readdirSync(r.dir), []);
  const ok = await run(["--out", "y.zip"]); assert.ok(!ok.out.includes(PASSWORD));
});
