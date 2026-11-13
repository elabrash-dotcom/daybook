import test from "node:test";
import assert from "node:assert/strict";
import { matchEvents } from "../../supabase/functions/agent-gateway/cash_match.ts";

const E = (id, t, s = "mcc") => ({ id, store_key: s, detected_at: t });
const P = (id, t, amt = 50, s = "mcc") => ({ id, store_key: s, paid_at: t, cash_amount: amt });

test("closest pairs first, one-to-one", () => {
  const r = matchEvents([E("e1", "2026-11-13T04:00:30Z"), E("e2", "2026-11-13T04:01:00Z")], [P("p1", "2026-11-13T04:00:50Z")]);
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
