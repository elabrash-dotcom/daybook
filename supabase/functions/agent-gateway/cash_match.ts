// Cash Audit: POS matching contract (Phase 2 structure, NOT wired to anything yet).
// Pairs camera events with cash payments from StockWise: same store, closest in time first, each side used once.
// Inputs come from cash_events and cash_pos_payments; this file does no I/O.

export type MatchEvent = { id: string; store_key: string; detected_at: string };
export type MatchPayment = { id: string; store_key: string; paid_at: string; cash_amount: number };
export type MatchPair = { event_id: string; payment_id: string; delta_seconds: number }; // delta = event time - payment time

export const DEFAULT_WINDOW_SECONDS = 120;

export function matchEvents(events: MatchEvent[], payments: MatchPayment[], windowSeconds = DEFAULT_WINDOW_SECONDS) {
  const cand: (MatchPair & { abs: number })[] = [];
  for (const e of events) {
    const et = Date.parse(e.detected_at);
    if (!Number.isFinite(et)) continue;
    for (const p of payments) {
      if (p.store_key !== e.store_key || !(p.cash_amount > 0)) continue;
      const pt = Date.parse(p.paid_at);
      if (!Number.isFinite(pt)) continue;
      const d = (et - pt) / 1000;
      if (Math.abs(d) <= windowSeconds) cand.push({ event_id: e.id, payment_id: p.id, delta_seconds: Math.round(d * 10) / 10, abs: Math.abs(d) });
    }
  }
  cand.sort((a, b) => a.abs - b.abs || a.event_id.localeCompare(b.event_id) || a.payment_id.localeCompare(b.payment_id));
  const usedE = new Set<string>(), usedP = new Set<string>(), matched: MatchPair[] = [];
  for (const c of cand) {
    if (usedE.has(c.event_id) || usedP.has(c.payment_id)) continue;
    usedE.add(c.event_id); usedP.add(c.payment_id);
    matched.push({ event_id: c.event_id, payment_id: c.payment_id, delta_seconds: c.delta_seconds });
  }
  return {
    matched,
    unmatched_events: events.filter((e) => !usedE.has(e.id)).map((e) => e.id),
    unmatched_payments: payments.filter((p) => p.cash_amount > 0 && !usedP.has(p.id)).map((p) => p.id),
  };
}
