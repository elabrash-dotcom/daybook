// Runs tests/cash-dev/e2e.mjs against the local harness + fake Supabase (real Postgres, real handlers).
// Proves the script itself is correct before it is pointed at a real development project.
// Needs a local PostgreSQL: PGHOST / PGPORT / PGUSER. Run from tests/cash after `npm install`.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pg, startServer, randomUUID } from "../cash/pg_harness.mjs";
import { fakeSupabase } from "./fake_supabase.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB = "cashdev_" + process.pid;
const psql = (db, sql, file) => spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-X", "-d", db, ...(file ? ["-f", file] : ["-c", sql])], { encoding: "utf8" });
const A = randomUUID(), B = randomUUID();
psql("postgres", `create database ${DB}`);
for (const f of ["../cash/supabase_stub.sql", "../../supabase/dev/dev_bootstrap.sql", "../../supabase/migrations/20261113_cash_audit_phase1.sql"]) {
  const r = psql(DB, "", path.join(here, f)); if (r.status) { console.error(r.stderr); process.exit(1); }
}
psql(DB, `insert into auth.users(id,email) values ('${A}','a@dev'),('${B}','b@dev')`);
const pool = new pg.Pool({ host: process.env.PGHOST, port: +process.env.PGPORT, user: process.env.PGUSER, database: DB });
const srv = await startServer(pool, { extra: fakeSupabase(pool, { "a@dev": { password: "pw", id: A }, "b@dev": { password: "pw2", id: B } }) });
const code = await new Promise((res) => spawn("node", [path.join(here, "e2e.mjs")], { stdio: "inherit", env: { ...process.env, DEV_URL: srv.base, DEV_ANON_KEY: "anon", DEV_EMAIL: "a@dev", DEV_PASSWORD: "pw", DEV_EMAIL2: "b@dev", DEV_PASSWORD2: "pw2" } }).on("exit", res));
srv.close(); await pool.end(); psql("postgres", `drop database if exists ${DB} with (force)`);
process.exit(code ?? 1);
