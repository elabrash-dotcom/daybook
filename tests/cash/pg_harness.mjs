// Local integration harness: real HTTP + real PostgreSQL (with the real migration) + real handlers.
// Storage is emulated on disk: signed upload/view URLs behave like Supabase's (token, expiry, content-type, size, private).
// This is NOT Supabase: cash_store.ts (the PostgREST/Storage layer) is the only part it replaces.
import http from "node:http";
import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { cashGate, handleCash, handleDeviceAdmin, handleImages } from "../../supabase/functions/agent-gateway/cash.ts";

const sha = async (s) => createHash("sha256").update(s).digest("hex");
const SECRET = "harness-secret";
const sign = (p, exp) => createHmac("sha256", SECRET).update(p + "|" + exp).digest("hex");

export function pgStore(pool, base, disk, clock) {
  return {
    async recentEventCount(deviceId, since) { return +(await pool.query("select count(*) c from cash_events where device_id=$1 and received_at>=$2", [deviceId, since])).rows[0].c; },
    async insertEvent(r) {
      const q = await pool.query(
        `insert into cash_events(owner_id,device_id,store_key,event_uid,detected_at,device_sent_at,kind,confidence,track_id,bbox,detections,frame_width,frame_height,raw)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict (device_id,event_uid) do nothing returning id`,
        [r.owner_id, r.device_id, r.store_key, r.event_uid, r.detected_at, r.device_sent_at, r.kind, r.confidence, r.track_id,
         r.bbox && JSON.stringify(r.bbox), JSON.stringify(r.detections), r.frame_width, r.frame_height, JSON.stringify(r.raw)]);
      return q.rowCount ? "created" : "duplicate";
    },
    async findEvent(d, u) { return (await pool.query("select id,owner_id,store_key,detected_at,event_uid from cash_events where device_id=$1 and event_uid=$2", [d, u])).rows.map((x) => ({ ...x, detected_at: x.detected_at.toISOString() }))[0] ?? null; },
    async signedUpload(p) { const exp = clock() + 7200e3; return { url: `${base}/storage/upload/${p}?exp=${exp}&sig=${sign("up:" + p, exp)}`, token: "t" }; },
    async objectSize(p) { const f = path.join(disk, p); return fs.existsSync(f) ? fs.statSync(f).size : null; },
    async signedView(p, secs) { if (!fs.existsSync(path.join(disk, p))) return null; const exp = clock() + secs * 1000; return `${base}/storage/view/${p}?exp=${exp}&sig=${sign("view:" + p, exp)}`; },
    async ownedEventPaths(o, ids) { return (await pool.query("select id,snapshot_raw_path,snapshot_annotated_path,clip_path from cash_events where owner_id=$1 and id=any($2::uuid[])", [o, ids])).rows; },
    async setAssetPath(id, col, p) { if (!/^[a-z_]+$/.test(col)) throw new Error("col"); await pool.query(`update cash_events set ${col}=$1, assets_confirmed_at=now() where id=$2`, [p, id]); },
    async createDevice(d) { return (await pool.query("insert into agent_devices(owner_id,label,channel,store_key,token_hash) values($1,$2,'camera',$3,$4) returning id", [d.ownerId, d.label, d.storeKey, d.tokenHash])).rows[0]; },
    async listDevices(o) { return (await pool.query("select id,label,channel,store_key,last_seen_at,revoked_at,created_at from agent_devices where owner_id=$1 order by created_at desc", [o])).rows; },
    async revokeDevice(o, id) { return (await pool.query("update agent_devices set revoked_at=now() where owner_id=$1 and id=$2 and revoked_at is null", [o, id])).rowCount > 0; },
  };
}

// Mirrors index.ts authenticate(): dvc_ token -> agent_devices; "jwt:<uuid>" stands in for a Daybook login.
export async function startServer(pool, { clock = () => Date.now(), extra = null } = {}) {
  const disk = fs.mkdtempSync(path.join(os.tmpdir(), "cashdisk-"));
  let base = "";
  const store = {};
  const server = http.createServer(async (rq, rs) => {
    const url = new URL(rq.url, "http://x");
    url.pathname = url.pathname.replace(/^\/functions\/v1\/agent-gateway/, "") || "/";
    const chunks = []; for await (const c of rq) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (extra && await extra(rq, rs, url, body.toString())) return;
    const send = (b, s = 200) => { rs.writeHead(s, { "content-type": "application/json" }); rs.end(JSON.stringify(b)); };
    const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    const out = async (res) => { rs.writeHead(res.status, { "content-type": "application/json" }); rs.end(Buffer.from(await res.arrayBuffer())); };

    // storage emulation
    if (url.pathname.startsWith("/storage/")) {
      const [, , kind, ...rest] = url.pathname.split("/"); const p = decodeURIComponent(rest.join("/"));
      const exp = +url.searchParams.get("exp"), sig = url.searchParams.get("sig");
      const want = kind === "upload" ? "up:" : "view:";
      if (sig !== sign(want + p, exp)) return send({ error: "bad signature" }, 403);
      if (exp < clock()) return send({ error: "expired" }, 403);
      const file = path.join(disk, p);
      if (kind === "upload" && rq.method === "PUT") {
        const ct = rq.headers["content-type"] ?? "";
        const ok = /\.jpg$/.test(p) ? ct === "image/jpeg" : /\.mp4$/.test(p) ? ct === "video/mp4" : false;
        if (!ok) return send({ error: "mime type not allowed" }, 415);
        if (body.length > 10 * 1024 * 1024) return send({ error: "too large" }, 413);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return send({ Key: p });
      }
      if (kind === "view" && rq.method === "GET") { if (!fs.existsSync(file)) return send({ error: "not found" }, 404); rs.writeHead(200, { "content-type": "image/jpeg" }); return rs.end(fs.readFileSync(file)); }
      return send({ error: "bad request" }, 400);
    }

    const h = rq.headers.authorization ?? ""; const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    let who = null;
    if (token.startsWith("dvc_")) {
      const r = await pool.query("select * from agent_devices where token_hash=$1 and revoked_at is null", [await sha(token)]);
      if (r.rows[0]) { const d = r.rows[0]; await pool.query("update agent_devices set last_seen_at=now() where id=$1", [d.id]); who = { ownerId: d.owner_id, isDevice: true, deviceId: d.id, channel: d.channel, storeKey: d.store_key }; }
    } else if (token.startsWith("jwt:")) who = { ownerId: token.slice(4), isDevice: false };
    if (!who) return send({ error: "unauthorised" }, 401);
    const gate = cashGate(who, url.pathname);
    if (gate) return send({ error: gate.error }, gate.status);
    const req = new Request("http://x" + url.pathname, { method: rq.method, headers: rq.headers, body: ["GET", "HEAD"].includes(rq.method) ? undefined : body });
    if (who.channel === "camera") return out((await handleCash(req, url.pathname, who, store, reply, clock())) ?? reply({ error: "not found" }, 404));
    if (url.pathname === "/cash/images" && rq.method === "POST") return out(await handleImages(req, who.ownerId, store, reply));
    const adm = await handleDeviceAdmin(req, url.pathname, who.ownerId, store, reply, sha);
    return out(adm ?? reply({ error: "not found" }, 404));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(store, pgStore(pool, base, disk, clock));
  return { base, disk, close: () => { server.close(); fs.rmSync(disk, { recursive: true, force: true }); } };
}
export { pg, randomUUID, sha };
