// Cash Audit training data: HTTP handlers for reviewing and exporting false-detection examples (Daybook login only).
// Collection itself happens in the database (see 20261117_cash_training.sql); nothing here runs while a detection is being made.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { BUCKET } from "./cash_store.ts";
import { assembleExport, EXPORT_DEFAULT_LIMIT, EXPORT_MAX_LIMIT, MAX_IMAGE_BYTES, type Example, type FetchedFile } from "./cash_training_core.ts";

export type TrainingFilters = { status: string[]; store?: string; camera?: string; cls?: string; from?: string; to?: string; limit: number; offset: number };
export interface TrainingStore {
  list(ownerId: string, f: TrainingFilters): Promise<{ rows: Example[]; total: number }>;
  currentPaths(ownerId: string, eventIds: string[]): Promise<Record<string, { raw: string | null; annotated: string | null }>>;
  archives(ownerId: string, eventIds: string[]): Promise<{ event_id: string; kind: string; archive: string; original_deleted: boolean }[]>;
  download(path: string): Promise<Uint8Array | null>; // null: the file is not there. Throws on a storage failure.
  review(ownerId: string, id: string, action: string, note: string | null): Promise<Record<string, unknown>>;
}
type Reply = (body: unknown, status?: number) => Response;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["collected", "reviewed", "excluded", "withdrawn"];
const STORE_KEY = /^[a-z0-9_-]{1,40}$/;

export function parseFilters(url: URL): { ok: true; f: TrainingFilters } | { ok: false; error: string } {
  const p = url.searchParams;
  const status = (p.get("status") ?? "collected,reviewed").split(",").map((s) => s.trim()).filter(Boolean);
  if (!status.length || !status.every((s) => STATUSES.includes(s))) return { ok: false, error: "status must be a list of " + STATUSES.join(", ") };
  const store = p.get("store") || undefined, camera = p.get("camera") || undefined, cls = p.get("class") || undefined;
  if (store && !STORE_KEY.test(store)) return { ok: false, error: "bad store" };
  if (camera && !UUID.test(camera)) return { ok: false, error: "bad camera" };
  if (cls && cls.length > 64) return { ok: false, error: "bad class" };
  const from = p.get("from") || undefined, to = p.get("to") || undefined;
  for (const t of [from, to]) if (t && !Number.isFinite(Date.parse(t))) return { ok: false, error: "from and to must be dates" };
  const limit = Math.min(Math.max(parseInt(p.get("limit") ?? String(EXPORT_DEFAULT_LIMIT), 10) || EXPORT_DEFAULT_LIMIT, 1), EXPORT_MAX_LIMIT);
  const offset = Math.max(parseInt(p.get("offset") ?? "0", 10) || 0, 0);
  return { ok: true, f: { status, store, camera, cls, from, to, limit, offset } };
}

// GET /cash/training/export -> ZIP of originals, annotated images and JSON for the matching examples.
export async function handleTrainingExport(req: Request, ownerId: string, store: TrainingStore, reply: Reply, cors: Record<string, string> = {}): Promise<Response> {
  const parsed = parseFilters(new URL(req.url));
  if (!parsed.ok) return reply({ ok: false, error: parsed.error }, 400);
  const f = parsed.f;
  let rows: Example[], total: number;
  try { ({ rows, total } = await store.list(ownerId, f)); } catch (e) { console.error("training list failed", e instanceof Error ? e.message : e); return reply({ ok: false, error: "could not read the examples" }, 500); }
  if (!rows.length) return reply({ ok: false, error: "no examples match these filters" }, 404);

  const ids = rows.map((r) => r.event_id).filter((x): x is string => !!x);
  let current: Awaited<ReturnType<TrainingStore["currentPaths"]>> = {}, arch: Awaited<ReturnType<TrainingStore["archives"]>> = [];
  try { if (ids.length) [current, arch] = await Promise.all([store.currentPaths(ownerId, ids), store.archives(ownerId, ids)]); }
  catch (e) { console.error("training paths failed", e instanceof Error ? e.message : e); /* fall back to the paths saved on the examples */ }
  const archiveOf = (id: string | null, kind: string) => (id ? arch.find((a) => a.event_id === id && a.kind === kind && a.original_deleted)?.archive ?? null : null);
  const own = (p: string | null) => (p && p.startsWith(ownerId + "/") && !p.includes("..") ? p : null);   // never read outside this owner's folder

  const fetchFile = async (ex: Example, kind: "raw" | "annotated"): Promise<FetchedFile> => {
    const cur = ex.event_id ? current[ex.event_id] : undefined;
    const path = own((kind === "raw" ? cur?.raw : cur?.annotated) ?? (kind === "raw" ? ex.raw_path : ex.annotated_path));
    if (path) {
      const bytes = await store.download(path);                                  // may throw: the caller records the warning and continues
      if (bytes) return { bytes, source: "original" };
    }
    const a = own(archiveOf(ex.event_id, kind));
    if (a) { const bytes = await store.download(a); if (bytes) return { bytes, source: "archive", warning: undefined }; }
    return { bytes: null, source: null, warning: path || a ? `${kind} frame was not found in storage` : `${kind} frame was never uploaded` };
  };

  let out;
  try { out = await assembleExport(rows, total, { status: f.status.join(","), store: f.store ?? "", camera: f.camera ?? "", class: f.cls ?? "", from: f.from ?? "", to: f.to ?? "" }, { fetchFile }); }
  catch (e) { console.error("training export failed", e instanceof Error ? e.message : e); return reply({ ok: false, error: "could not build the export" }, 500); }
  const day = new Date().toISOString().slice(0, 10);
  return new Response(out.zip as unknown as BodyInit, { status: 200, headers: {
    ...cors, "content-type": "application/zip", "content-disposition": `attachment; filename="daybook-false-detections-${day}.zip"`,
    "x-training-included": String(out.included), "x-training-total": String(out.total), "x-training-truncated": String(out.truncated),
    "x-training-missing-images": String(out.imagesMissing), "access-control-expose-headers": "content-disposition, x-training-included, x-training-total, x-training-truncated, x-training-missing-images",
  } });
}

// POST /cash/training/review { id, action: reviewed | excluded | include, note? }
export async function handleTrainingReview(req: Request, ownerId: string, store: TrainingStore, reply: Reply): Promise<Response> {
  const b = await req.json().catch(() => null);
  const note = typeof b?.note === "string" ? b.note.trim().slice(0, 500) : null;
  if (!UUID.test(b?.id ?? "") || !["reviewed", "excluded", "include"].includes(b?.action)) return reply({ ok: false, error: "bad review request" }, 400);
  let r: Record<string, unknown>;
  try { r = await store.review(ownerId, b.id, b.action, note); } catch (e) { console.error("training review failed", e instanceof Error ? e.message : e); return reply({ ok: false, error: "review could not be saved" }, 500); }
  return reply(r, r.ok ? 200 : r.error === "not found" ? 404 : 409);
}

export function supabaseTrainingStore(sb: SupabaseClient): TrainingStore {
  return {
    async list(ownerId, f) {
      let q = sb.from("cash_training_examples").select("*", { count: "exact" }).eq("owner_id", ownerId).in("status", f.status).not("store_key", "ilike", "%fairfield%");
      if (f.store) q = q.eq("store_key", f.store);
      if (f.camera) q = q.eq("device_id", f.camera);
      if (f.cls) q = q.eq("class_name", f.cls);
      if (f.from) q = q.gte("detected_at", f.from);
      if (f.to) q = q.lt("detected_at", f.to);
      const { data, count, error } = await q.order("detected_at", { ascending: false }).range(f.offset, f.offset + f.limit - 1);
      if (error) throw error;
      return { rows: (data ?? []) as Example[], total: count ?? (data ?? []).length };
    },
    async currentPaths(ownerId, ids) {
      const { data, error } = await sb.from("cash_events").select("id, snapshot_raw_path, snapshot_annotated_path").eq("owner_id", ownerId).in("id", ids);
      if (error) throw error;
      return Object.fromEntries((data ?? []).map((r: { id: string; snapshot_raw_path: string | null; snapshot_annotated_path: string | null }) => [r.id, { raw: r.snapshot_raw_path, annotated: r.snapshot_annotated_path }]));
    },
    async archives(ownerId, ids) {
      const { data, error } = await sb.rpc("cash_training_assets", { p_owner: ownerId, p_event_ids: ids });
      if (error) throw error;
      return data ?? [];
    },
    async download(path) {
      const { data, error } = await sb.storage.from(BUCKET).download(path);
      if (error) {
        if (/not found|404|does not exist/i.test(error.message ?? "")) return null;
        throw new Error(error.message ?? "download failed");
      }
      if (!data || data.size > MAX_IMAGE_BYTES) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async review(ownerId, id, action, note) {
      const { data, error } = await sb.rpc("cash_training_review", { p_owner: ownerId, p_id: id, p_action: action, p_note: note });
      if (error) throw error;
      return data as Record<string, unknown>;
    },
  };
}
