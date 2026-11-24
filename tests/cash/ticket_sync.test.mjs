// Repair-ticket cash payments in the POS sync (source = 'ticket') next to invoices.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanPayment, handleCashSync } from "../../supabase/functions/agent-gateway/cash_phase2.ts";
import { matchEvents } from "../../supabase/functions/agent-gateway/cash_match.ts";
import { INSTRUCTIONS } from "../../supabase/functions/agent-gateway/stockwise_def.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const MCC = "744a2cca-638a-41ee-ae7c-9930877b7c7c", FAIRFIELD = "3f8758cf-c1db-43d8-8082-ccac8fca6409";
// What the agent would send for today's real ticket T00M64 ($150 cash, 25 Nov 09:21:57 Sydney)
const ticket = (o = {}) => ({ source: "ticket", store_id: MCC, store_key: "mcc", source_uuid: "fde42e7f-ed51-4a29-ab83-511283ed96bc", invoice_number: "T00M64", payment_ref: "aeb140df-3964-477f-99f1-7c5f8fdd1a9d",
  paid_at: "2026-11-25T09:21:57+11:00", business_date: "2026-11-25", cash_amount: 150, total_amount: 150, payment_method: "cash", status: "completed", staff: "Yusief", ...o });
const invoice = (o = {}) => ({ store_id: MCC, store_key: "mcc", source_uuid: "inv-uuid-1", invoice_number: "I57L18", payment_ref: "tx-1", paid_at: "2026-11-24T14:50:58+11:00", business_date: "2026-11-24", cash_amount: 15, total_amount: 15, payment_method: "cash", status: "completed", staff: "Ali", ...o });

test("a repair-ticket cash payment is accepted and stored as source 'ticket' with its own payment id", () => {
  const c = cleanPayment(ticket()); assert.ok(c);
  assert.deepEqual([c.source, c.source_ref, c.payment_ref, c.cash_amount, c.total_amount, c.paid_at, c.store_key], ["ticket", "T00M64", "aeb140df-3964-477f-99f1-7c5f8fdd1a9d", 150, 150, "2025-11-24T22:21:57.000Z".replace("2025", "2026"), "mcc"]);
});
test("invoices are unchanged: no source means invoice, same fields as before", () => {
  const c = cleanPayment(invoice()); assert.deepEqual([c.source, c.source_ref, c.payment_ref, c.cash_amount], ["invoice", "I57L18", "tx-1", 15]);
  assert.equal(cleanPayment(invoice({ source: "invoice" })).source, "invoice");
});
test("rejections still hold: other stores, non-cash, unknown source, ticket without a payment id, bad amounts", () => {
  for (const [name, p] of [["Fairfield", ticket({ store_id: FAIRFIELD, store_key: "mccfairfield" })], ["wrong store id", ticket({ store_id: FAIRFIELD })], ["card", ticket({ payment_method: "card" })], ["not completed", ticket({ status: "pending" })],
    ["unknown source", ticket({ source: "refund" })], ["ticket without payment id", ticket({ payment_ref: "" })], ["zero cash", ticket({ cash_amount: 0 })], ["no ticket number", ticket({ invoice_number: "" })], ["bad date", ticket({ paid_at: "nope" })]]) assert.equal(cleanPayment(p), null, name);
});

// minimal Supabase stand-in that records what the handler writes and answers the "already known" lookup
const fakeSb = (existing = []) => {
  const upserts = [], logs = [];
  const q = (table) => { const st = { table, filters: [] }; const api = {
    select() { return api; }, eq(k, v) { st.filters.push([k, v]); return api; }, in(k, v) { st.filters.push([k, v]); return api; }, gt() { return api; }, limit() { return api; }, maybeSingle: async () => ({ data: null }),
    upsert(rows) { if (table === "cash_pos_payments") upserts.push(...rows); return Promise.resolve({ error: null }); },
    insert(row) { if (table === "cash_sync_log") logs.push(row); return Promise.resolve({ error: null }); },
    then(res) { return Promise.resolve({ data: table === "cash_pos_payments" ? existing : [], error: null }).then(res); } }; return api; };
  return { from: q, rpc: async () => ({ data: { ok: true, matched: 0 }, error: null }), upserts, logs };
};
const reply = (b, s = 200) => new Response(JSON.stringify(b), { status: s });
const post = (sb, payments) => handleCashSync(new Request("http://x", { method: "POST", body: JSON.stringify({ payments }) }), { id: "a", owner_id: "o" }, sb, reply);

test("sync: invoice and ticket payments arrive together and are both stored and counted as new", async () => {
  const sb = fakeSb(); const r = await (await post(sb, [invoice(), ticket()])).json();
  assert.deepEqual([r.ok, r.accepted, r.new], [true, 2, 2]); assert.deepEqual(sb.upserts.map((x) => x.source).sort(), ["invoice", "ticket"]);
});
test("sync: re-sending a known ticket payment is not new; an invoice with the same ids does not hide it; a second part payment is new", async () => {
  const known = [{ source: "ticket", source_uuid: ticket().source_uuid, payment_ref: ticket().payment_ref }];
  assert.equal((await (await post(fakeSb(known), [ticket()])).json()).new, 0);
  const sameIds = [{ source: "invoice", source_uuid: ticket().source_uuid, payment_ref: ticket().payment_ref }];
  assert.equal((await (await post(fakeSb(sameIds), [ticket()])).json()).new, 1, "different source = different payment");
  assert.equal((await (await post(fakeSb(known), [ticket(), ticket({ payment_ref: "second-part", cash_amount: 40, total_amount: 40 })])).json()).new, 1);
});
test("sync: one bad payment rejects the whole batch (nothing half-saved)", async () => {
  const sb = fakeSb(); const res = await post(sb, [invoice(), ticket({ payment_ref: "" })]); assert.equal(res.status, 400); assert.equal(sb.upserts.length, 0);
});

test("today's case: the 09:21:57 ticket payment matches the 09:21:46.8 camera event (10 s apart, inside the 120 s window)", () => {
  const ev = [{ id: "e1", store_key: "mcc", detected_at: "2026-11-24T22:21:46.825Z" }], pay = [{ id: "p1", store_key: "mcc", paid_at: cleanPayment(ticket()).paid_at, cash_amount: 150 }];
  const m = matchEvents(ev, pay, { windowSeconds: 120, clockOffsetSeconds: -2.1, ambiguitySeconds: 15 });
  assert.deepEqual(m.matched.map((x) => [x.event_id, x.payment_id]), [["e1", "p1"]]);
});

test("the agent's instructions now cover both invoices and 'Repair payment' tickets, in the same single run", () => {
  const s = INSTRUCTIONS.slice(INSTRUCTIONS.indexOf("## Cash Audit machine sync"), INSTRUCTIONS.indexOf("## Arithmetic"));
  for (const need of ["cash_drawer_openings", "status=repair_payment", "`due_payments`", "`source` = `ticket`", "within 5 minutes", "never the ticket total", "Never include MccFairfield", "Do not post a card"]) assert.ok(s.includes(need), need);
  assert.ok(/mixes cash and card/.test(s), "mixed payments are skipped");
});

const psql = (db, sql, file) => { const r = spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-X", "-d", db, "-t", "-A", ...(file ? ["-f", file] : ["-c", sql])], { encoding: "utf8" }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
test("database: ticket and invoice rows coexist, and the same ticket payment cannot be stored twice", () => {
  const DB = "cashtick_" + process.pid, O = "aaaaaaaa-0000-0000-0000-000000000001";
  assert.ok(psql("postgres", `create database ${DB}`).ok);
  try {
    for (const f of ["supabase_stub.sql", "phase2_stub.sql", "../../supabase/migrations/20261113_cash_audit_phase1.sql", "../../supabase/migrations/20261115_cash_audit_phase2.sql"]) assert.ok(psql(DB, "", path.join(here, f)).ok, f);
    psql(DB, `insert into auth.users(id,email) values ('${O}','o@x')`);
    const ins = (src, ref) => psql(DB, `insert into cash_pos_payments(owner_id,store_id,store_key,source,source_uuid,source_ref,payment_ref,paid_at,business_date,cash_amount,total_amount,payment_method) values ('${O}','${MCC}','mcc','${src}','u1','R1','${ref}','2026-11-25 09:21:57+11','2026-11-25',150,150,'cash')`);
    assert.ok(ins("invoice", "p1").ok); assert.ok(ins("ticket", "p1").ok, "same ids, different source"); assert.equal(ins("ticket", "p1").ok, false, "duplicate ticket payment refused"); assert.ok(ins("ticket", "p2").ok, "second part payment");
    assert.equal(psql(DB, `select count(*) from cash_pos_payments where source='ticket'`).out, "2");
  } finally { psql("postgres", `drop database if exists ${DB} with (force)`); }
});
