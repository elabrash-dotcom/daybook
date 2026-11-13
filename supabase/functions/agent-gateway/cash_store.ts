// Cash Audit: Supabase implementation of CashStore (service role). Not exercised by the local Postgres tests;
// needs a smoke test on a development Supabase project before production.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { CashStore } from "./cash.ts";

export const BUCKET = "cash-snapshots";

export function supabaseCashStore(sb: SupabaseClient): CashStore {
  return {
    async recentEventCount(deviceId, sinceIso) {
      const { count, error } = await sb.from("cash_events").select("id", { count: "exact", head: true })
        .eq("device_id", deviceId).gte("received_at", sinceIso);
      if (error) throw error;
      return count ?? 0;
    },
    async insertEvent(row) {
      // ON CONFLICT DO NOTHING on (device_id, event_uid): a retry never creates a second row or overwrites the first.
      const { data, error } = await sb.from("cash_events")
        .upsert(row, { onConflict: "device_id,event_uid", ignoreDuplicates: true }).select("id");
      if (error) throw error;
      return data && data.length ? "created" : "duplicate";
    },
    async findEvent(deviceId, eventUid) {
      const { data, error } = await sb.from("cash_events").select("id, owner_id, store_key, detected_at, event_uid")
        .eq("device_id", deviceId).eq("event_uid", eventUid).maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
    async signedUpload(path) {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
      if (error || !data) throw error ?? new Error("no signed url");
      return { url: data.signedUrl, token: data.token };
    },
    async objectSize(path) {
      const i = path.lastIndexOf("/");
      const { data, error } = await sb.storage.from(BUCKET).list(path.slice(0, i), { search: path.slice(i + 1), limit: 5 });
      if (error) throw error;
      const f = (data ?? []).find((x) => x.name === path.slice(i + 1));
      const size = f?.metadata?.size;
      return typeof size === "number" ? size : null;
    },
    async signedView(path, seconds) {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, seconds);
      return error || !data ? null : data.signedUrl;
    },
    async ownedEventPaths(ownerId, ids) {
      const { data, error } = await sb.from("cash_events").select("id, snapshot_raw_path, snapshot_annotated_path, clip_path")
        .eq("owner_id", ownerId).in("id", ids);
      if (error) throw error;
      return data ?? [];
    },
    async setAssetPath(eventId, column, path) {
      const { error } = await sb.from("cash_events").update({ [column]: path, assets_confirmed_at: new Date().toISOString() }).eq("id", eventId);
      if (error) throw error;
    },
    async createDevice(d) {
      const { data, error } = await sb.from("agent_devices")
        .insert({ owner_id: d.ownerId, label: d.label, channel: "camera", store_key: d.storeKey, token_hash: d.tokenHash })
        .select("id").single();
      if (error) throw error;
      return { id: data.id };
    },
    async listDevices(ownerId) {
      const { data, error } = await sb.from("agent_devices")
        .select("id, label, channel, store_key, last_seen_at, revoked_at, created_at").eq("owner_id", ownerId).order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    async revokeDevice(ownerId, id) {
      const { data, error } = await sb.from("agent_devices").update({ revoked_at: new Date().toISOString() })
        .eq("owner_id", ownerId).eq("id", id).is("revoked_at", null).select("id");
      if (error) throw error;
      return !!data?.length;
    },
  };
}
