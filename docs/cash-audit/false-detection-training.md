# False detection training data collection (2026-11-16)

**Status: implemented and tested locally. NOT deployed.** Nothing was applied to production (no migration, no gateway deploy, no UI merge). Ready for a development-project smoke test, then production (see "Production readiness").

## What was implemented
When a user marks a camera detection as ❌ **False Detection** in Daybook, one training example is now collected automatically.

- **Collection is in the database, not in the app or the camera path.** A trigger on `cash_events` fires only when an event's label is (or just stopped being) `false_detection`, so ordinary detection ingestion and frame uploads never run any of it. The existing label button and its update are unchanged.
- **Original frame is never copied or edited.** The example points at the original (`raw`) and annotated frames already in the private `cash-snapshots` bucket. This avoids duplicate storage. To keep those files from being archived/re-encoded by retention, collection places the existing, audited **evidence hold** (`cash_events.preserve`) on the event.
- **Structured JSON** is stored on the example (schema `daybook.cash.false_detection/1`): detection id/uid/time, camera (device id, label, store), class, confidence, track id, bbox and all detections (with frame size), confidence threshold, model version (if the camera reports one), the user's reason (the label note), who/when labelled, image paths and state, and the camera's own (sanitised) event JSON.
- **Linked** to the original detection by `event_id`. The example also keeps the camera's `event_uid`, so it survives after the event expires.
- **No duplicates:** unique key (owner, camera, event uid). Re-sending the event, re-applying the label, toggling it off and on, or editing the note all update the same example.
- **Withdrawing** the false label marks the example `withdrawn` and releases only a hold this feature placed (a hold the user placed is never released).
- **Training data screen** (Cash audit → *Training data (N)* tab): examples grouped by **camera → date → class**, filters (Active / To review / Reviewed / Excluded, store), open an example to see original and annotated frames side by side with confidence, model, reason; **Mark reviewed**, **Exclude** (releases our hold), **Include again**; **Export ZIP**.
- **Export ZIP** (`GET /cash/training/export`): `<store>-<camera>/<YYYY-MM-DD>/<class>/<event>-<id>/{raw.jpg, annotated.jpg, meta.json}` plus `manifest.jsonl` (one flat line per example) and a `README.md` describing fields. Images are stored byte-for-byte. Filters: status, store, camera, class, from/to, limit (default 100, max 200), offset.
- **Backfill** `public.cash_training_backfill(<owner>)` collects events labelled false before this feature (production currently has **15**). It is not run automatically.

## Reliability and safety
- **Never blocks labelling:** if collection itself errors, the label still saves; the error is written to the retention audit log and the backfill recovers it.
- **Missing frames:** the example is still collected, with `image_state` = `missing` / `raw_only` / `annotated_only`; a frame uploaded later updates the example. The ZIP still contains `meta.json` and records a warning per missing file.
- **Storage failures during export:** one failing or missing file is skipped with a warning; the export still completes. A database failure returns a clean 500; an empty result a 404.
- **Archived originals** (after retention) are exported as the re-encoded WebP and labelled `image_source: archive`; they are never presented as originals.
- **Permissions:** same patterns as the rest of Cash Audit. Daybook login only (camera and other device tokens get 403); owner-only row level security; the app cannot insert, edit or delete examples; helper functions are service-role only; the export reads only inside the caller's own storage folder; Fairfield is never shown or exported.
- **Limits:** ZIP is built in memory: 200 examples, 10 MB per image, 40 MB total per export (the response says when it was truncated).

## Files
Created: `supabase/migrations/20261117_cash_training.sql`, `supabase/functions/agent-gateway/cash_training_core.ts`, `cash_training.ts`, `tests/cash/training_db.test.mjs`, `training_core.test.mjs`, `training_e2e.test.mjs`, `cache_sync.test.mjs`, `tests/cash-ui/cash_training_ui.js`, this document.
Modified: `supabase/functions/agent-gateway/index.ts` (2 routes), `cash.ts` (two paths added to the Daybook-only list), `index.html` (Training data tab), `sw.js` (cache `daybook-v42`).
Not touched: Jetson detector/uploader, retention worker, Stockwise, matching, reconciliation, sync.

## Cache synchronization: verification
No document defines "cache synchronization" beyond the service-worker cache name, so I checked the two things in Cash Audit that can go stale:
1. **App cache (service worker):** cache name bumped (v41 → v42, tested against `main`); activate deletes old caches and keeps `daybook-kid-photos`; network-first with offline fallback; Supabase requests (Cash Audit data) are never intercepted or cached. **Passed (simulated service worker, not a real browser install).**
2. **Screen vs database:** `cash_events` is in the production realtime publication (queried, read-only); the new table is added by the migration. The screen refreshes the count right after a label is saved, and the list on any change. **Passed in the mocked UI test; live realtime delivery not exercised** (the sandbox cannot reach Supabase).
No broken behaviour was found, so nothing needed fixing.

## Test results (all actually executed locally)
- Node + real PostgreSQL: **139 passed, 0 failed** (49 new). Includes: trigger/collection, metadata, hold + audit, duplicates, missing frames, incomplete metadata, late frames, archived, withdraw, review actions, event expiry, backfill, RLS, failed collection; ZIP validity (read back with Python's zipfile, CRC checked), layout, missing images, storage failures, size caps, path safety, filters, permissions; and a **full end-to-end run** over real HTTP + real Postgres + emulated storage: detection → frames uploaded → user marks false (real RLS update) → example saved → exported ZIP whose raw/annotated bytes are SHA-identical to what the camera uploaded; duplicates; missing image; failed storage; permissions.
- Mobile UI (Playwright, iPhone profile, mocked backend): 5 suites, **0 failures** (new `cash_training_ui.js` 19 checks: label→count, grouping, frames, review/exclude/include, export download, export failure, missing frame, hidden tab without migration, no horizontal scroll, no JS errors).
- Type check of the new gateway files: clean (the only remaining message is in the older `cash_store.ts`, caused by my stub of the Supabase types).

## Limitations / outstanding
- **Not tested against real Supabase** (PostgREST, Storage, Realtime) or real Deno: only local PostgreSQL with emulated storage. `supabaseTrainingStore` needs a smoke test on the development project, like `cash_store.ts`.
- **Annotated image comes from the Jetson.** If the camera did not upload one, it is reported missing; the server does not draw boxes. (Boxes are in `meta.json` and are also shown in the app.)
- **Model version** is exported only if the camera sends `model_version`/`model`/`model_name`/`weights`. Today's production events do not, so it is `null`.
- **Retention policy decision for Idris:** holding false-detection evidence keeps those files beyond the normal 30-day original window until the example is excluded or the label removed. This uses the existing hold mechanism, but it is a storage/retention choice. If Idris releases the hold by hand on an event, its frames can later be archived and the example would then point at a re-encoded copy.
- Export is paged by the API (`offset`), but the UI exports the first page only (up to 100); narrow the filter to export more.
- Training images are of the shop floor (people may appear). The earlier open item still stands: storage region / overseas processing and privacy sign-off are not verified.
- The existing quirk remains: the retention worker is not yet on the Jetson.

## Production readiness
**Not ready to deploy yet.** Code and local tests are complete. Before production:
1. Apply `20261117_cash_training.sql` to the **development** Supabase project, deploy the gateway there, and run one real label → frames → export round trip.
2. Idris to approve the retention choice above.
3. Then production, in this order: back up (`cash_events` is untouched, new table only) → apply migration → deploy gateway (all 12 files) → merge UI → run the backfill for the 15 existing false labels → test one export in Daybook.
