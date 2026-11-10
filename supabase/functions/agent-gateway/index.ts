// agent-gateway: one door for every surface (Daybook, voice, glasses).
// Auth is done in this function (verify_jwt = false):
//   - Daybook sends the Supabase user JWT.
//   - Devices (glasses/phone/voice) send a device token starting with "dvc_"; only its SHA-256 is stored.
// No secrets live in this file. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.
// The agent-run endpoint is NOT wired yet (needs the Anthropic key, which Idris adds as a secret himself).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*", // bearer-token auth, no cookies
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

  const who = await authenticate(req);
  if (!who) return json({ error: "unauthorised" }, 401);

  try {
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
        for (const c of cards as Array<Record<string, unknown>>) {
          if (c.image_path) {
            const { data: s } = await sb.storage.from("agent-images").createSignedUrl(String(c.image_path), 3600);
            c.image_url = s?.signedUrl ?? null;
          }
        }
      }
      return json({ cards });
    }

    // POST /message {agent, text}  -> stores the chat message; the agent run is wired later
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
      return json({ status: "stored", message: data, note: "agent replies are not connected yet" }, 202);
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
      // Glasses/voice/phone can never approve anything that reaches staff or changes bonuses.
      if (who.isDevice && (appr.kind === "staff_message" || appr.kind === "bonus")) {
        return json({ error: "approve this one in Daybook" }, 403);
      }
      const { error } = await sb
        .from("agent_approvals")
        .update({ status: decision === "approve" ? "approved" : "rejected", decided_at: new Date().toISOString(), decided_via: who.via })
        .eq("id", appr.id)
        .eq("owner_id", who.ownerId)
        .eq("status", "pending");
      if (error) throw error;
      // Nothing is executed here yet: approving only records the decision.
      return json({ ok: true, status: decision === "approve" ? "approved" : "rejected" });
    }

    // POST /run -> will start a Managed Agent session once the Anthropic key is added
    if (path === "/run" && req.method === "POST") {
      return json({ error: "not implemented yet" }, 501);
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error("gateway error", e instanceof Error ? e.message : e);
    return json({ error: "server error" }, 500);
  }
});
