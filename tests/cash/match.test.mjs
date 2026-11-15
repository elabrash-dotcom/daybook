import test from "node:test";
import assert from "node:assert/strict";
import { matchEvents } from "../../supabase/functions/agent-gateway/cash_match.ts";

const E = (id, t, s = "mcc") => ({ id, store_key: s, detected_at: t });
const P = (id, t, amt = 50, s = "mcc") => ({ id, store_key: s, paid_at: t, cash_amount: amt });

test("closest pairs first, one-to-one", () => {
  const r = matchEvents([E("e1", "2026-11-13T04:00:10Z"), E("e2", "2026-11-13T04:01:00Z")], [P("p1", "2026-11-13T04:00:50Z")]);
  assert.deepEqual(r.matched, [{ event_id: "e2", payment_id: "p1", delta_seconds: 10 }]);
  assert.deepEqual(r.unmatched_events, ["e1"]);
});
test("outside the window stays unmatched on both sides", () => {
  const r = matchEvents([E("e1", "2026-11-13T04:00:00Z")], [P("p1", "2026-11-13T04:05:00Z")]);
  assert.deepEqual([r.matched.length, r.unmatched_events, r.unmatched_payments], [0, ["e1"], ["p1"]]);
});
test("different store never matches; card-only payments ignored", () => {
  const r = matchEvents([E("e1", "2026-11-13T04:00:00Z", "mcc")], [P("p1", "2026-11-13T04:00:05Z", 50, "mobiletek"), P("p2", "2026-11-13T04:00:05Z", 0)]);
  assert.deepEqual([r.matched.length, r.unmatched_payments], [0, ["p1"]]);
});
test("window is configurable, bad dates are skipped", () => {
  assert.equal(matchEvents([E("e1", "2026-11-13T04:00:00Z")], [P("p1", "2026-11-13T04:03:00Z")], 300).matched.length, 1);
  assert.equal(matchEvents([E("e1", "nope")], [P("p1", "2026-11-13T04:00:00Z")]).matched.length, 0);
});
test("near-ties are held for review, not guessed", () => {
  const r = matchEvents([E("e1", "2026-11-13T04:00:00Z"), E("e2", "2026-11-13T04:00:08Z")], [P("p1", "2026-11-13T04:00:04Z")]);
  assert.deepEqual(r.matched, []);
  assert.deepEqual(r.needs_review_events.sort(), ["e1", "e2"]);
  assert.deepEqual(r.ambiguous_payments, ["p1"]);
});
test("store clock offset is applied but raw delta is retained", () => {
  const r = matchEvents([E("e1", "2026-11-13T04:02:30Z")], [P("p1", "2026-11-13T04:00:00Z")], {clockOffsetSeconds: 60, windowSeconds: 120});
  assert.deepEqual(r.matched, [{event_id:"e1", payment_id:"p1", delta_seconds:150}]);
});
test("clock offset estimator needs three bounded observations", async () => {
  const { estimateClockOffset } = await import("../../supabase/functions/agent-gateway/cash_match.ts");
  assert.equal(estimateClockOffset([61, 60], 7), 7);
  assert.equal(estimateClockOffset([59, 60, 61, 999], 0), 60);
});
