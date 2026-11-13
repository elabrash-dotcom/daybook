import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleCash, handleDeviceAdmin, newDeviceToken } from "../../supabase/functions/agent-gateway/cash.ts";

const NOW = Date.parse("2026-11-13T05:00:00Z");
const who = { ownerId: "OWN", deviceId: "DEV", storeKey: "mcc" };
const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
const sha = async (s) => createHash("sha256").update(s).digest("hex");

function memStore(opts = {}) {
  const events = new Map(), objects = new Map(), devices = [];
  return {
    events, objects, devices, failInsertFor: new Set(), recent: opts.recent ?? 0,
    async recentEventCount() { return this.recent; },
    async insertEvent(row) {
      if (this.failInsertFor.has(row.event_uid)) throw new Error("db down");
      const k = row.device_id + "|" + row.event_uid;
      if (events.has(k)) return "duplicate";
      events.set(k, { id: "id-" + events.size, ...row }); return "created";
    },
    async findEvent(d, u) { const e = events.get(d + "|" + u); return e ? { id: e.id, owner_id: e.owner_id, store_key: e.store_key, detected_at: e.detected_at, event_uid: e.event_uid } : null; },
    async signedUpload(p) { return { url: "https://storage.example/upload/" + p + "?token=T", token: "T" }; },
    async objectSize(p) { return objects.has(p) ? objects.get(p) : null; },
    async setAssetPath(id, col, p) { for (const e of events.values()) if (e.id === id) e[col] = p; },
    async createDevice(d) { devices.push({ ...d, id: "dev-" + devices.length, revoked: false }); return { id: "dev-" + (devices.length - 1) }; },
    async listDevices(o) { return devices.filter((d) => d.ownerId === o).map(({ tokenHash, ...rest }) => rest); },
    async revokeDevice(o, id) { const d = devices.find((x) => x.id === id && x.ownerId === o && !x.revoked); if (d) d.revoked = true; return !!d; },
  };
}
const post = (path, body, store, w = who) =>
  handleCash(new Request("http://x" + path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), path, w, store, reply, NOW);
const jsonOf = async (r) => ({ status: r.status, ...(await r.json()) });
const ev = (id, extra = {}) => ({ event_id: id, timestamp: "2026-11-13T15:30:00+11:00", ...extra });

test("single event, array form and {events:[]} form are all accepted", async () => {
  const s = memStore();
  assert.equal((await jsonOf(await post("/cash/events", ev("a"), s))).created, 1);
  assert.equal((await jsonOf(await post("/cash/events", [ev("b"), ev("c")], s))).created, 2);
  assert.equal((await jsonOf(await post("/cash/events", { events: [ev("d")] }, s))).created, 1);
  assert.equal(s.events.size, 4);
});

test("idempotent: re-sending the same batch creates nothing and reports duplicates", async () => {
  const s = memStore();
  await post("/cash/events", { events: [ev("a"), ev("b")] }, s);
  const r = await jsonOf(await post("/cash/events", { events: [ev("a", { confidence: 0.1 }), ev("b"), ev("c")] }, s));
  assert.deepEqual([r.created, r.duplicate, r.rejected, r.status], [1, 2, 0, 200]);
  assert.equal(s.events.size, 3);
  assert.equal([...s.events.values()].find((e) => e.event_uid === "a").confidence, null); // first write kept
});

test("stored row: owner/device/store come from the token, not the payload", async () => {
  const s = memStore();
  await post("/cash/events", ev("a", { owner_id: "HACKER", device_id: "X", store_key: "other", store: "Fairfield", confidence: 91, bbox: { x1: 10, y1: 10, x2: 50, y2: 60 }, track_id: 5, width: 1280, height: 720 }), s);
  const row = [...s.events.values()][0];
  assert.equal(row.owner_id, "OWN"); assert.equal(row.device_id, "DEV"); assert.equal(row.store_key, "mcc");
  assert.equal(row.confidence, 0.91); assert.equal(row.track_id, "5"); assert.deepEqual(row.bbox, { x: 10, y: 10, w: 40, h: 50, norm: false });
  assert.equal(row.frame_width, 1280);
});

test("mixed batch: bad events rejected individually, good ones still saved", async () => {
  const s = memStore();
  const r = await jsonOf(await post("/cash/events", { events: [ev("ok1"), { timestamp: "2026-11-13T15:30:00+11:00" }, ev("bad id"), ev("ok2")] }, s));
  assert.deepEqual([r.created, r.rejected], [2, 2]);
  assert.equal(r.status, 200); // validation errors are final: no retry wanted
  assert.equal(r.results[1].status, "rejected");
});

test("database failure on one event: 207 + that event marked retryable, others saved", async () => {
  const s = memStore(); s.failInsertFor.add("b");
  const r = await jsonOf(await post("/cash/events", { events: [ev("a"), ev("b")] }, s));
  assert.equal(r.status, 207); assert.equal(r.ok, false); assert.equal(r.created, 1);
  assert.equal(r.results[1].error, "could not save, try again");
  s.failInsertFor.clear();
  const r2 = await jsonOf(await post("/cash/events", { events: [ev("a"), ev("b")] }, s));
  assert.deepEqual([r2.created, r2.duplicate, r2.status], [1, 1, 200]);
});

test("limits: >50 events, body >512 KB, bad JSON, empty, rate limit", async () => {
  const s = memStore();
  assert.equal((await post("/cash/events", { events: Array.from({ length: 51 }, (_, i) => ev("e" + i)) }, s)).status, 413);
  assert.equal((await post("/cash/events", "x".repeat(600 * 1024), s)).status, 413);
  assert.equal((await post("/cash/events", "{not json", s)).status, 400);
  assert.equal((await post("/cash/events", { events: [] }, s)).status, 400);
  assert.equal((await post("/cash/events", ev("z"), memStore({ recent: 600 }))).status, 429);
  assert.equal(s.events.size, 0);
});

test("ping returns server time (for clock-drift check) and the store", async () => {
  const r = await jsonOf(await handleCash(new Request("http://x/cash/ping"), "/cash/ping", who, memStore(), reply, NOW));
  assert.equal(r.server_time, "2026-11-13T05:00:00.000Z"); assert.equal(r.store_key, "mcc");
});

test("unknown /cash route -> 404; non-cash path -> null (falls through)", async () => {
  assert.equal((await post("/cash/nope", {}, memStore())).status, 404);
  assert.equal(await handleCash(new Request("http://x/feed"), "/feed", who, memStore(), reply, NOW), null);
});

test("uploads: signed URLs for raw + annotated + clip under owner/store/day/event", async () => {
  const s = memStore();
  await post("/cash/events", ev("e1"), s);
  const r = await jsonOf(await post("/cash/uploads", { event_id: "e1" }, s));
  assert.equal(r.status, 200);
  assert.equal(r.uploads.raw.path, "OWN/mcc/2026-11-13/e1/raw.jpg");
  assert.equal(r.uploads.annotated.content_type, "image/jpeg");
  assert.equal(r.uploads.clip.path, "OWN/mcc/2026-11-13/e1/clip.mp4");
  assert.ok(r.uploads.raw.url.startsWith("https://storage.example/upload/OWN/"));
  const one = await jsonOf(await post("/cash/uploads", { event_id: "e1", kinds: ["annotated"] }, s));
  assert.deepEqual(Object.keys(one.uploads), ["annotated"]);
});

test("uploads: unknown event, bad kind, another device's event all refused", async () => {
  const s = memStore();
  await post("/cash/events", ev("e1"), s);
  assert.equal((await post("/cash/uploads", { event_id: "nope" }, s)).status, 404);
  assert.equal((await post("/cash/uploads", { event_id: "e1", kinds: ["../../x"] }, s)).status, 400);
  assert.equal((await post("/cash/uploads", { event_id: "e1" }, s, { ...who, deviceId: "OTHER" })).status, 404);
});

test("confirm: only files that really exist are recorded; partial = not ok but safe to retry", async () => {
  const s = memStore();
  await post("/cash/events", ev("e1"), s);
  s.objects.set("OWN/mcc/2026-11-13/e1/annotated.jpg", 120_000);
  s.objects.set("OWN/mcc/2026-11-13/e1/clip.mp4", 99_000_000); // over the 10 MB cap -> not accepted
  const r = await jsonOf(await post("/cash/assets/confirm", { event_id: "e1" }, s));
  assert.deepEqual([r.confirmed, r.missing], [["annotated"], ["raw", "clip"]]);
  const row = [...s.events.values()][0];
  assert.equal(row.snapshot_annotated_path, "OWN/mcc/2026-11-13/e1/annotated.jpg"); assert.equal(row.snapshot_raw_path, undefined);
  s.objects.set("OWN/mcc/2026-11-13/e1/raw.jpg", 90_000);
  const r2 = await jsonOf(await post("/cash/assets/confirm", { event_id: "e1", kinds: ["raw"] }, s));
  assert.deepEqual(r2.confirmed, ["raw"]); assert.equal(r2.ok, true);
});

test("device admin: token shown once, only hash stored, list has no secrets, revoke works, bad input refused", async () => {
  const s = memStore();
  const call = (path, method, body) => handleDeviceAdmin(new Request("http://x" + path, { method, body: body ? JSON.stringify(body) : undefined }), path, "OWN", s, reply, sha);
  assert.equal((await call("/admin/devices", "POST", { label: "Jetson", store_key: "Bad Key" })).status, 400);
  assert.equal((await call("/admin/devices", "POST", { store_key: "mcc" })).status, 400);
  const c = await jsonOf(await call("/admin/devices", "POST", { label: "Jetson MCC", store_key: "MCC" }));
  assert.ok(c.token.startsWith("dvc_") && c.token.length > 40);
  assert.equal(s.devices[0].tokenHash, await sha(c.token)); assert.equal(s.devices[0].storeKey, "mcc");
  assert.ok(!JSON.stringify(s.devices).includes(c.token));
  const l = await jsonOf(await call("/admin/devices", "GET"));
  assert.ok(!JSON.stringify(l).includes(c.token) && !JSON.stringify(l).includes("tokenHash"));
  assert.equal((await jsonOf(await call("/admin/devices/revoke", "POST", { id: c.id }))).ok, true);
  assert.equal((await jsonOf(await call("/admin/devices/revoke", "POST", { id: c.id }))).ok, false);
  assert.equal(await call("/feed", "GET"), null);
});

test("device tokens are unique and unguessable-length", () => {
  const a = new Set(Array.from({ length: 200 }, newDeviceToken));
  assert.equal(a.size, 200); for (const t of a) assert.match(t, /^dvc_[A-Za-z0-9_-]{43}$/);
});
