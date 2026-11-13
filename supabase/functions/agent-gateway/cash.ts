// Cash Audit: HTTP handlers for the camera device (Jetson) and device admin (Daybook).
// All storage and database access goes through CashStore, so the logic is testable without Supabase.
import {
  ASSET_INFO, ASSET_KINDS, type AssetKind, MAX_BATCH, MAX_BODY_BYTES, STORE_KEY_RE, assetPath, normalizeEvent, type NormalEvent,
} from "./cash_core.ts";

export type CameraCaller = { ownerId: string; deviceId: string; storeKey: string };

export type EventRow = NormalEvent & { owner_id: string; device_id: string; store_key: string };
export type StoredEvent = { id: string; owner_id: string; store_key: string; detected_at: string; event_uid: string };

export interface CashStore {
  recentEventCount(deviceId: string, sinceIso: string): Promise<number>;
  insertEvent(row: Record<string, unknown>): Promise<"created" | "duplicate">;
  findEvent(deviceId: string, eventUid: string): Promise<StoredEvent | null>;
  signedUpload(path: string): Promise<{ url: string; token: string }>;
  objectSize(path: string): Promise<number | null>;
  signedView(path: string, seconds: number): Promise<string | null>;
  ownedEventPaths(ownerId: string, ids: string[]): Promise<{ id: string; snapshot_raw_path: string | null; snapshot_annotated_path: string | null; clip_path: string | null }[]>;
  setAssetPath(eventId: string, column: string, path: string): Promise<void>;
  createDevice(d: { ownerId: string; label: string; storeKey: string; tokenHash: string }): Promise<{ id: string }>;
  listDevices(ownerId: string): Promise<Record<string, unknown>[]>;
  revokeDevice(ownerId: string, id: string): Promise<boolean>;
}

type Reply = (body: unknown, status?: number) => Response;

const RATE_PER_MINUTE = 600;

async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; res: { error: string; status: number } }> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, res: { error: "body too large (max 512 KB)", status: 413 } };
  try { return { ok: true, body: JSON.parse(text) }; } catch (_) { return { ok: false, res: { error: "body must be JSON", status: 400 } }; }
}

// POST /cash/events  { events: [...] }  or a single event object.
async function postEvents(req: Request, who: CameraCaller, store: CashStore, reply: Reply, nowMs: number) {
  const r = await readJson(req);
  if (!r.ok) return reply({ ok: false, error: r.res.error }, r.res.status);
  const b = r.body as Record<string, unknown> | unknown[];
  const items: unknown[] = Array.isArray(b) ? b : Array.isArray((b as any)?.events) ? (b as any).events : [b];
  if (!items.length) return reply({ ok: false, error: "no events" }, 400);
  if (items.length > MAX_BATCH) return reply({ ok: false, error: `max ${MAX_BATCH} events per request` }, 413);

  const recent = await store.recentEventCount(who.deviceId, new Date(nowMs - 60e3).toISOString());
  if (recent + items.length > RATE_PER_MINUTE) return reply({ ok: false, error: "too many events, slow down" }, 429);

  const results: Record<string, unknown>[] = [];
  let created = 0, duplicate = 0, rejected = 0;
  for (const item of items) {
    const n = normalizeEvent(item, { nowMs });
    if (!n.ok) {
      rejected++;
      const id = item && typeof item === "object" ? String((item as any).event_id ?? (item as any).id ?? "").slice(0, 128) : "";
      results.push({ event_id: id || null, status: "rejected", error: n.error });
      continue;
    }
    const e = n.value;
    const { claimed_store, warnings, ...cols } = e;
    const row = { ...cols, owner_id: who.ownerId, device_id: who.deviceId, store_key: who.storeKey };
    // The registered store wins. A different claimed store is kept in raw only.
    if (claimed_store && claimed_store.toLowerCase().replace(/[^a-z0-9]/g, "") !== who.storeKey.replace(/[^a-z0-9]/g, "")) {
      warnings.push(`event claims store "${claimed_store}", stored under device store "${who.storeKey}"`);
    }
    try {
      const status = await store.insertEvent(row);
      if (status === "created") created++; else duplicate++;
      results.push({ event_id: e.event_uid, status, ...(warnings.length ? { warnings } : {}) });
    } catch (err) {
      console.error("cash insert failed", err instanceof Error ? err.message : err);
      rejected++;
      results.push({ event_id: e.event_uid, status: "rejected", error: "could not save, try again" });
    }
  }
  // 207 when mixed so a device can tell it must retry the failures; every created/duplicate id is safe to forget.
  const retry = results.some((x) => x.status === "rejected" && x.error === "could not save, try again");
  return reply({ ok: !retry, created, duplicate, rejected, results }, retry ? 207 : 200);
}

function parseKinds(v: unknown): AssetKind[] | null {
  const arr = Array.isArray(v) ? v : ["raw", "annotated", "clip"];
  const out: AssetKind[] = [];
  for (const raw of arr) {
    const k = raw === "snapshot" ? "annotated" : raw; // legacy single snapshot = the annotated frame
    if (!ASSET_KINDS.includes(k as AssetKind)) return null;
    if (!out.includes(k as AssetKind)) out.push(k as AssetKind);
  }
  return out.length ? out : null;
}

async function loadEvent(body: any, who: CameraCaller, store: CashStore) {
  const uid = typeof body?.event_id === "string" ? body.event_id : "";
  if (!uid) return null;
  return await store.findEvent(who.deviceId, uid);
}

// POST /cash/uploads { event_id, kinds? } -> short-lived signed upload URLs for the event's files.
async function postUploads(req: Request, who: CameraCaller, store: CashStore, reply: Reply) {
  const r = await readJson(req);
  if (!r.ok) return reply({ ok: false, error: r.res.error }, r.res.status);
  const kinds = parseKinds((r.body as any)?.kinds);
  if (!kinds) return reply({ ok: false, error: "kinds must be a list of raw, annotated, clip" }, 400);
  const ev = await loadEvent(r.body, who, store);
  if (!ev) return reply({ ok: false, error: "unknown event_id: send the event first" }, 404);
  const uploads: Record<string, unknown> = {};
  for (const k of kinds) {
    const path = assetPath(ev.owner_id, ev.store_key, ev.detected_at, ev.event_uid, k);
    const s = await store.signedUpload(path);
    uploads[k] = { method: "PUT", url: s.url, content_type: ASSET_INFO[k].mime, max_bytes: ASSET_INFO[k].maxBytes, path };
  }
  return reply({ ok: true, event_id: ev.event_uid, expires_in_seconds: 7200, uploads });
}

// POST /cash/assets/confirm { event_id, kinds? } -> checks the files really arrived, then records their paths.
async function postConfirm(req: Request, who: CameraCaller, store: CashStore, reply: Reply) {
  const r = await readJson(req);
  if (!r.ok) return reply({ ok: false, error: r.res.error }, r.res.status);
  const kinds = parseKinds((r.body as any)?.kinds);
  if (!kinds) return reply({ ok: false, error: "kinds must be a list of raw, annotated, clip" }, 400);
  const ev = await loadEvent(r.body, who, store);
  if (!ev) return reply({ ok: false, error: "unknown event_id" }, 404);
  const confirmed: string[] = [], missing: string[] = [];
  for (const k of kinds) {
    const path = assetPath(ev.owner_id, ev.store_key, ev.detected_at, ev.event_uid, k);
    const size = await store.objectSize(path);
    if (size !== null && size > 0 && size <= ASSET_INFO[k].maxBytes) { await store.setAssetPath(ev.id, ASSET_INFO[k].column, path); confirmed.push(k); }
    else missing.push(k);
  }
  return reply({ ok: missing.length === 0, event_id: ev.event_uid, confirmed, missing }, 200);
}

// Decides who may call what. Camera devices: /cash/* only. Everyone else: no /cash device routes.
// Returns null when the request may continue, otherwise the refusal.
export function cashGate(who: { channel?: string; isDevice: boolean }, path: string): { status: number; error: string } | null {
  if (who.channel === "camera") return path.startsWith("/cash/") && path !== "/cash/images" ? null : { status: 403, error: "camera devices can only use /cash" };
  if (path.startsWith("/cash/") && path !== "/cash/images") return { status: 403, error: "camera devices only" };
  if (path === "/cash/images" && who.isDevice) return { status: 403, error: "Daybook only" };
  return null;
}

// POST /cash/images { event_ids: [uuid...] } (Daybook login only) -> short-lived signed view links for the review screen.
// Only the caller's own events are returned. Links expire in 10 minutes. Bucket stays private.
export async function handleImages(req: Request, ownerId: string, store: CashStore, reply: Reply): Promise<Response> {
  const r = await readJson(req);
  if (!r.ok) return reply({ ok: false, error: r.res.error }, r.res.status);
  const ids = (r.body as any)?.event_ids;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!Array.isArray(ids) || !ids.length || ids.length > 50 || !ids.every((x) => typeof x === "string" && UUID.test(x))) {
    return reply({ ok: false, error: "event_ids must be 1-50 event uuids" }, 400);
  }
  const rows = await store.ownedEventPaths(ownerId, ids);
  const items: Record<string, unknown> = {};
  for (const row of rows) {
    const one = async (p: string | null) => (p && p.startsWith(ownerId + "/") ? await store.signedView(p, 600) : null);
    items[row.id] = { raw: await one(row.snapshot_raw_path), annotated: await one(row.snapshot_annotated_path), clip: await one(row.clip_path) };
  }
  return reply({ ok: true, expires_in_seconds: 600, items });
}

// Camera device routes. Returns null if the path is not a /cash route.
export async function handleCash(
  req: Request, path: string, who: CameraCaller, store: CashStore, reply: Reply, nowMs = Date.now(),
): Promise<Response | null> {
  if (path === "/cash/ping" && req.method === "GET") {
    return reply({ ok: true, server_time: new Date(nowMs).toISOString(), store_key: who.storeKey });
  }
  if (path === "/cash/events" && req.method === "POST") return await postEvents(req, who, store, reply, nowMs);
  if (path === "/cash/uploads" && req.method === "POST") return await postUploads(req, who, store, reply);
  if (path === "/cash/assets/confirm" && req.method === "POST") return await postConfirm(req, who, store, reply);
  if (path.startsWith("/cash/")) return reply({ error: "not found" }, 404);
  return null;
}

// ---- device admin (Daybook user only) ------------------------------------------------------------------------------

export const newDeviceToken = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return "dvc_" + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// POST /admin/devices {label, store_key}  -> creates a camera device, returns its token ONCE.
// POST /admin/devices/revoke {id}
// GET  /admin/devices                      -> list (never includes tokens).
export async function handleDeviceAdmin(
  req: Request, path: string, ownerId: string, store: CashStore, reply: Reply, sha256hex: (s: string) => Promise<string>,
): Promise<Response | null> {
  if (path === "/admin/devices" && req.method === "GET") return reply({ ok: true, devices: await store.listDevices(ownerId) });
  if (path === "/admin/devices" && req.method === "POST") {
    const r = await readJson(req);
    if (!r.ok) return reply({ ok: false, error: r.res.error }, r.res.status);
    const b = r.body as any;
    const label = typeof b?.label === "string" ? b.label.trim().slice(0, 80) : "";
    const storeKey = typeof b?.store_key === "string" ? b.store_key.trim().toLowerCase() : "";
    if (!label) return reply({ ok: false, error: "label required" }, 400);
    if (!STORE_KEY_RE.test(storeKey)) return reply({ ok: false, error: "store_key must be lowercase letters, digits, - or _ (max 40)" }, 400);
    const token = newDeviceToken();
    const d = await store.createDevice({ ownerId, label, storeKey, tokenHash: await sha256hex(token) });
    return reply({ ok: true, id: d.id, token, note: "Copy this token now. It cannot be shown again." });
  }
  if (path === "/admin/devices/revoke" && req.method === "POST") {
    const r = await readJson(req);
    if (!r.ok) return reply({ ok: false, error: r.res.error }, r.res.status);
    const id = (r.body as any)?.id;
    if (typeof id !== "string") return reply({ ok: false, error: "id required" }, 400);
    return reply({ ok: await store.revokeDevice(ownerId, id) });
  }
  return null;
}
