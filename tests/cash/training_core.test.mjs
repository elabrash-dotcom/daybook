import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildZip, crc32, exampleDir, slug, assembleExport, EXPORT_MAX_BYTES } from "../../supabase/functions/agent-gateway/cash_training_core.ts";
import { handleTrainingExport, handleTrainingReview, parseFilters } from "../../supabase/functions/agent-gateway/cash_training.ts";
import { cashGate } from "../../supabase/functions/agent-gateway/cash.ts";

const OWNER = "aaaaaaaa-0000-0000-0000-000000000001";
const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
const jpg = (n) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n, 0xff, 0xd9]);
const mk = (i, extra = {}) => ({ id: `0000000${i}-0000-0000-0000-000000000000`, event_id: `eeeeeee${i}-0000-0000-0000-000000000000`, event_uid: "evt-" + i, device_id: "dddddddd-0000-0000-0000-00000000000d",
  camera_label: "MCC Jetson D3", store_key: "mcc", class_name: "cash", detected_at: "2026-11-16T03:00:00.000Z", confidence: 0.8, model_version: "v3", reason: "glare",
  raw_path: `${OWNER}/mcc/d/evt-${i}/raw.jpg`, annotated_path: `${OWNER}/mcc/d/evt-${i}/annotated.jpg`, image_state: "ok", status: "collected", review_note: null,
  meta: { schema: "daybook.cash.false_detection/1", detection: { class: "cash", bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2, norm: true } } }, ...extra });
const unzip = (bytes) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-")); const f = path.join(dir, "x.zip"); fs.writeFileSync(f, bytes);
  const t = spawnSync("python3", ["-I", "-c", "import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);bad=z.testzip();print(json.dumps({'bad':bad,'names':z.namelist()}))", f], { encoding: "utf8" });
  assert.equal(t.status, 0, t.stderr); const info = JSON.parse(t.stdout); assert.equal(info.bad, null, "CRC check");
  const read = (n) => { const r = spawnSync("python3", ["-I", "-c", "import zipfile,sys,sys;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))", f, n]); assert.equal(r.status, 0, r.stderr?.toString()); return new Uint8Array(r.stdout); };
  return { names: info.names, read, text: (n) => new TextDecoder().decode(read(n)) };
};
const fakeStore = (rows, files = {}, opts = {}) => ({
  async list() { if (opts.listFails) throw new Error("db down"); return { rows, total: opts.total ?? rows.length }; },
  async currentPaths() { return opts.current ?? {}; }, async archives() { return opts.archives ?? []; },
  async download(p) { if (opts.fail?.has(p)) throw new Error("storage 500"); return files[p] ?? null; },
  async review(o, id, a, n) { opts.log?.push([o, id, a, n]); return { ok: true, id }; },
});
const get = (store, qs = "") => handleTrainingExport(new Request("http://x/cash/training/export" + qs), OWNER, store, reply, { "access-control-allow-origin": "*" });

test("crc32 matches the standard check value", () => { assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926); });

test("zip is valid for python's reader, with identical bytes, unicode names and empty files", () => {
  const z = buildZip([{ name: "a/ü-é.bin", data: new Uint8Array([1, 2, 3, 0, 255]) }, { name: "empty.txt", data: new Uint8Array() }, { name: "big.bin", data: new Uint8Array(300000).map((_, i) => i % 251) }]);
  const u = unzip(z); assert.deepEqual(u.names, ["a/ü-é.bin", "empty.txt", "big.bin"]);
  assert.deepEqual([...u.read("a/ü-é.bin")], [1, 2, 3, 0, 255]); assert.equal(u.read("empty.txt").length, 0); assert.equal(u.read("big.bin")[250000], 250000 % 251);
});

test("layout: camera / date / class, safe names", () => {
  assert.equal(exampleDir(mk(1)), "mcc-mcc-jetson-d3/2026-11-16/cash/evt-1-00000001");
  assert.equal(exampleDir(mk(2, { detected_at: "2026-11-16T14:30:00Z" })).split("/")[1], "2026-11-17", "dates are Sydney days");
  assert.ok(!/\.\./.test(exampleDir(mk(3, { event_uid: "../../etc/passwd", class_name: "a/b\\c", camera_label: "../x" }))));
  assert.equal(slug("   "), "unknown"); assert.equal(exampleDir(mk(4, { camera_label: null })).split("/")[0], "mcc-dddddddd");
});

test("full export: originals byte-identical, annotated, JSON, manifest, README, grouped by camera/date/class", async () => {
  const rows = [mk(1), mk(2, { class_name: "card", detected_at: "2026-11-15T03:00:00Z" })];
  const files = {}; for (const r of rows) { files[r.raw_path] = jpg(1); files[r.annotated_path] = jpg(2); }
  const res = await get(fakeStore(rows, files));
  assert.equal(res.status, 200); assert.equal(res.headers.get("content-type"), "application/zip");
  assert.match(res.headers.get("content-disposition"), /daybook-false-detections-\d{4}-\d{2}-\d{2}\.zip/);
  assert.deepEqual([res.headers.get("x-training-included"), res.headers.get("x-training-total"), res.headers.get("x-training-truncated")], ["2", "2", "false"]);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  const u = unzip(new Uint8Array(await res.arrayBuffer()));
  const d1 = "mcc-mcc-jetson-d3/2026-11-16/cash/evt-1-00000001", d2 = "mcc-mcc-jetson-d3/2026-11-15/card/evt-2-00000002";
  for (const n of ["README.md", "manifest.jsonl", `${d1}/raw.jpg`, `${d1}/annotated.jpg`, `${d1}/meta.json`, `${d2}/raw.jpg`, `${d2}/meta.json`]) assert.ok(u.names.includes(n), n);
  assert.deepEqual([...u.read(`${d1}/raw.jpg`)], [...jpg(1)]); assert.deepEqual([...u.read(`${d1}/annotated.jpg`)], [...jpg(2)]);
  const m = JSON.parse(u.text(`${d1}/meta.json`));
  assert.equal(m.schema, "daybook.cash.false_detection/1"); assert.deepEqual([m.export.files.raw, m.export.files.annotated, m.export.image_source, m.export.warnings], ["raw.jpg", "annotated.jpg", "original", []]);
  const lines = u.text("manifest.jsonl").trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2); assert.deepEqual([lines[0].raw, lines[0].annotated, lines[0].class, lines[0].reason], ["raw.jpg", "annotated.jpg", "cash", "glare"]);
  assert.match(u.text("README.md"), /false detection/i);
});

test("missing images: example and JSON are still exported with clear warnings", async () => {
  const rows = [mk(1), mk(2, { raw_path: null, annotated_path: null, image_state: "missing" })];
  const files = { [rows[0].raw_path]: jpg(1) };            // annotated of #1 is gone from storage; #2 was never uploaded
  const u = unzip(new Uint8Array(await (await get(fakeStore(rows, files))).arrayBuffer()));
  const m1 = JSON.parse(u.text("mcc-mcc-jetson-d3/2026-11-16/cash/evt-1-00000001/meta.json")), m2 = JSON.parse(u.text("mcc-mcc-jetson-d3/2026-11-16/cash/evt-2-00000002/meta.json"));
  assert.deepEqual([m1.export.files.raw, m1.export.files.annotated], ["raw.jpg", null]); assert.match(m1.export.warnings[0], /annotated frame was not found/);
  assert.deepEqual([m2.export.files.raw, m2.export.files.annotated], [null, null]); assert.match(m2.export.warnings.join(" "), /never uploaded/);
});

test("failed storage operations: that file is skipped with a warning, the export still completes", async () => {
  const rows = [mk(1), mk(2)]; const files = {}; for (const r of rows) { files[r.raw_path] = jpg(1); files[r.annotated_path] = jpg(2); }
  const res = await get(fakeStore(rows, files, { fail: new Set([rows[0].annotated_path]) }));
  assert.equal(res.status, 200); assert.equal(res.headers.get("x-training-missing-images"), "1");
  const u = unzip(new Uint8Array(await res.arrayBuffer()));
  assert.match(JSON.parse(u.text("mcc-mcc-jetson-d3/2026-11-16/cash/evt-1-00000001/meta.json")).export.warnings[0], /storage error: storage 500/);
  assert.ok(u.names.includes("mcc-mcc-jetson-d3/2026-11-16/cash/evt-2-00000002/annotated.jpg"));
  const all = await get(fakeStore(rows, files, { fail: new Set([...rows.map((r) => r.raw_path), ...rows.map((r) => r.annotated_path)]) }));
  assert.equal(all.status, 200, "even if every image fails, the metadata export succeeds"); assert.equal(all.headers.get("x-training-missing-images"), "4");
});

test("database failure and empty result are clean errors", async () => {
  assert.equal((await get(fakeStore([], {}, { listFails: true }))).status, 500);
  const empty = await get(fakeStore([])); assert.equal(empty.status, 404); assert.match((await empty.json()).error, /no examples/);
});

test("archived originals: the re-encoded WebP is used and labelled as such", async () => {
  const r = mk(1); const arch = `${OWNER}/archive/x.webp`;
  const res = await get(fakeStore([r], { [arch]: new Uint8Array([82, 73, 70, 70]) }, { current: { [r.event_id]: { raw: r.raw_path, annotated: r.annotated_path } }, archives: [{ event_id: r.event_id, kind: "raw", archive: arch, original_deleted: true }] }));
  const u = unzip(new Uint8Array(await res.arrayBuffer())); const d = "mcc-mcc-jetson-d3/2026-11-16/cash/evt-1-00000001";
  assert.ok(u.names.includes(`${d}/raw.webp`)); assert.ok(!u.names.includes(`${d}/raw.jpg`));
  assert.equal(JSON.parse(u.text(`${d}/meta.json`)).export.image_source, "archive");
});

test("a frame that arrived after the label is used (current event path beats the saved one)", async () => {
  const r = mk(1, { raw_path: null, annotated_path: null, image_state: "missing" }); const rp = `${OWNER}/mcc/late/raw.jpg`;
  const res = await get(fakeStore([r], { [rp]: jpg(9) }, { current: { [r.event_id]: { raw: rp, annotated: null } } }));
  const u = unzip(new Uint8Array(await res.arrayBuffer())); assert.deepEqual([...u.read("mcc-mcc-jetson-d3/2026-11-16/cash/evt-1-00000001/raw.jpg")], [...jpg(9)]);
});

test("never reads outside the owner's folder, even if a path was tampered with", async () => {
  const r = mk(1, { raw_path: "bbbbbbbb-0000-0000-0000-000000000002/mcc/x/raw.jpg", annotated_path: `${OWNER}/../bbbbbbbb/annotated.jpg` });
  const asked = []; const store = { ...fakeStore([r]), async download(p) { asked.push(p); return jpg(1); } };
  const res = await get(store); assert.equal(res.status, 200); assert.deepEqual(asked, []);
});

test("size cap: stops adding examples and says so", async () => {
  const big = new Uint8Array(9 * 1024 * 1024).fill(1); const rows = [1, 2, 3, 4, 5, 6].map((i) => mk(i)); const files = {};
  for (const r of rows) { files[r.raw_path] = big; files[r.annotated_path] = jpg(1); }
  const res = await get(fakeStore(rows, files));
  assert.equal(res.headers.get("x-training-truncated"), "true"); assert.ok(+res.headers.get("x-training-included") < 6);
  unzip(new Uint8Array(await res.arrayBuffer()));   // still a valid ZIP
});
test("an image over the per-file limit is skipped with a warning", async () => {
  const r = mk(1); const res = await get(fakeStore([r], { [r.raw_path]: new Uint8Array(11 * 1024 * 1024), [r.annotated_path]: jpg(1) }));
  const u = unzip(new Uint8Array(await res.arrayBuffer())); const m = JSON.parse(u.text("mcc-mcc-jetson-d3/2026-11-16/cash/evt-1-00000001/meta.json"));
  assert.equal(m.export.files.raw, null); assert.match(m.export.warnings[0], /too large/);
});
test("pagination: more matches than the page is reported as truncated", async () => {
  const res = await get(fakeStore([mk(1)], {}, { total: 5 })); assert.equal(res.headers.get("x-training-truncated"), "true"); assert.equal(res.headers.get("x-training-total"), "5");
});

test("filters are validated", () => {
  const f = (qs) => parseFilters(new URL("http://x/?" + qs));
  assert.deepEqual(f("").f.status, ["collected", "reviewed"]);
  for (const bad of ["status=bogus", "store=A%20B", "camera=nope", "from=zzz", "class=" + "x".repeat(65)]) assert.equal(f(bad).ok, false, bad);
  assert.equal(f("limit=99999").f.limit, 200); assert.equal(f("limit=0").f.limit, 100); assert.equal(f("offset=-4").f.offset, 0);
});

test("review endpoint validates input and maps outcomes", async () => {
  const log = []; const store = fakeStore([], {}, { log });
  const post = (b) => handleTrainingReview(new Request("http://x", { method: "POST", body: JSON.stringify(b) }), OWNER, store, reply);
  assert.equal((await post({ id: "nope", action: "reviewed" })).status, 400); assert.equal((await post({ id: mk(1).id, action: "delete" })).status, 400);
  assert.equal((await post({ id: mk(1).id, action: "excluded", note: "blurry" })).status, 200); assert.deepEqual(log[0], [OWNER, mk(1).id, "excluded", "blurry"]);
  const nf = { ...store, review: async () => ({ ok: false, error: "not found" }) }; assert.equal((await handleTrainingReview(new Request("http://x", { method: "POST", body: JSON.stringify({ id: mk(1).id, action: "reviewed" }) }), OWNER, nf, reply)).status, 404);
  const boom = { ...store, review: async () => { throw new Error("x"); } }; assert.equal((await handleTrainingReview(new Request("http://x", { method: "POST", body: JSON.stringify({ id: mk(1).id, action: "reviewed" }) }), OWNER, boom, reply)).status, 500);
});

test("permissions: training routes are Daybook-only (camera and other device tokens are refused)", () => {
  for (const p of ["/cash/training/export", "/cash/training/review"]) {
    assert.equal(cashGate({ isDevice: false }, p), null);
    assert.equal(cashGate({ isDevice: true, channel: "camera" }, p)?.status, 403); assert.equal(cashGate({ isDevice: true, channel: "glasses" }, p)?.status, 403);
  }
});
