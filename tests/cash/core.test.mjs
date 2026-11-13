import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent, parseTime, sanitizeRaw, sydneyDate, assetPath } from "../../supabase/functions/agent-gateway/cash_core.ts";

const NOW = Date.parse("2026-11-13T05:00:00Z"); // 4:00 pm Sydney (AEDT, +11)
const ok = (v) => { assert.ok(v.ok, v.error); return v.value; };

test("time: ISO with offset, Z, epoch s/ms, naive = Sydney", () => {
  assert.equal(parseTime("2026-11-13T15:30:00+11:00"), Date.parse("2026-11-13T04:30:00Z"));
  assert.equal(parseTime("2026-11-13T04:30:00Z"), Date.parse("2026-11-13T04:30:00Z"));
  assert.equal(parseTime(1794544200), 1794544200 * 1000);
  assert.equal(parseTime(1794544200123), 1794544200123);
  assert.equal(parseTime("2026-11-13 15:30:00"), Date.parse("2026-11-13T04:30:00Z"));      // summer, +11
  assert.equal(parseTime("2026-07-01 15:30:00"), Date.parse("2026-07-01T05:30:00Z"));      // winter, +10
  assert.equal(parseTime("2026-11-13T15:30:00.250"), Date.parse("2026-11-13T04:30:00.250Z"));
  assert.equal(parseTime("20261113_153000"), Date.parse("2026-11-13T04:30:00Z"));
  assert.equal(parseTime("garbage"), null);
  assert.equal(parseTime("2026-13-45 99:00:00"), null);
});

test("sydney business date crosses midnight correctly", () => {
  assert.equal(sydneyDate(Date.parse("2026-11-13T12:59:00Z")), "2026-11-13"); // 23:59 Sydney
  assert.equal(sydneyDate(Date.parse("2026-11-13T13:01:00Z")), "2026-11-14"); // 00:01 Sydney
});

test("minimal event", () => {
  const e = ok(normalizeEvent({ event_id: "ev_1", timestamp: "2026-11-13T15:30:00+11:00" }, { nowMs: NOW }));
  assert.equal(e.event_uid, "ev_1"); assert.equal(e.detected_at, "2026-11-13T04:30:00.000Z");
  assert.equal(e.bbox, null); assert.deepEqual(e.detections, []); assert.equal(e.confidence, null);
});

test("event id and field aliases", () => {
  const e = ok(normalizeEvent({ id: "abc-1", ts: 1794544200, event_type: "cash_handover", score: 87, trackId: 12, width: 1920, height: 1080 }, { nowMs: NOW }));
  assert.equal(e.event_uid, "abc-1"); assert.equal(e.kind, "cash_handover");
  assert.equal(e.confidence, 0.87); assert.equal(e.track_id, "12");
  assert.equal(e.frame_width, 1920); assert.equal(e.frame_height, 1080);
});

test("confidence: 0-1 kept, percent divided, impossible dropped", () => {
  const c = (v) => ok(normalizeEvent({ event_id: "e", ts: 1794544200, confidence: v }, { nowMs: NOW })).confidence;
  assert.equal(c(0.93), 0.93); assert.equal(c(93), 0.93); assert.equal(c("0.5"), 0.5); assert.equal(c(250), null); assert.equal(c(-1), null);
});

test("bounding boxes: xyxy object, xywh object, centre form, arrays, pixel vs normalised", () => {
  const b = (v, extra = {}) => ok(normalizeEvent({ event_id: "e", ts: 1794544200, width: 1920, height: 1080, ...extra, bbox: v }, { nowMs: NOW })).bbox;
  assert.deepEqual(b({ x1: 100, y1: 200, x2: 300, y2: 500 }), { x: 100, y: 200, w: 200, h: 300, norm: false });
  assert.deepEqual(b({ x: 10, y: 20, w: 30, h: 40 }), { x: 10, y: 20, w: 30, h: 40, norm: false });
  assert.deepEqual(b({ cx: 0.5, cy: 0.5, w: 0.2, h: 0.4 }), { x: 0.4, y: 0.3, w: 0.2, h: 0.4, norm: true });
  assert.deepEqual(b([100, 200, 300, 500]), { x: 100, y: 200, w: 200, h: 300, norm: false });
  assert.deepEqual(b({ left: 0.1, top: 0.1, right: 0.3, bottom: 0.5 }), { x: 0.1, y: 0.1, w: 0.2, h: 0.4, norm: true });
  assert.equal(b({ x1: 100, y1: 100, x2: 50, y2: 50 }), null);      // inverted
  assert.equal(b({ x: 5000, y: 0, w: 100, h: 100 }), null);         // outside 1920 frame
});

test("detections list: confidence + track per box, primary = most confident, capped at 50", () => {
  const e = ok(normalizeEvent({ event_id: "e", ts: 1794544200, detections: [
    { label: "cash", conf: 0.4, box: [0.1, 0.1, 0.2, 0.2], track_id: 3 },
    { label: "hand", conf: 0.9, bbox: { x1: 0.5, y1: 0.5, x2: 0.7, y2: 0.8 }, tid: "7" },
  ] }, { nowMs: NOW }));
  assert.equal(e.detections.length, 2);
  assert.equal(e.bbox.label, "hand"); assert.equal(e.confidence, 0.9); assert.equal(e.track_id, "7");
  const many = ok(normalizeEvent({ event_id: "e", ts: 1794544200, detections: Array.from({ length: 80 }, () => [0.1, 0.1, 0.2, 0.2]) }, { nowMs: NOW }));
  assert.equal(many.detections.length, 50); assert.ok(many.warnings.length);
});

test("rejects: no id, bad id, path-ish id, no time, too old, future", () => {
  const bad = (o) => normalizeEvent(o, { nowMs: NOW });
  assert.equal(bad({ ts: 1794544200 }).ok, false);
  assert.equal(bad({ event_id: "has space", ts: 1794544200 }).ok, false);
  assert.equal(bad({ event_id: "../../etc", ts: 1794544200 }).ok, false);
  assert.equal(bad({ event_id: "a..b", ts: 1794544200 }).ok, false);
  assert.equal(bad({ event_id: "x".repeat(129), ts: 1794544200 }).ok, false);
  assert.equal(bad({ event_id: "e" }).ok, false);
  assert.equal(bad({ event_id: "e", ts: "2026-09-01T00:00:00Z" }).ok, false);          // > 30 days
  assert.equal(bad({ event_id: "e", ts: "2026-11-13T06:00:00Z" }).ok, false);          // 1 h ahead
  assert.equal(bad("string").ok, false); assert.equal(bad(null).ok, false); assert.equal(bad([]).ok, false);
});

test("secrets never survive in raw: rtsp urls, passwords, tokens, url credentials, paths", () => {
  const e = ok(normalizeEvent({
    event_id: "e", ts: 1794544200,
    camera: { name: "till", rtsp_url: "rtsp://admin:Hunter2@192.168.1.20:554/stream1", password: "Hunter2" },
    api_key: "k", Authorization: "Bearer abc", note: "see rtsp://admin:Hunter2@10.0.0.5/live ok",
    url: "https://bob:pw@example.com/x", snapshot: "/mnt/cash-ssd/live-events/e/snap.jpg", nested: { deep: { token: "t", fine: 1 } },
  }, { nowMs: NOW }));
  const s = JSON.stringify(e.raw);
  for (const leak of ["Hunter2", "admin:", "192.168", "rtsp://", "Bearer", "bob:pw", "/mnt/cash-ssd", '"k"']) assert.ok(!s.includes(leak), "leaked " + leak + " in " + s);
  assert.equal(e.raw.camera.name, "till"); assert.equal(e.raw.snapshot, "snap.jpg"); assert.equal(e.raw.nested.deep.fine, 1);
  assert.ok(!("password" in e.raw.camera) && !("api_key" in e.raw));
});

test("oversized raw JSON is replaced, event still accepted", () => {
  const e = ok(normalizeEvent({ event_id: "e", ts: 1794544200, blob: "x".repeat(1900).repeat(60), more: Array.from({ length: 150 }, () => "y".repeat(1900)) }, { nowMs: NOW }));
  assert.equal(e.raw.truncated, true);
});

test("registered store beats claimed store (claim recorded only as a warning later)", () => {
  assert.equal(ok(normalizeEvent({ event_id: "e", ts: 1794544200, store: "Fairfield" }, { nowMs: NOW })).claimed_store, "Fairfield");
});

test("asset paths: owner/store/Sydney-date/event/kind.ext", () => {
  assert.equal(assetPath("OWN", "mcc", "2026-11-13T04:30:00.000Z", "ev_1", "raw"), "OWN/mcc/2026-11-13/ev_1/raw.jpg");
  assert.equal(assetPath("OWN", "mcc", "2026-11-13T13:30:00.000Z", "ev_1", "clip"), "OWN/mcc/2026-11-14/ev_1/clip.mp4");
});

test("sanitizeRaw depth limit", () => {
  let o = {}; let cur = o; for (let i = 0; i < 20; i++) { cur.n = {}; cur = cur.n; }
  assert.ok(JSON.stringify(sanitizeRaw(o)).length < 200);
});
