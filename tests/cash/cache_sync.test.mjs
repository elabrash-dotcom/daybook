// "Cache synchronisation" checks: (1) the installed app (service worker cache) updates and never serves stale Cash Audit data,
// (2) the Cash Audit screen stays in step with the database (realtime publication covers the tables it shows).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, "../..");
const swSrc = fs.readFileSync(path.join(root, "sw.js"), "utf8");

function loadSw(src = swSrc, { origin = "https://app.example", network = true, existing = {} } = {}) {
  const store = new Map(Object.entries(existing).map(([k, v]) => [k, new Map(Object.entries(v))]));
  const listeners = {};
  const caches = {
    open: async (n) => { if (!store.has(n)) store.set(n, new Map()); const m = store.get(n); return { addAll: async (u) => u.forEach((x) => m.set(x, "shell:" + x)), put: async (req, res) => { m.set(req.url, res); }, match: async (r) => m.get(r.url ?? r) }; },
    keys: async () => [...store.keys()], delete: async (k) => store.delete(k),
    match: async (r) => { for (const m of store.values()) { const v = m.get(r.url ?? r); if (v) return v; } },
  };
  const fetched = [];
  const self = { location: { origin, href: origin + "/sw.js" }, registration: { scope: origin + "/", showNotification() {} }, clients: { claim() {}, matchAll: async () => [] }, addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting() {} };
  const ctx = vm.createContext({ self, caches, URL, console, Promise, fetch: async (req) => { fetched.push(req.url); if (!network) throw new Error("offline"); return { clone() { return this; }, body: "net:" + req.url }; }, Notification: {} });
  vm.runInContext(src, ctx);
  const run = async (type, extra = {}) => { let p; listeners[type]({ waitUntil: (x) => { p = x; }, respondWith: (x) => { p = x; }, ...extra }); return p; };
  return { store, run, fetched, listeners };
}

test("the cache name changed in this release, so installed copies pick the update up", () => {
  const cur = /var CACHE='(daybook-v\d+)'/.exec(swSrc)[1];
  const prev = spawnSync("git", ["-C", root, "show", "origin/main:sw.js"], { encoding: "utf8" }).stdout;
  const old = /var CACHE='(daybook-v\d+)'/.exec(prev)?.[1];
  assert.ok(old, "could read main's sw.js"); assert.notEqual(cur, old, `cache name must change (main is ${old}, this branch is ${cur})`);
  assert.ok(+cur.replace(/\D/g, "") > +old.replace(/\D/g, ""));
});

test("activate removes every older app cache and keeps the kid-photos cache", async () => {
  const sw = loadSw(swSrc, { existing: { "daybook-v1": { a: 1 }, "daybook-v40": { a: 1 }, "daybook-kid-photos": { p: 1 } } });
  await sw.run("install"); await sw.run("activate");
  const cur = /var CACHE='(daybook-v\d+)'/.exec(swSrc)[1];
  assert.deepEqual([...sw.store.keys()].sort(), [cur, "daybook-kid-photos"].sort());
});

test("network first: a fresh index.html is fetched and stored; offline falls back to the stored copy", async () => {
  const sw = loadSw(); await sw.run("install");
  const req = { url: "https://app.example/index.html" };
  assert.equal((await sw.run("fetch", { request: req })).body, "net:" + req.url);
  assert.ok(sw.store.get(/var CACHE='(daybook-v\d+)'/.exec(swSrc)[1]).has(req.url), "the fresh copy replaced the stored one");
  const off = loadSw(swSrc, { network: false, existing: { [/var CACHE='(daybook-v\d+)'/.exec(swSrc)[1]]: { [req.url]: "stored copy" } } });
  assert.equal(await off.run("fetch", { request: req }), "stored copy");
});

test("Cash Audit data is never served from the app cache: cross-origin (Supabase) requests are not intercepted", async () => {
  const sw = loadSw(); let responded = false;
  sw.listeners.fetch({ request: { url: "https://scjfvvwylrgpbrmdsjxb.supabase.co/rest/v1/cash_training_examples" }, respondWith: () => { responded = true; } });
  assert.equal(responded, false); assert.deepEqual(sw.fetched, []);
});

test("realtime: the migration publishes the training table (like cash_events) so the screen refreshes live", () => {
  const sql = fs.readFileSync(path.join(root, "supabase/migrations/20261117_cash_training.sql"), "utf8");
  assert.match(sql, /alter publication supabase_realtime add table public\.cash_training_examples/);
  assert.match(fs.readFileSync(path.join(root, "supabase/migrations/20261113_cash_audit_phase1.sql"), "utf8"), /alter publication supabase_realtime add table public\.cash_events/);
});

test("the UI listens to both tables and refreshes the count and list when either changes", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /table:'cash_events'/); assert.match(html, /table:'cash_training_examples'\}, \(\) => \{ cashTrainCount\(\);/);
  assert.match(html, /cashStart\(\); cashTrainCount\(\);[^\n]*\n\}\nasync function cashSaveNote/, "the count is refreshed right after a label is saved");
});
