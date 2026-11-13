// Cash Audit end-to-end test against a DEVELOPMENT Supabase project, using synthetic events and images only.
// Zero dependencies (Node 22+). It refuses to run against the production project.
//
//   DEV_URL=https://<ref>.supabase.co DEV_ANON_KEY=... DEV_EMAIL=... DEV_PASSWORD=... node tests/cash-dev/e2e.mjs
//   optional: DEV_EMAIL2 / DEV_PASSWORD2 (a second user, to prove owner isolation), DEV_STORE (default dev-test)
const URL_ = (process.env.DEV_URL || "").replace(/\/+$/, "");
const ANON = process.env.DEV_ANON_KEY || "";
const STORE = process.env.DEV_STORE || "dev-test";
const RUN = "e2e-" + Date.now().toString(36);
if (!/^https?:\/\//.test(URL_) || !ANON || !process.env.DEV_EMAIL || !process.env.DEV_PASSWORD) { console.error("Set DEV_URL, DEV_ANON_KEY, DEV_EMAIL, DEV_PASSWORD"); process.exit(2); }
if (/scjfvvwylrgpbrmdsjxb/.test(URL_)) { console.error("REFUSING TO RUN: that is the PRODUCTION project."); process.exit(2); }
const GW = URL_ + "/functions/v1/agent-gateway";

// Two different synthetic 1x1 JPEGs (no real camera images) and a tiny fake clip.
const JPG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
const RAW = Buffer.concat([JPG, Buffer.from("synthetic-raw-" + RUN)]);
const ANN = Buffer.concat([JPG, Buffer.from("synthetic-annotated-" + RUN)]);
const CLIP = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(40, 1)]);

let pass = 0, fail = 0; const failures = [];
const check = (cond, name, extra = "") => { if (cond) { pass++; console.log("  ok  ", name); } else { fail++; failures.push(name); console.log("  FAIL", name, extra); } };
const step = async (name, fn) => { console.log("\n" + name); try { await fn(); } catch (e) { fail++; failures.push(name + ": " + e.message); console.log("  FAIL", name, "threw:", e.message); } };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const gw = async (method, path, token, body) => { const r = await fetch(GW + path, { method, headers: { ...(token ? { authorization: "Bearer " + token } : {}), "content-type": "application/json", apikey: ANON }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }); return { status: r.status, body: await j(r) }; };
const rest = async (method, path, token, body, prefer) => { const r = await fetch(URL_ + "/rest/v1/" + path, { method, headers: { apikey: ANON, authorization: "Bearer " + token, "content-type": "application/json", ...(prefer ? { prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await j(r) }; };
const signIn = async (email, password) => { const r = await fetch(URL_ + "/auth/v1/token?grant_type=password", { method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify({ email, password }) }); const b = await j(r); if (!r.ok || !b.access_token) throw new Error("sign-in failed: " + (b.error_description || b.msg || r.status)); return { token: b.access_token, id: b.user.id }; };
const sydneyOffsetIso = (ms) => new Date(ms).toISOString();
const ev = (n, extra = {}) => ({ event_id: `${RUN}-${n}`, detected_at: sydneyOffsetIso(Date.now() - 30e3 * (5 - n)), event_type: "cash_handover", confidence: 0.8 + n / 100, track_id: 10 + n, frame_width: 1920, frame_height: 1080,
  detections: [{ label: "cash", confidence: 0.8 + n / 100, track_id: 10 + n, bbox: { x1: 800 + n, y1: 400, x2: 1000 + n, y2: 560 } }], ...extra });
const tamper = (u) => u.replace(/([?&](?:token|sig)=)([^&]+)/, (_, a, b) => a + b.slice(0, -2) + (b.endsWith("aa") ? "bb" : "aa"));

let owner, other, cam, camId;

await step("1. sign in as the dev owner", async () => {
  owner = await signIn(process.env.DEV_EMAIL, process.env.DEV_PASSWORD); check(!!owner.token, "got a Daybook-style user token");
  if (process.env.DEV_EMAIL2) other = await signIn(process.env.DEV_EMAIL2, process.env.DEV_PASSWORD2);
});
await step("2. register the test store and camera device (via the gateway admin route)", async () => {
  const r = await gw("POST", "/admin/devices", owner.token, { label: "dev-e2e " + RUN, store_key: STORE });
  check(r.status === 200 && /^dvc_/.test(r.body.token || ""), "device created, token returned once", JSON.stringify(r.body));
  cam = r.body.token; camId = r.body.id;
  const bad = await gw("POST", "/admin/devices", owner.token, { label: "x", store_key: "Bad Key!" }); check(bad.status === 400, "invalid store key refused");
  const l = await gw("GET", "/admin/devices", owner.token); check(l.status === 200 && !JSON.stringify(l.body).includes(cam), "device list never contains the token");
});
await step("3. ping and clock", async () => {
  const r = await gw("GET", "/cash/ping", cam); check(r.status === 200 && r.body.store_key === STORE, "ping returns the registered store");
  check(Math.abs(Date.parse(r.body.server_time) - Date.now()) < 120e3, "server and runner clocks agree within 2 minutes");
});
await step("4. authentication boundaries", async () => {
  check((await gw("GET", "/cash/ping", null)).status === 401, "no token -> 401");
  check((await gw("GET", "/cash/ping", "dvc_notarealtoken")).status === 401, "unknown device token -> 401");
  check((await gw("POST", "/cash/events", owner.token, ev(1))).status === 403, "a Daybook user token cannot use the device route (403)");
  for (const p of ["/feed", "/message", "/status", "/admin/devices"]) check((await gw("GET", p, cam)).status === 403, "camera token refused on " + p);
  check((await gw("GET", "/cash/images", cam)).status === 403, "camera token refused on /cash/images");
});
await step("5. event ingestion (synthetic events, one carrying fake secrets)", async () => {
  const r = await gw("POST", "/cash/events", cam, { events: [ev(1), ev(2, { rtsp_url: "rtsp://admin:Hunter2@10.9.9.9/stream", password: "Hunter2" }), ev(3)] });
  check(r.status === 200 && r.body.created === 3 && r.body.duplicate === 0, "3 events created", JSON.stringify(r.body));
  const rows = await rest("GET", `cash_events?select=*&event_uid=like.${RUN}-*&order=event_uid`, owner.token);
  check(rows.status === 200 && rows.body.length === 3, "owner reads the 3 rows through RLS", JSON.stringify(rows.body).slice(0, 200));
  const e2 = (rows.body || []).find((x) => x.event_uid === RUN + "-2");
  check(e2 && e2.store_key === STORE && e2.confidence === 0.82 && e2.track_id === "12", "store, confidence and track id stored");
  check(e2 && e2.bbox && e2.bbox.x === 802 && e2.bbox.w === 200 && e2.bbox.norm === false && e2.frame_width === 1920, "bounding box stored in pixels with frame size");
  check(e2 && !JSON.stringify(e2).includes("Hunter2") && !JSON.stringify(e2).includes("rtsp://") && !JSON.stringify(e2).includes("10.9.9.9"), "secrets never reached the database");
});
await step("6. duplicate protection and validation", async () => {
  const d = await gw("POST", "/cash/events", cam, { events: [ev(1, { confidence: 0.1 }), ev(2), ev(3)] });
  check(d.status === 200 && d.body.created === 0 && d.body.duplicate === 3, "re-sending the batch -> 3 duplicates, 0 created", JSON.stringify(d.body));
  const rows = await rest("GET", `cash_events?select=event_uid,confidence&event_uid=like.${RUN}-*`, owner.token);
  check(rows.body.length === 3 && rows.body.find((x) => x.event_uid === RUN + "-1").confidence === 0.81, "still 3 rows; first write kept");
  const m = await gw("POST", "/cash/events", cam, { events: [ev(4), { detected_at: new Date().toISOString() }, ev(5, { event_id: "bad id!" })] });
  check(m.status === 200 && m.body.created === 1 && m.body.rejected === 2, "mixed batch: 1 saved, 2 rejected individually", JSON.stringify(m.body));
  check((await gw("POST", "/cash/events", cam, { events: Array.from({ length: 51 }, (_, i) => ev(100 + i)) })).status === 413, "51 events -> 413");
  check((await gw("POST", "/cash/events", cam, "not json")).status === 400, "bad JSON -> 400");
});
let urls;
await step("7. signed uploads (synthetic images only)", async () => {
  check((await gw("POST", "/cash/uploads", cam, { event_id: "does-not-exist" })).status === 404, "upload links for an unknown event -> 404");
  const r = await gw("POST", "/cash/uploads", cam, { event_id: RUN + "-1", kinds: ["raw", "annotated", "clip"] });
  check(r.status === 200 && r.body.uploads.raw && r.body.uploads.annotated && r.body.uploads.clip, "signed upload links issued", JSON.stringify(r.body).slice(0, 200));
  urls = r.body.uploads;
  check(urls.raw.path.startsWith(owner.id + "/" + STORE + "/"), "storage path is owner/store/…");
  const bad = await fetch(tamper(urls.raw.url), { method: "PUT", headers: { "content-type": "image/jpeg" }, body: RAW }); check(bad.status >= 400, "tampered upload link refused (" + bad.status + ")");
  const wrong = await fetch(urls.raw.url, { method: "PUT", headers: { "content-type": "text/html" }, body: "<b>x</b>" }); check(wrong.status >= 400, "wrong content type refused (" + wrong.status + ")");
  for (const [k, buf, ct] of [["raw", RAW, "image/jpeg"], ["annotated", ANN, "image/jpeg"], ["clip", CLIP, "video/mp4"]]) {
    const p = await fetch(urls[k].url, { method: "PUT", headers: { "content-type": ct }, body: buf }); check(p.status === 200, `PUT ${k} -> 200`, p.status + " " + await p.text());
  }
});
await step("8. confirm", async () => {
  const r = await gw("POST", "/cash/assets/confirm", cam, { event_id: RUN + "-1", kinds: ["raw", "annotated", "clip"] });
  check(r.status === 200 && r.body.ok === true && r.body.confirmed.length === 3, "all three files confirmed", JSON.stringify(r.body));
  const again = await gw("POST", "/cash/assets/confirm", cam, { event_id: RUN + "-1" }); check(again.body.ok === true, "confirm is repeatable");
  const miss = await gw("POST", "/cash/assets/confirm", cam, { event_id: RUN + "-3", kinds: ["raw"] }); check(miss.body.ok === false && miss.body.missing[0] === "raw", "event with no upload reports missing");
});
let evId;
await step("9. private image viewing", async () => {
  const row = (await rest("GET", `cash_events?select=id,snapshot_raw_path,snapshot_annotated_path,clip_path&event_uid=eq.${RUN}-1`, owner.token)).body[0];
  evId = row.id; check(!!row.snapshot_raw_path && !!row.snapshot_annotated_path, "paths recorded on the event");
  const im = await gw("POST", "/cash/images", owner.token, { event_ids: [evId] });
  check(im.status === 200 && im.body.items[evId].raw && im.body.items[evId].annotated, "owner receives signed view links");
  const raw = Buffer.from(await (await fetch(im.body.items[evId].raw)).arrayBuffer()), ann = Buffer.from(await (await fetch(im.body.items[evId].annotated)).arrayBuffer());
  check(raw.equals(RAW) && ann.equals(ANN), "raw and annotated bytes round-trip exactly and are different files");
  check((await fetch(tamper(im.body.items[evId].raw))).status >= 400, "tampered view link refused");
  check((await fetch(im.body.items[evId].raw.split("?")[0])).status >= 400, "view link without its token refused");
  const pub = await fetch(`${URL_}/storage/v1/object/public/cash-snapshots/${row.snapshot_raw_path}`); check(pub.status !== 200, "bucket is not public (" + pub.status + ")");
  const auth = await fetch(`${URL_}/storage/v1/object/authenticated/cash-snapshots/${row.snapshot_raw_path}`, { headers: { apikey: ANON, authorization: "Bearer " + owner.token } }); check(auth.status !== 200, "even the owner cannot read storage directly (links only) (" + auth.status + ")");
  const list = await fetch(`${URL_}/storage/v1/object/list/cash-snapshots`, { method: "POST", headers: { apikey: ANON, authorization: "Bearer " + ANON, "content-type": "application/json" }, body: JSON.stringify({ prefix: "", limit: 5 }) }); const lb = await j(list);
  check(!(Array.isArray(lb) && lb.length), "anonymous listing of the bucket shows nothing");
  check((await gw("POST", "/cash/images", cam, { event_ids: [evId] })).status === 403, "camera token cannot request view links");
  check((await gw("POST", "/cash/images", null, { event_ids: [evId] })).status === 401, "no token cannot request view links");
  const none = await gw("POST", "/cash/images", owner.token, { event_ids: ["00000000-0000-4000-8000-000000000000"] }); check(Object.keys(none.body.items).length === 0, "unknown event returns no links");
});
await step("10. row-level security and review labels", async () => {
  const anonRows = await rest("GET", "cash_events?select=id", ANON); check(anonRows.status >= 400 || (Array.isArray(anonRows.body) && anonRows.body.length === 0), "anonymous cannot read events (" + anonRows.status + ")");
  for (const l of ["confirmed_cash", "false_detection", "unsure", "other"]) {
    const r = await rest("PATCH", `cash_events?id=eq.${evId}`, owner.token, { label: l, label_note: "e2e " + l }, "return=representation");
    check(r.status === 200 && r.body[0] && r.body[0].label === l && r.body[0].labelled_by === owner.id && !!r.body[0].labelled_at, `owner sets label ${l} (stamped by trigger)`, JSON.stringify(r.body).slice(0, 160));
  }
  check((await rest("PATCH", `cash_events?id=eq.${evId}`, owner.token, { label: "correct_sale" })).status >= 400, "unknown label refused");
  for (const body of [{ confidence: 0.01 }, { detected_at: new Date().toISOString() }, { snapshot_raw_path: "x" }, { match_status: "matched" }, { owner_id: owner.id }]) check((await rest("PATCH", `cash_events?id=eq.${evId}`, owner.token, body)).status >= 400, "cannot edit " + Object.keys(body)[0]);
  check((await rest("DELETE", `cash_events?id=eq.${evId}`, owner.token)).status >= 400 || (await rest("GET", `cash_events?select=id&id=eq.${evId}`, owner.token)).body.length === 1, "cannot delete an event");
  const ins = await rest("POST", "cash_events", owner.token, { owner_id: owner.id, event_uid: "x", detected_at: new Date().toISOString(), device_id: camId, store_key: STORE }); check(ins.status >= 400, "cannot insert an event from the app");
  const pos = await rest("GET", "cash_pos_payments?select=id", owner.token); check(pos.status === 200 && pos.body.length === 0, "cash_pos_payments readable (empty) by owner");
});
await step("11. second user isolation", async () => {
  if (!other) { console.log("  (skipped: set DEV_EMAIL2/DEV_PASSWORD2 to run)"); return; }
  const rows = await rest("GET", `cash_events?select=id&event_uid=like.${RUN}-*`, other.token); check(rows.status === 200 && rows.body.length === 0, "other user sees none of the owner's events");
  const up = await rest("PATCH", `cash_events?id=eq.${evId}`, other.token, { label: "unsure" }, "return=representation"); check(up.status >= 400 || (Array.isArray(up.body) && up.body.length === 0), "other user cannot label them");
  const im = await gw("POST", "/cash/images", other.token, { event_ids: [evId] }); check(im.status === 200 && Object.keys(im.body.items).length === 0, "other user gets no image links");
});
await step("12. revoke", async () => {
  const r = await gw("POST", "/admin/devices/revoke", owner.token, { id: camId }); check(r.status === 200 && r.body.ok === true, "device revoked");
  check((await gw("GET", "/cash/ping", cam)).status === 401, "revoked token refused immediately");
});

console.log(`\n${pass} passed, ${fail} failed`); if (fail) { console.log("Failures:\n - " + failures.join("\n - ")); process.exit(1); }
