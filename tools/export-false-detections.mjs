#!/usr/bin/env node
// Export every Cash Audit detection marked "False Detection" into one ZIP: original frame, annotated frame and details.
//
// READ-ONLY. It signs in with your Daybook login, reads your own events, and downloads the images through the short-lived
// signed links the Daybook gateway already issues. It never changes, moves or deletes anything. Needs Node 22 or newer, no installs.
//
//   node export-false-detections.mjs                 asks for your Daybook email and password
//   node export-false-detections.mjs --dry-run       only counts what would be exported
//   node export-false-detections.mjs --limit 5       trial run with the first 5 detections
//   node export-false-detections.mjs --out my.zip    choose the file name
//   (or set DAYBOOK_EMAIL and DAYBOOK_PASSWORD instead of being asked)
//
// Images are saved byte-for-byte as stored: no resizing, no re-compression.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const BASE = (process.env.DAYBOOK_URL || "https://scjfvvwylrgpbrmdsjxb.supabase.co").replace(/\/+$/, "");
const KEY = process.env.DAYBOOK_KEY || "sb_publishable_-BRGJ7waDQ_POQOQXhF0Wg_UU6zonmg"; // the public key already inside the Daybook app
const GW = BASE + "/functions/v1/agent-gateway";
const PAGE = +process.env.EXPORT_PAGE || 500;          // rows per request (the database caps a request at 1000)
const BATCH = +process.env.EXPORT_BATCH || 20;         // events per signed-link request (the gateway allows 50)
const MAX_ZIP = 3.8 * 1024 ** 3;                       // this simple ZIP format stops at 4 GB

const args = process.argv.slice(2);
const flag = (n) => args.includes(n), opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const DRY = flag("--dry-run"), LIMIT = opt("--limit") ? +opt("--limit") : Infinity;
const stamp = new Date().toISOString().slice(0, 10);
const OUT = path.resolve(opt("--out") || `daybook-false-detections-${stamp}.zip`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => process.stdout.write(m + "\n");

async function ask(question, hidden) {
  if (hidden && process.stdin.isTTY) {                                  // type-in without showing the password
    process.stdout.write(question);
    return await new Promise((res) => {
      const si = process.stdin; let s = ""; si.setRawMode(true); si.resume(); si.setEncoding("utf8");
      const on = (chunk) => {
        for (const c of chunk) {
          if (c === "\r" || c === "\n" || c === "\u0004") { si.setRawMode(false); si.pause(); si.removeListener("data", on); process.stdout.write("\n"); return res(s.trim()); }
          if (c === "\u0003") { process.stdout.write("\n"); process.exit(130); }
          if (c === "\u007f" || c === "\b") s = s.slice(0, -1); else s += c;
        }
      };
      si.on("data", on);
    });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(question, res));
  rl.close(); return answer.trim();
}

async function http(method, url, { token, body, raw } = {}) {
  const headers = { apikey: KEY, ...(token ? { authorization: "Bearer " + token } : {}), ...(body ? { "content-type": "application/json" } : {}) };
  const r = await fetch(url, { method, headers: raw ? {} : headers, body: body ? JSON.stringify(body) : undefined });
  return r;
}
async function json(r) { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } }

// ---- ZIP writer: each file is written with its real size and CRC (opens in every ZIP tool), directory at the end ------------

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

class ZipFile {
  constructor(file) { this.fd = fs.openSync(file, "w"); this.offset = 0; this.entries = []; const d = new Date(); this.t = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1); this.d = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(); }
  add(name, data) {
    if (this.offset + data.length > MAX_ZIP) throw new Error("the ZIP would pass 4 GB: export in parts with --limit");
    const nm = Buffer.from(name, "utf8"), crc = crc32(data), h = Buffer.alloc(30 + nm.length);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8); h.writeUInt16LE(this.t, 10); h.writeUInt16LE(this.d, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26); nm.copy(h, 30);
    fs.writeSync(this.fd, h); fs.writeSync(this.fd, data);
    this.entries.push({ nm, crc, size: data.length, offset: this.offset }); this.offset += h.length + data.length;
  }
  finish() {
    const start = this.offset; let size = 0;
    for (const e of this.entries) {
      const c = Buffer.alloc(46 + e.nm.length);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10); c.writeUInt16LE(this.t, 12); c.writeUInt16LE(this.d, 14);
      c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.size, 20); c.writeUInt32LE(e.size, 24); c.writeUInt16LE(e.nm.length, 28); c.writeUInt32LE(e.offset, 42); e.nm.copy(c, 46);
      fs.writeSync(this.fd, c); size += c.length;
    }
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(start, 16);
    fs.writeSync(this.fd, end); fs.closeSync(this.fd);
  }
}

// ---- helpers ----------------------------------------------------------------------------------------------------------------

const slug = (s, f = "unknown") => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || f;
const sydDay = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const csv = (v) => { const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const isJpeg = (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8;

async function main() {
  say("Daybook false-detection export (read-only)\n");
  const email = process.env.DAYBOOK_EMAIL || (await ask("Daybook email: "));
  const password = process.env.DAYBOOK_PASSWORD || (await ask("Daybook password (not shown): ", true));
  const login = await http("POST", BASE + "/auth/v1/token?grant_type=password", { body: { email, password } });
  const lj = await json(login);
  if (!login.ok || !lj.access_token) throw new Error("Sign-in failed: " + (lj.error_description || lj.msg || login.status));
  const token = lj.access_token; say("Signed in.");

  // 1. all false-labelled events (paged, so nothing is capped at 100 or 1000)
  const events = [];
  for (let offset = 0; events.length < LIMIT; offset += PAGE) {
    const url = `${BASE}/rest/v1/cash_events?select=*&label=eq.false_detection&store_key=not.ilike.*fairfield*&order=detected_at.asc,id.asc&limit=${PAGE}&offset=${offset}`;
    const r = await http("GET", url, { token }); const rows = await json(r);
    if (!r.ok) throw new Error("Could not read the events: " + (rows.message || r.status));
    events.push(...rows); if (rows.length < PAGE) break;
  }
  if (events.length > LIMIT) events.length = LIMIT;
  const withRaw = events.filter((e) => e.snapshot_raw_path).length, withAnn = events.filter((e) => e.snapshot_annotated_path).length;
  say(`Found ${events.length} false detections (${withRaw} with an original frame, ${withAnn} with an annotated frame).`);
  if (DRY) { say("Dry run: nothing downloaded."); return; }
  if (!events.length) { say("Nothing to export."); return; }

  // 2. camera names (nice to have; falls back to the camera id)
  const cams = {};
  try { const r = await http("GET", GW + "/admin/devices", { token }); const j = await json(r); for (const d of j.devices || []) cams[d.id] = d.label; } catch { /* optional */ }

  // 3. download and write
  const tmp = OUT + ".part"; fs.rmSync(tmp, { force: true });
  const zip = new ZipFile(tmp), enc = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o, null, 2), "utf8");
  const manifest = [], report = [], used = new Set(); let done = 0, fetched = 0, missing = 0, bytes = 0;

  const links = async (ids) => {
    for (let a = 1; a <= 3; a++) {
      try { const r = await http("POST", GW + "/cash/images", { token, body: { event_ids: ids } }); const j = await json(r); if (r.ok && j.items) return j.items; } catch { /* retry */ }
      await sleep(500 * a);
    }
    return {};
  };
  const download = async (url) => {
    for (let a = 1; a <= 3; a++) {
      try { const r = await fetch(url); if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length > 0) return { bytes: b }; } else if (r.status === 404) return { error: "file not found in storage" }; } catch { /* retry */ }
      await sleep(400 * a);
    }
    return { error: "download failed after 3 tries" };
  };

  for (let i = 0; i < events.length; i += BATCH) {
    const group = events.slice(i, i + BATCH);
    const items = await links(group.map((e) => e.id));
    for (const ev of group) {
      const cam = cams[ev.device_id] || ev.device_id.slice(0, 8);
      let dir = `${slug(ev.store_key)}-${slug(cam, "camera")}/${sydDay(ev.detected_at)}/${slug(ev.kind, "unknown")}/${slug(ev.event_uid, "event").slice(0, 40)}-${ev.id.slice(0, 8)}`;
      while (used.has(dir)) dir += "x"; used.add(dir);
      const files = { raw: null, annotated: null }, warnings = [], got = items[ev.id] || {};
      for (const kind of ["raw", "annotated"]) {
        const stored = kind === "raw" ? ev.snapshot_raw_path : ev.snapshot_annotated_path;
        if (!stored) { warnings.push(`${kind} frame was never uploaded`); continue; }
        if (!got[kind]) { warnings.push(`${kind} frame: no download link available`); continue; }
        const d = await download(got[kind]);
        if (d.bytes && isJpeg(d.bytes)) { zip.add(`${dir}/${kind}.jpg`, d.bytes); files[kind] = `${kind}.jpg`; fetched++; bytes += d.bytes.length; }
        else warnings.push(`${kind} frame: ${d.error || "the file is not a JPEG image"}`);
      }
      missing += warnings.length;
      const meta = {
        schema: "daybook.cash.false_detection/1",
        detection: { event_id: ev.id, event_uid: ev.event_uid, detected_at: ev.detected_at, class: ev.kind ?? "unknown", confidence: ev.confidence, track_id: ev.track_id, bbox: ev.bbox, detections: ev.detections, frame: { width: ev.frame_width, height: ev.frame_height }, conf_threshold: ev.raw?.conf_threshold_used ?? null },
        camera: { device_id: ev.device_id, label: cams[ev.device_id] ?? null, store_key: ev.store_key },
        model: { version: ev.raw?.model_version ?? ev.raw?.model ?? ev.raw?.model_name ?? ev.raw?.weights ?? null },
        feedback: { label: ev.label, note: ev.label_note, labelled_at: ev.labelled_at, labelled_by: ev.labelled_by },
        pos_match: { status: ev.match_status, payment_id: ev.matched_payment_id },
        images: { raw_path: ev.snapshot_raw_path, annotated_path: ev.snapshot_annotated_path, files, warnings },
        source_event: ev.raw,
      };
      zip.add(`${dir}/meta.json`, enc(meta));
      manifest.push({ event_uid: ev.event_uid, event_id: ev.id, detected_at: ev.detected_at, store: ev.store_key, camera_id: ev.device_id, camera: cams[ev.device_id] ?? "", class: ev.kind ?? "", confidence: ev.confidence, track_id: ev.track_id, bbox: ev.bbox, label: ev.label, note: ev.label_note, labelled_at: ev.labelled_at, raw: files.raw ? `${dir}/${files.raw}` : "", annotated: files.annotated ? `${dir}/${files.annotated}` : "", warnings: warnings.join("; ") });
      if (warnings.length) report.push(`${ev.event_uid}: ${warnings.join("; ")}`);
      done++; if (done % 10 === 0 || done === events.length) process.stdout.write(`\r  ${done}/${events.length} detections, ${fetched} images, ${(bytes / 1048576).toFixed(0)} MB   `);
    }
  }
  process.stdout.write("\n");

  const cols = ["event_uid", "event_id", "detected_at", "store", "camera_id", "camera", "class", "confidence", "track_id", "bbox", "label", "note", "labelled_at", "raw", "annotated", "warnings"];
  zip.add("manifest.jsonl", enc(manifest.map((m) => JSON.stringify(m)).join("\n") + "\n"));
  zip.add("manifest.csv", enc("﻿" + cols.join(",") + "\n" + manifest.map((m) => cols.map((c) => csv(m[c])).join(",")).join("\n") + "\n"));
  zip.add("README.md", enc(`# Daybook false detections (exported ${stamp})

${events.length} detections marked "False Detection". Images are the originals exactly as stored (no resizing or re-compression).

    <store>-<camera>/<YYYY-MM-DD (Sydney)>/<class>/<event>-<id>/
        raw.jpg        original frame from the camera
        annotated.jpg  the same frame with the camera's boxes drawn on it
        meta.json      time, camera, class, confidence, boxes, label, note, model version if known

manifest.csv opens in Excel; manifest.jsonl is the same data for scripts. Boxes are normalised 0-1 when "norm" is true, otherwise pixels.
${report.length ? "\nSome frames could not be included (see export-report.txt)." : ""}
`));
  if (report.length) zip.add("export-report.txt", enc(report.join("\n") + "\n"));
  zip.finish(); fs.renameSync(tmp, OUT);

  say(`\nDone. ${events.length} detections, ${fetched} images (${(bytes / 1048576).toFixed(0)} MB).`);
  say(`File: ${OUT}`);
  if (report.length) say(`\n${report.length} detection(s) had a missing frame, listed in export-report.txt inside the ZIP.`);
}

main().catch((e) => { console.error("\nStopped: " + (e && e.message ? e.message : e)); process.exit(1); });
