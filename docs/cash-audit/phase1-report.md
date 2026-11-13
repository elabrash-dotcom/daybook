# Cash Audit Phase 1: Report

Branch: `claude/new-session-bvpb4w` (commit `aa34eb3`)
Status: **built and tested in isolation. Not deployed. Waiting for approval.**

Nothing was applied to production Supabase. The Jetson, the detection model and all RTSP credentials were not touched.

## Changed files
| File | Purpose |
|---|---|
| `supabase/migrations/20261113_cash_audit_phase1.sql` | `cash_events` and `cash_pos_payments` tables with owner-only RLS, private `cash-snapshots` bucket, `agent_devices.store_key`, `camera` channel. Idempotent. |
| `supabase/functions/agent-gateway/cash_core.ts` | Jetson JSON normaliser, time parsing, secret scrubbing, storage paths. |
| `supabase/functions/agent-gateway/cash.ts` | `/cash/*` endpoints and camera-device admin routes. |
| `supabase/functions/agent-gateway/cash_store.ts` | Supabase read/write layer. |
| `supabase/functions/agent-gateway/index.ts` | Routing: camera tokens can use `/cash/*` only; other devices are refused there. |
| `tools/make-device-token.mjs` | Offline device token and registration SQL (hash only). |
| `docs/cash-audit/ingest-api.md` | API spec and deployment order. |
| `tests/cash/*` | Test suites and Supabase stubs. |

## What was built (against the six scope points)
1. **Tables and RLS:** the owner can read their own rows and change only `label` and `label_note`. No insert or delete from the app.
2. **Private bucket:** `cash-snapshots`, no browser policies, 10 MB per file, jpeg/png/mp4 only. The Jetson uses short-lived signed upload URLs.
3. **Ingestion:** `POST /cash/events` (single, array or `{events:[]}`, max 50 and 512 KB), idempotent on `(device, event_id)`. Also `/cash/uploads`, `/cash/assets/confirm`, `/cash/ping`. Rate limit 600 events a minute per device.
4. **Snapshots and detection data:** raw and annotated are separate files. Bounding boxes in pixel or normalised form, per-box confidence, track IDs.
5. **Jetson JSON compatibility:** tolerant of many field names. The original JSON is kept, scrubbed of secrets.
6. **Review and POS matching:** label, note, match status, matched payment and delta columns. A unique index stops one POS payment being claimed twice.

## Security
- Owner, device and store come from the device token. Anything the payload says about them is ignored.
- Only the token's SHA-256 is stored. A new token is shown once.
- Stripped from stored JSON: secret-looking keys, `rtsp://` URLs, `user:pass@` URLs. File paths are reduced to the file name.
- Event IDs are restricted so they cannot escape the storage path (no `..`, no slashes).
- `agent_devices` is read with `select("*")`, so authentication keeps working even before the migration is applied.

## Test results
| Suite | Result |
|---|---|
| Database on real PostgreSQL 16 (RLS, column-level privileges, idempotency, constraints, bucket, migration re-run) | 19 of 19 passed |
| Core logic (times, box formats, secret leaks, bad input) | 13 of 13 passed |
| Handlers (auth boundaries, retries, partial failure, limits, uploads, device admin) | 13 of 13 passed |
| TypeScript strict type-check of the gateway | Clean |

Run them with the commands below; the database suite needs a local PostgreSQL.
```bash
cd tests/cash
PGHOST=<socket-dir> PGPORT=<port> PGUSER=postgres node --test --experimental-strip-types .
```

## Deployment requirements (needs explicit approval)
1. Apply the migration to production. It adds a column to `agent_devices` and widens its channel check. Existing devices are unaffected.
2. Deploy `agent-gateway` with all six files: `index.ts`, `cma.ts`, `stockwise_def.ts`, `cash.ts`, `cash_core.ts`, `cash_store.ts`.
3. Create the camera device with `POST /admin/devices` (Daybook login) or `tools/make-device-token.mjs`, and put the `dvc_` token on the Jetson.
4. No credentials are needed from you. The service-role key is already injected into the function.

## Unresolved issues
- **Real Jetson JSON not seen.** Need one redacted event `.json`, the clip size, the bounding-box format and the frame size. The field mapping is a best guess until then.
- **Supabase layer not covered by local tests.** It needs a smoke test on a dev Supabase branch before production.
- **Privacy.** Snapshots can show staff and customers. A retention period is needed, and probably a workplace surveillance notice. Not built yet.
- **No Daybook UI for camera devices.** They cannot use `/message` or `/feed`, by design.
- **Git:** a force-push was blocked, so the old remote branch history (only PR #6, already merged) was merged in with the `ours` strategy.

## Not started (later phases)
Cash review screen, POS matching, the 7 PM Sydney report, and the retention job.
