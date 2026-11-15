// Cash Audit: deterministic POS matching.
// Pairs camera events with confirmed StockWise cash payments: same store, closest adjusted time first,
// each side used once. Near-ties are held for review instead of guessed.
// Inputs come from cash_events and cash_pos_payments; this file does no I/O.

export type MatchEvent = { id: string; store_key: string; detected_at: string };
export type MatchPayment = { id: string; store_key: string; paid_at: string; cash_amount: number };
export type MatchPair = { event_id: string; payment_id: string; delta_seconds: number }; // delta = event time - payment time
export type MatchOptions = { windowSeconds?: number; clockOffsetSeconds?: number; ambiguitySeconds?: number };

export const DEFAULT_WINDOW_SECONDS = 120;
export const DEFAULT_AMBIGUITY_SECONDS = 15;

export function matchEvents(events: MatchEvent[], payments: MatchPayment[], options: number | MatchOptions = {}) {
  const o = typeof options === "number" ? { windowSeconds: options } : options;
  const windowSeconds = o.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const clockOffsetSeconds = o.clockOffsetSeconds ?? 0;
  const ambiguitySeconds = o.ambiguitySeconds ?? DEFAULT_AMBIGUITY_SECONDS;
  const cand: (MatchPair & { abs: number })[] = [];
  for (const e of events) {
    const et = Date.parse(e.detected_at);
    if (!Number.isFinite(et)) continue;
    for (const p of payments) {
      if (p.store_key !== e.store_key || !(p.cash_amount > 0)) continue;
      const pt = Date.parse(p.paid_at);
      if (!Number.isFinite(pt)) continue;
      const d = (et - pt) / 1000;
      const adjusted = d - clockOffsetSeconds;
      if (Math.abs(adjusted) <= windowSeconds) cand.push({ event_id: e.id, payment_id: p.id, delta_seconds: Math.round(d * 10) / 10, abs: Math.abs(adjusted) });
    }
  }
  cand.sort((a, b) => a.abs - b.abs || a.event_id.localeCompare(b.event_id) || a.payment_id.localeCompare(b.payment_id));
  const ambiguousE = new Set<string>(), ambiguousP = new Set<string>();
  const markTies = (key: "event_id" | "payment_id", out: Set<string>) => {
    const by = new Map<string, typeof cand>();
    for (const c of cand) { const a = by.get(c[key]) ?? []; a.push(c); by.set(c[key], a); }
    for (const [id, a] of by) if (a.length > 1 && a[1].abs - a[0].abs <= ambiguitySeconds) out.add(id);
  };
  markTies("event_id", ambiguousE); markTies("payment_id", ambiguousP);
  for (const c of cand) if (ambiguousP.has(c.payment_id)) ambiguousE.add(c.event_id);
  const usedE = new Set<string>(), usedP = new Set<string>(), matched: MatchPair[] = [];
  for (const c of cand) {
    if (ambiguousE.has(c.event_id) || ambiguousP.has(c.payment_id)) continue;
    if (usedE.has(c.event_id) || usedP.has(c.payment_id)) continue;
    usedE.add(c.event_id); usedP.add(c.payment_id);
    matched.push({ event_id: c.event_id, payment_id: c.payment_id, delta_seconds: c.delta_seconds });
  }
  return {
    matched,
    needs_review_events: events.filter((e) => ambiguousE.has(e.id)).map((e) => e.id),
    ambiguous_payments: payments.filter((p) => ambiguousP.has(p.id)).map((p) => p.id),
    unmatched_events: events.filter((e) => !usedE.has(e.id) && !ambiguousE.has(e.id)).map((e) => e.id),
    unmatched_payments: payments.filter((p) => p.cash_amount > 0 && !usedP.has(p.id)).map((p) => p.id),
  };
}

export function estimateClockOffset(deltas: number[], fallback = 0) {
  const good = deltas.filter((x) => Number.isFinite(x) && Math.abs(x) <= 300).sort((a, b) => a - b);
  if (good.length < 3) return fallback;
  const m = Math.floor(good.length / 2);
  const median = good.length % 2 ? good[m] : (good[m - 1] + good[m]) / 2;
  return Math.round(Math.max(-120, Math.min(120, median)) * 10) / 10;
}
