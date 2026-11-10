// agent-gateway: one door for every surface (Daybook, voice, glasses).
// Auth is done in this function (verify_jwt = false):
//   - Daybook sends the Supabase user JWT.
//   - Devices (glasses/phone/voice) send a device token starting with "dvc_"; only its SHA-256 is stored.
// No secrets live in this file. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
// The agent itself runs on Claude Managed Agents (see cma.ts); the Anthropic key is the Supabase secret ANTHROPIC_AGENT_API_KEY.
//   - The agent posts cards with its own posting key ("ing_..."), stored in Anthropic's vault, never in the sandbox.
//   - Anthropic calls /webhook (signed) when a run changes state.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import * as cma from "./cma.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*", // bearer-token auth, no cookies
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256hex = cma.sha256hex;
const AGENT_COLS = "id, owner_id, slug, name, anthropic_agent_id, anthropic_environment_id, config";
const CARD_KINDS = ["brief", "alert", "report", "draft"], SEVERITIES = ["info", "watch", "alert"];
const APPROVAL_KINDS = ["staff_message", "memory_save", "bonus", "other"];
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function agentRow(ownerId: string, slug: unknown) {
  const s = typeof slug === "string" && /^[a-z0-9-]{1,40}$/.test(slug) ? slug : "stockwise";
  const { data } = await sb.from("agents").select(AGENT_COLS).eq("owner_id", ownerId).eq("slug", s).maybeSingle();
  if (!data) throw new cma.HttpError(404, "agent not found");
  return data as cma.AgentRow;
}

// POST /ingest/card: the agent posts a card (optional poster PNG and approval) with its posting key.
async function ingestCard(req: Request) {
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token.startsWith("ing_") || token.length > 200) return json({ ok: false, error: "unauthorised" }, 401);
  const { data: row } = await sb.from("agents").select(AGENT_COLS).eq("config->>ingest_hash", await sha256hex(token)).maybeSingle();
  if (!row) return json({ ok: false, error: "unauthorised" }, 401);
  const raw = await req.text();
  if (raw.length > 4_500_000) return json({ ok: false, error: "card too large (image max ~3 MB)" }, 413);
  let b: Record<string, unknown>;
  try { b = JSON.parse(raw); } catch (_) { return json({ ok: false, error: "body must be JSON" }, 400); }
  const headline = str(b.headline, 80);
  if (!headline) return json({ ok: false, error: "headline required (max 80 chars)" }, 400);
  const { count } = await sb.from("agent_cards").select("id", { count: "exact", head: true })
    .eq("agent_id", row.id).gte("created_at", new Date(Date.now() - 3600e3).toISOString());
  if ((count ?? 0) >= 20) return json({ ok: false, error: "too many cards this hour" }, 429);
  const ap = b.approval && typeof b.approval === "object" ? b.approval as Record<string, unknown> : null;
  if (ap && !APPROVAL_KINDS.includes(String(ap.kind))) return json({ ok: false, error: "approval.kind must be one of " + APPROVAL_KINDS.join(", ") }, 400);
  let png: Uint8Array | null = null;
  if (typeof b.image_png_base64 === "string" && b.image_png_base64) {
    try { png = Uint8Array.from(atob(b.image_png_base64.replace(/\s+/g, "")), (c) => c.charCodeAt(0)); } catch (_) { return json({ ok: false, error: "image_png_base64 is not valid base64" }, 400); }
    if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return json({ ok: false, error: "image must be a PNG" }, 400);
    if (png.length > 3_000_000) return json({ ok: false, error: "image too large (max 3 MB)" }, 413);
  }
  const kind = ap ? "draft" : (CARD_KINDS.includes(String(b.kind)) ? String(b.kind) : "brief");
  const severity = SEVERITIES.includes(String(b.severity)) ? String(b.severity) : "info";
  const { data: card, error } = await sb.from("agent_cards").insert({
    owner_id: row.owner_id, agent_id: row.id, kind, severity, shop: str(b.shop, 60) || null, headline,
    glance: str(b.glance, 280) || null, summary: str(b.summary, 1000) || null, body_md: str(b.body_md, 20000) || null,
    data: b.data && typeof b.data === "object" ? b.data : null,
  }).select("id").single();
  if (error) throw error;
  const patch: Record<string, unknown> = {};
  if (png) {
    const path = `${row.owner_id}/${row.slug}/${card.id}.png`;
    const up = await sb.storage.from("agent-images").upload(path, png, { contentType: "image/png", upsert: true });
    if (!up.error) patch.image_path = path;
  }
  if (ap) {
    const p = ap.payload && typeof ap.payload === "object" ? ap.payload as Record<string, unknown> : {};
    const payload = { to: str(p.to, 120) || null, title: str(p.title, 120) || null, text: str(p.text, 4000) };
    const { data: appr, error: ae } = await sb.from("agent_approvals").insert({
      owner_id: row.owner_id, agent_id: row.id, card_id: card.id, kind: String(ap.kind), payload, status: "pending",
    }).select("id").single();
    if (ae) throw ae;
    patch.actions = [{ label: "Approve", type: "approve", approval_id: appr.id }, { label: "Reject", type: "reject", approval_id: appr.id }];
  }
  if (Object.keys(patch).length) await sb.from("agent_cards").update(patch).eq("id", card.id);
  return json({ ok: true, card_id: card.id, image: !!patch.image_path });
}

function safeReturn(u: unknown) {
  if (typeof u !== "string" || u.length > 300) return null;
  try { const x = new URL(u); return x.protocol === "https:" || x.hostname === "localhost" ? x.origin + x.pathname : null; } catch (_) { return null; }
}

type Caller = {
  ownerId: string;
  isDevice: boolean;
  via: "daybook" | "voice" | "glasses" | "shortcut";
};

async function authenticate(req: Request): Promise<Caller | null> {
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token || token.length > 4096) return null;

  if (token.startsWith("dvc_")) {
    const hash = await sha256hex(token);
    const { data } = await sb
      .from("agent_devices")
      .select("id, owner_id, channel")
      .eq("token_hash", hash)
      .is("revoked_at", null)
      .maybeSingle();
    if (!data) return null;
    await sb.from("agent_devices").update({ last_seen_at: new Date().toISOString() }).eq("id", data.id);
    const via = data.channel === "glasses" ? "glasses" : data.channel === "voice" ? "voice" : "shortcut";
    return { ownerId: data.owner_id, isDevice: true, via };
  }

  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;
  return { ownerId: data.user.id, isDevice: false, via: "daybook" };
}

async function agentIdFor(ownerId: string, slug: string | null) {
  if (!slug || !/^[a-z0-9-]{1,40}$/.test(slug)) return null;
  const { data } = await sb.from("agents").select("id").eq("owner_id", ownerId).eq("slug", slug).maybeSingle();
  return data?.id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const path = (url.pathname.replace(/^\/functions\/v1/, "").replace(/^\/agent-gateway/, "") || "/").replace(/\/+$/, "") || "/";

  if (path === "/health" && req.method === "GET") return json({ ok: true });

  try {
    // Signed by Anthropic: run status, cost and chat replies.
    if (path === "/webhook" && req.method === "POST") {
      const body = await req.text();
      let ev;
      try { ev = cma.unwrapWebhook(body, req.headers); } catch (e) {
        if (e instanceof cma.HttpError) return json({ error: e.message }, e.status);
        return json({ error: "bad signature" }, 400);
      }
      await cma.handleWebhook(sb, ev.data.type, ev.data.id);
      return json({ ok: true });
    }
    // The agent posting a card (its own posting key).
    if (path === "/ingest/card" && req.method === "POST") return await ingestCard(req);
    // StockWise sign-in comes back here (browser redirect, no Daybook token).
    if (path === "/oauth/callback" && req.method === "GET") {
      const code = url.searchParams.get("code") ?? "", state = url.searchParams.get("state") ?? "";
      if (!code || !state) return new Response("StockWise sign-in was cancelled. You can close this page.", { status: 400 });
      try {
        const back = await cma.oauthCallback(sb, code, state);
        return new Response(null, { status: 302, headers: { location: back + "?agents=stockwise&connected=1" } });
      } catch (e) {
        return new Response(e instanceof cma.HttpError ? e.message : "StockWise sign-in failed. Try again from Daybook.", { status: 400 });
      }
    }
  } catch (e) {
    console.error("gateway public error", e instanceof Error ? e.message : e);
    return json({ error: "server error" }, 500);
  }

  const who = await authenticate(req);
  if (!who) return json({ error: "unauthorised" }, 401);

  try {
    // GET /status?agent=stockwise -> what is set up, for the Agents > Setup tab (Daybook only)
    if (path === "/status" && req.method === "GET") {
      if (who.isDevice) return json({ error: "Daybook only" }, 403);
      const row = await agentRow(who.ownerId, url.searchParams.get("agent"));
      const cfg = row.config ?? {};
      return json({
        key: cma.hasKey(), webhook_key: !!Deno.env.get("ANTHROPIC_WEBHOOK_SIGNING_KEY"),
        webhook_url: cma.GATEWAY_URL + "/webhook",
        setup: !!(row.anthropic_agent_id && cfg.deployments), setup_at: cfg.setup_at ?? null,
        stockwise: !!cfg.sw_cred_id, stockwise_at: cfg.sw_connected_at ?? null,
        schedules_on: !!cfg.schedules_on, schedules: await cma.scheduleList(row),
      });
    }
    if (path.startsWith("/admin/") && req.method === "POST") {
      if (who.isDevice) return json({ error: "Daybook only" }, 403);
      const body = await req.json().catch(() => ({}));
      const row = await agentRow(who.ownerId, body?.agent);
      if (path === "/admin/setup") return json({ ok: true, done: await cma.setup(sb, row) });
      if (path === "/admin/schedules") { await cma.setSchedules(sb, row, body?.on === true); return json({ ok: true, on: body?.on === true }); }
      if (path === "/admin/stockwise/connect") {
        const back = safeReturn(body?.return_to);
        if (!back) return json({ error: "bad return_to" }, 400);
        return json({ ok: true, url: await cma.oauthStart(sb, row, back) });
      }
      return json({ error: "not found" }, 404);
    }

    // GET /feed?agent=stockwise&limit=20  -> newest cards first (deleted cards are hidden)
    if (path === "/feed" && req.method === "GET") {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 50);
      const slug = url.searchParams.get("agent");
      const cols = who.isDevice
        ? "id, kind, severity, shop, headline, glance, actions, read_at, created_at" // glasses: glance only
        : "id, agent_id, run_id, kind, severity, shop, headline, glance, summary, body_md, image_path, data, actions, read_at, created_at";
      let q = sb.from("agent_cards").select(cols).eq("owner_id", who.ownerId).is("deleted_at", null).order("created_at", { ascending: false }).limit(limit);
      if (slug) {
        const agentId = await agentIdFor(who.ownerId, slug);
        if (!agentId) return json({ error: "agent not found" }, 404);
        q = q.eq("agent_id", agentId);
      }
      const { data, error } = await q;
      if (error) throw error;
      const cards = data ?? [];
      if (!who.isDevice) {
        for (const c of cards as unknown as Array<Record<string, unknown>>) {
          if (c.image_path) {
            const { data: s } = await sb.storage.from("agent-images").createSignedUrl(String(c.image_path), 3600);
            c.image_url = s?.signedUrl ?? null;
          }
        }
      }
      return json({ cards });
    }

    // POST /message {agent, text}  -> stores the chat message and sends it to the agent's chat session
    if (path === "/message" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!text || text.length > 2000) return json({ error: "text required (max 2000 chars)" }, 400);
      const agentId = await agentIdFor(who.ownerId, body?.agent ?? null);
      if (!agentId) return json({ error: "agent not found" }, 404);
      const { data, error } = await sb
        .from("agent_messages")
        .insert({ owner_id: who.ownerId, agent_id: agentId, role: "user", channel: who.via, content: text })
        .select("id, created_at")
        .single();
      if (error) throw error;
      const row = await agentRow(who.ownerId, body?.agent);
      if (!row.anthropic_agent_id || !cma.hasKey()) return json({ status: "stored", message: data, note: "agent not set up yet" }, 202);
      try { await cma.sendChat(sb, row, text); }
      catch (e) { console.error("chat send failed", e instanceof Error ? e.message : e); return json({ status: "stored", message: data, note: "saved, but the agent could not be reached" }, 202); }
      return json({ status: "sent", message: data }, 202);
    }

    // POST /cards/:id/read
    let m = path.match(/^\/cards\/([^/]+)\/read$/);
    if (m && req.method === "POST") {
      if (!UUID.test(m[1])) return json({ error: "bad id" }, 400);
      const { error } = await sb.from("agent_cards").update({ read_at: new Date().toISOString() }).eq("id", m[1]).eq("owner_id", who.ownerId);
      if (error) throw error;
      return json({ ok: true });
    }

    // DELETE /cards/:id  -> hides the card (soft delete, so Undo can bring it back). Daybook only.
    m = path.match(/^\/cards\/([^/]+)$/);
    if (m && req.method === "DELETE") {
      if (who.isDevice) return json({ error: "delete this one in Daybook" }, 403);
      if (!UUID.test(m[1])) return json({ error: "bad id" }, 400);
      const { data, error } = await sb.from("agent_cards").update({ deleted_at: new Date().toISOString() })
        .eq("id", m[1]).eq("owner_id", who.ownerId).is("deleted_at", null).select("id");
      if (error) throw error;
      if (!data?.length) return json({ error: "not found" }, 404);
      return json({ ok: true });
    }

    // POST /cards/:id/restore  -> Undo for a deleted card. Daybook only.
    m = path.match(/^\/cards\/([^/]+)\/restore$/);
    if (m && req.method === "POST") {
      if (who.isDevice) return json({ error: "restore this one in Daybook" }, 403);
      if (!UUID.test(m[1])) return json({ error: "bad id" }, 400);
      const { data, error } = await sb.from("agent_cards").update({ deleted_at: null })
        .eq("id", m[1]).eq("owner_id", who.ownerId).not("deleted_at", "is", null).select("id");
      if (error) throw error;
      if (!data?.length) return json({ error: "not found" }, 404);
      return json({ ok: true });
    }

    // POST /approvals/:id/decide {decision: "approve" | "reject"}
    m = path.match(/^\/approvals\/([^/]+)\/decide$/);
    if (m && req.method === "POST") {
      if (!UUID.test(m[1])) return json({ error: "bad id" }, 400);
      const body = await req.json().catch(() => null);
      const decision = body?.decision;
      if (decision !== "approve" && decision !== "reject") return json({ error: "decision must be approve or reject" }, 400);
      const { data: appr } = await sb
        .from("agent_approvals")
        .select("id, kind, status")
        .eq("id", m[1])
        .eq("owner_id", who.ownerId)
        .maybeSingle();
      if (!appr) return json({ error: "not found" }, 404);
      if (appr.status !== "pending") return json({ error: "already decided" }, 409);
      // Glasses/voice/phone can never approve anything that reaches staff, changes bonuses or writes memory.
      if (who.isDevice && (appr.kind === "staff_message" || appr.kind === "bonus" || appr.kind === "memory_save")) {
        return json({ error: "approve this one in Daybook" }, 403);
      }
      if (decision === "approve" && appr.kind === "memory_save") {
        const { data: full } = await sb.from("agent_approvals").select("payload, agent_id").eq("id", appr.id).single();
        const { data: ag } = await sb.from("agents").select(AGENT_COLS).eq("id", full!.agent_id).single();
        const p = (full!.payload ?? {}) as Record<string, unknown>;
        await cma.saveNote(ag as cma.AgentRow, str(p.title, 120) || "Note", str(p.text, 4000));
      }
      const { error } = await sb
        .from("agent_approvals")
        .update({ status: decision === "approve" ? "approved" : "rejected", decided_at: new Date().toISOString(), decided_via: who.via })
        .eq("id", appr.id)
        .eq("owner_id", who.ownerId)
        .eq("status", "pending");
      if (error) throw error;
      // Staff messages are never sent from here: Daybook copies the text for Idris to send himself.
      return json({ ok: true, status: decision === "approve" ? "approved" : "rejected" });
    }

    // POST /run {agent, label} -> start one run now (same settings as its schedule). Daybook only.
    if (path === "/run" && req.method === "POST") {
      if (who.isDevice) return json({ error: "Daybook only" }, 403);
      const body = await req.json().catch(() => ({}));
      const row = await agentRow(who.ownerId, body?.agent);
      const label = typeof body?.label === "string" ? body.label : "morning";
      return json({ ok: true, run: await cma.runNow(sb, row, label) });
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof cma.HttpError) return json({ error: e.message }, e.status);
    console.error("gateway error", e instanceof Error ? e.message : e);
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: "server error", detail: msg.slice(0, 300) }, 500);
  }
});
