// LOCAL STAND-IN for Supabase Auth / PostgREST / Storage, used only to check that e2e.mjs itself is correct.
// REST runs real SQL as the real `authenticated` / `anon` Postgres roles, so RLS and column privileges are the real ones.
export function fakeSupabase(pool, users) {
  return async (rq, rs, url, body) => {
    const send = (s, b, h = {}) => { rs.writeHead(s, { "content-type": "application/json", ...h }); rs.end(s === 204 ? "" : JSON.stringify(b)); return true; };
    if (url.pathname === "/auth/v1/token") {
      const { email, password } = JSON.parse(body || "{}"); const u = users[email];
      return !u || u.password !== password ? send(400, { error_description: "Invalid login credentials" }) : send(200, { access_token: "jwt:" + u.id, user: { id: u.id } });
    }
    if (url.pathname.startsWith("/storage/v1/")) return url.pathname.includes("/list/") ? send(200, []) : send(400, { error: "Bucket not found" });
    const m = url.pathname.match(/^\/rest\/v1\/(cash_events|cash_pos_payments)$/); if (!m) return false;
    const t = m[1], tok = (rq.headers.authorization || "").replace("Bearer ", ""), uid = tok.startsWith("jwt:") ? tok.slice(4) : "", role = uid ? "authenticated" : "anon";
    const where = [], args = [];
    for (const [k, v] of url.searchParams) {
      if (!["event_uid", "id"].includes(k)) continue;
      const [op, ...r] = v.split("."); const val = r.join(".");
      args.push(op === "like" ? val.replace(/\*/g, "%") : val);
      where.push(`${k} ${op === "like" ? "like" : "="} $${args.length}${k === "id" ? "::uuid" : ""}`);
    }
    const w = where.length ? " where " + where.join(" and ") : "", ord = url.searchParams.get("order") === "event_uid" ? " order by event_uid" : "";
    const c = await pool.connect();
    try {
      await c.query("begin"); await c.query(`set local role ${role}`); await c.query("select set_config('request.jwt.claim.sub',$1,true)", [uid]);
      let q;
      const data = body ? JSON.parse(body) : {}, cols = Object.keys(data);
      if (cols.some((x) => !/^[a-z_]+$/.test(x))) throw Object.assign(new Error("bad column"), { code: "22P02" });
      if (rq.method === "GET") q = await c.query(`select * from ${t}${w}${ord}`, args);
      else if (rq.method === "PATCH") q = await c.query(`update ${t} set ${cols.map((x, i) => `${x}=$${args.length + i + 1}`).join(",")}${w} returning *`, [...args, ...cols.map((x) => data[x])]);
      else if (rq.method === "DELETE") q = await c.query(`delete from ${t}${w} returning *`, args);
      else if (rq.method === "POST") q = await c.query(`insert into ${t}(${cols.join(",")}) values (${cols.map((_, i) => "$" + (i + 1)).join(",")}) returning *`, cols.map((x) => data[x]));
      else { await c.query("rollback"); return send(405, {}); }
      await c.query("commit");
      return rq.method === "GET" || /return=representation/.test(rq.headers.prefer || "") ? send(200, q.rows) : send(204, null);
    } catch (e) {
      await c.query("rollback").catch(() => {});
      return send(e.code === "42501" ? (role === "anon" ? 401 : 403) : 400, { code: e.code, message: e.message });
    } finally { c.release(); }
  };
}
