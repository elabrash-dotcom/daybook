# Cash Audit: Phase 1 integration testing and Phase 2 report

Branch `claude/new-session-bvpb4w`. **Nothing is deployed.** No production migration, no Edge Function deploy, no UI deploy, the Stockwise agent and its MCP configuration were not touched, and no image is public.

## 1. Phase 1 verification
Phase 1 is committed and pushed. The suite was 45 tests at hand-over (not 41: 19 database, 13 core, 13 handler); all 45 passed again before any change. Since then it grew (below).

## 2. Changes to the backend contract (all reviewed against the real flow)
| Change | Why |
|---|---|
| Review labels are now `confirmed_cash`, `false_detection`, `unsure`, `other` | Your four labels. The migration was never applied, so it was edited in place |
| New `POST /cash/images` (Daybook login only) → 10-minute signed view links for raw, annotated and clip | The bucket is private and has no browser policy, so the screen needs signed links. Only the caller's own events are returned |
| `snapshot` accepted as an alias of `annotated` in uploads | Events from before the raw/annotated split stay uploadable |
| `cashGate()`: one testable rule for who may call what | Camera tokens: `/cash/*` only; everyone else refused on camera routes; `/cash/images` Daybook only |
| `cash_match.ts` | The POS matching contract (same store, closest in time first, each side used once, ±120 s default). Not wired to anything yet |

## 3. Development environment (item 3)
- **No Supabase development project was available.** The only connected Supabase project is production, so I did not use it, and there is no Docker daemon here for a local Supabase stack.
- Instead: a local integration harness (`tests/cash/pg_harness.mjs`): a real HTTP server, a real PostgreSQL 16 with the **real migration**, the **real** handlers, and an on-disk storage emulation with signed upload/view links (signature, expiry, content type, size, private). It replaces only `cash_store.ts`, the thin Supabase calls.
- **Still required before production:** run the same flow once against a real Supabase development project (a Supabase branch or a free second project). Specifically the Storage signed-upload `PUT` with a raw body, `createSignedUrl`, and the PostgREST upsert with `ignoreDuplicates`. I need a dev project URL and its service-role key for that, or your OK to create a Supabase branch (a paid action).

## 4. Phase 2: the review screen (inside `index.html`)
Home screen gets a **Cash audit** tile (only when events exist and the table is readable, so current production is unaffected). It opens:
- **Filters**: Today / 7 days / 30 days / All, a date picker, store (All, MCC, Mobiletek), and review state (All, To review, Cash, False, Unsure, Other). Rows scroll sideways so they stay one line each.
- **Event list**: grouped by Sydney day, 20 per page ("Show more"), status dot, store, time, confidence, track id. Fairfield is excluded in the query.
- **Event detail**: raw / annotated switch, bounding-box overlay on the raw frame (pixel or normalised boxes), boxes toggle, clip link, type, confidence, track id, frame size, POS-match status, event id, and a "Next to review" shortcut.
- **Labels**: Confirmed Cash, False Detection, Unsure, Other, plus an optional note. Tapping the active label clears it. Saved straight to the table under row-level security (only `label` and `label_note` can be changed).
- **Backward compatible**: events with no raw snapshot fall back to the annotated one with a note; events with no snapshot say so; missing boxes, confidence, track id and frame size are simply omitted.
- **POS structure**: every event shows "POS match: not checked yet"; matched/unmatched states and the time difference render as soon as a later phase fills the columns.
- **Privacy**: images load only when an event is opened, from links that expire in 10 minutes; expired links refresh themselves once.
- Cache name bumped to `daybook-v35` in `sw.js` so installed copies pick the update up when (and only when) this ships.

## 5. Test results
| Suite | Result |
|---|---|
| Database / RLS (`db.test.mjs`), core (`core.test.mjs`), handlers (`handlers.test.mjs`), match (`match.test.mjs`) | 49 passed |
| Integration over real HTTP + PostgreSQL (`integration.test.mjs`) | 12 passed |
| **Node total** | **61 passed, 0 failed** |
| Browser UI test, iPhone 13 profile (`tests/cash-ui/cash_ui.js`, mocked backend) | 30 checks passed |
| Same UI test with the table missing (today's production) | tile hidden, no JS errors |
| TypeScript strict check of the gateway | clean |
The UI test caught a real bug during development (a variable used before it was declared, which blanked the whole app); it is fixed.

## 6. Requires your approval (none done)
1. Apply `supabase/migrations/20261113_cash_audit_phase1.sql` to production.
2. Deploy `agent-gateway` with all six files (`index.ts`, `cma.ts`, `stockwise_def.ts`, `cash.ts`, `cash_core.ts`, `cash_store.ts`) and, with it, `cash_match.ts` (imported by nothing yet, so optional).
3. Create the camera device token (shown once) and give it to GPT Work.
4. Merge the branch to `main` to publish the new screen (GitHub Pages).
5. A real-Supabase dev smoke test (section 3).

## 7. Unresolved
- A real Jetson event sample (field names are accepted by alias; the boxes' units are decided by value range).
- The 10 MB clip cap versus real clip sizes.
- Retention period and workplace surveillance notice for snapshots.
- POS matching itself, the 7 PM Sydney report, and a retention job (later phases).
- Realtime "new events" banner is wired but untested against real Supabase Realtime.
