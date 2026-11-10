import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as webpush from "jsr:@negrel/webpush@0.3";

// Daybook push notifications.
//  GET                      -> { publicKey }
//  POST {action:"due"}      header x-cron-key  -> sends reminders that are due (pg_cron, every minute)
//  POST {action:"later"}    header x-cron-key  -> Monday ~8am Sydney: "N things in Later" (pg_cron, hourly Sun/Mon UTC)
//  POST {action:"card", card_id}  header x-cron-key -> a new agent card (DB trigger on agent_cards insert)
//  POST {action:"test"}     header Authorization: Bearer <user token> -> test push

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-cron-key, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const b64u = (buf: Uint8Array) => btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function secret(k: string) {
  const { data } = await sb.from("app_secrets").select("v").eq("k", k).maybeSingle();
  return data?.v as string | undefined;
}

// deno-lint-ignore no-explicit-any
let server: any = null;
let publicKeyB64 = "";
async function getServer() {
  if (server) return server;
  let stored = await secret("vapid_jwk");
  if (!stored) {
    const keys = await webpush.generateVapidKeys({ extractable: true });
    const exported = await webpush.exportVapidKeys(keys);
    const { error } = await sb.from("app_secrets").insert({ k: "vapid_jwk", v: JSON.stringify(exported) });
    stored = error ? await secret("vapid_jwk") : JSON.stringify(exported);
  }
  const exported = JSON.parse(stored!);
  const pub = exported.publicKey as JsonWebKey;
  publicKeyB64 = b64u(new Uint8Array([4, ...fromB64u(pub.x!), ...fromB64u(pub.y!)]));
  const vapidKeys = await webpush.importVapidKeys(exported, { extractable: false });
  server = await webpush.ApplicationServer.new({ contactInformation: "mailto:daybook@example.com", vapidKeys });
  return server;
}

type Sub = { id: string; endpoint: string; p256dh: string; auth: string; fails: number };
async function sendAll(payload: Record<string, unknown>) {
  const srv = await getServer();
  const { data: subs } = await sb.from("push_subs").select("id,endpoint,p256dh,auth,fails");
  let ok = 0, failed = 0;
  for (const s of (subs || []) as Sub[]) {
    try {
      const subscriber = srv.subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
      await subscriber.pushTextMessage(JSON.stringify(payload), { ttl: 3600, urgency: "high", topic: String(payload.tag || "daybook").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) });
      ok++;
      await sb.from("push_subs").update({ last_ok: Date.now(), fails: 0 }).eq("id", s.id);
    } catch (e) {
      failed++;
      // deno-lint-ignore no-explicit-any
      const gone = typeof (e as any)?.isGone === "function" ? (e as any).isGone() : /\b(404|410)\b/.test(String(e));
      if (gone || s.fails >= 20) await sb.from("push_subs").delete().eq("id", s.id);
      else await sb.from("push_subs").update({ fails: (s.fails || 0) + 1 }).eq("id", s.id);
      console.error("push failed", s.id, String(e).slice(0, 200));
    }
  }
  return { ok, failed };
}

async function sendDue() {
  const now = Date.now();
  const { data: due } = await sb.from("tasks")
    .update({ reminded_at: now })
    .is("reminded_at", null).eq("done", false)
    .lte("remind_at", now + 30000).gte("remind_at", now - 6 * 3600e3)
    .select("id,title,note,person_ids,person_id,time");
  if (!due || !due.length) return { sent: 0 };
  const { data: people } = await sb.from("people").select("id,name");
  const nameOf = (id: string) => (people || []).find((p) => p.id === id)?.name ?? "";
  let sent = 0;
  for (const t of due) {
    const ids: string[] = t.person_ids?.length ? t.person_ids : t.person_id ? [t.person_id] : [];
    const who = ids.filter((i) => i !== "me").map(nameOf).filter(Boolean).join(", ");
    const body = [t.time ? `Due ${t.time}` : "Due now", who ? `for ${who}` : "", t.note ? `· ${String(t.note).slice(0, 120)}` : ""].filter(Boolean).join(" ");
    const r = await sendAll({ title: `⏰ ${t.title}`, body, tag: t.id, url: `./?task=${t.id}` });
    sent += r.ok;
  }
  return { sent, tasks: due.length };
}

// Monday-morning nudge. Runs hourly on Sun/Mon UTC; only acts at Monday 08:xx Sydney (handles AEST/AEDT).
async function sendLater(force = false) {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", weekday: "short", hour: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dayKey = `${g("year")}-${g("month")}-${g("day")}`;
  if (!force && !(g("weekday") === "Mon" && parseInt(g("hour"), 10) % 24 === 8)) return { skipped: "not Monday 8am Sydney" };
  if (!force && (await secret("later_nudge_day")) === dayKey) return { skipped: "already sent today" };
  const { data: rows } = await sb.from("tasks").select("id,title,created_at").eq("done", false).is("date", null).order("created_at", { ascending: true });
  const n = rows?.length ?? 0;
  if (!force) await sb.from("app_secrets").upsert({ k: "later_nudge_day", v: dayKey });
  if (!n) return { sent: 0, count: 0 };
  const oldest = rows![0];
  const body = `${n} thing${n === 1 ? "" : "s"} in Later` + (n > 0 ? ` · oldest: ${String(oldest.title).slice(0, 60)}` : "");
  const r = await sendAll({ title: "📌 Later", body, tag: "later-weekly", url: "./" });
  return { ...r, count: n };
}

// A new agent card: push its glance text (2–3 short lines). Called by the agent_cards insert trigger.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEV: Record<string, string> = { info: "🟢", watch: "🟡", alert: "🔴" };
async function sendCard(cardId: unknown) {
  if (typeof cardId !== "string" || !UUID.test(cardId)) return { error: "bad card_id" };
  const { data: c } = await sb.from("agent_cards")
    .select("id, kind, severity, shop, headline, glance, summary, deleted_at, agents(slug, name)")
    .eq("id", cardId).maybeSingle();
  if (!c || c.deleted_at) return { skipped: "card not found" };
  // deno-lint-ignore no-explicit-any
  const ag = (c as any).agents as { slug?: string; name?: string } | null;
  const slug = ag?.slug && /^[a-z0-9-]{1,40}$/.test(ag.slug) ? ag.slug : "";
  const title = [SEV[c.severity] ?? "🤖", c.shop ? `${c.shop} ·` : "", c.headline || ag?.name || "Agent"].filter(Boolean).join(" ").slice(0, 120);
  const body = String(c.glance || c.summary || "").slice(0, 280);
  const r = await sendAll({ title, body, tag: `card-${c.id}`, url: `./?agents=${slug}&card=${c.id}` });
  return { ...r, card: c.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method === "GET") { await getServer(); return json({ publicKey: publicKeyB64 }); }
    if (req.method !== "POST") return json({ error: "method" }, 405);
    const body = await req.json().catch(() => ({}));

    if (body.action === "due" || body.action === "later" || body.action === "card") {
      const ck = req.headers.get("x-cron-key") || "";
      if (!ck || ck !== (await secret("cron_key"))) return json({ error: "forbidden" }, 403);
      if (body.action === "card") return json(await sendCard(body.card_id));
      return json(body.action === "due" ? await sendDue() : await sendLater(false));
    }

    if (body.action === "test") {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data } = await sb.auth.getUser(token);
      if (!data?.user) return json({ error: "sign in first" }, 401);
      const r = await sendAll({ title: "🔔 Daybook", body: "Notifications are working.", tag: "test", url: "./" });
      return json(r);
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message || e).slice(0, 300) }, 500);
  }
});
