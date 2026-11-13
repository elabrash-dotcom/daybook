# Cash Audit ingestion API (Phase 1)

Status: built and tested in isolation. **Not deployed.** Base URL once deployed:
`https://scjfvvwylrgpbrmdsjxb.supabase.co/functions/v1/agent-gateway`

## Auth
`Authorization: Bearer dvc_...` — a **camera device token**. Only its SHA-256 is stored. The token decides the owner, the device and the
store; anything the payload says about owner/store is ignored. A camera token can use `/cash/*` only (every other route returns 403), and no
other kind of device can use `/cash/*`. Revoke a token and it stops working immediately.

No RTSP URL, camera password or other secret is ever needed by or sent to this API. Keys that look like secrets, `rtsp://` URLs and
`user:pass@` URLs are stripped from the stored copy of the event JSON.

## Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET  | `/cash/ping` | Server time (compare with the device clock) and the registered store |
| POST | `/cash/events` | Send one event, an array, or `{ "events": [...] }` (max 50, max 512 KB). Idempotent |
| POST | `/cash/uploads` | `{ "event_id": "...", "kinds": ["raw","annotated","clip"] }` → short-lived signed `PUT` URLs |
| POST | `/cash/assets/confirm` | Same body; checks the files arrived, then links them to the event |

### Event JSON (tolerant; the first matching name wins)
| Meaning | Accepted names |
|---|---|
| unique id (required) | `event_id`, `eventId`, `id`, `uuid`, `event_uid` — letters, digits `. _ : -`, max 128 |
| time (required) | `detected_at`, `timestamp`, `ts`, `time`, `datetime`, `event_time`, `start_time`, `created_at`, `epoch` — ISO with offset, epoch seconds/ms, or `YYYY-MM-DD HH:MM:SS` (read as Australia/Sydney) |
| kind | `event_type`, `type`, `kind`, `category`, `class`, `label` |
| confidence | `confidence`, `conf`, `score`, `probability` — 0–1 or percent |
| track id | `track_id`, `trackId`, `tracker_id`, `tid` |
| box(es) | `bbox`/`box`/`bounding_box`, or a list under `detections`/`boxes`/`objects`/`bboxes`/`results`/`predictions`; forms `x1,y1,x2,y2`, `x,y,w,h`, `cx,cy,w,h`, `left,top,right,bottom`, or 4-number arrays; pixels or 0–1 |
| frame size | `frame_width`/`width`/`image_width`, `frame_height`/`height`/`image_height` |

Everything else is kept (scrubbed) in `raw`. Events older than 30 days or more than 10 minutes in the future are rejected.

### Responses
`/cash/events` → `{ ok, created, duplicate, rejected, results: [{ event_id, status: created|duplicate|rejected, error? }] }`
- `200`: every event is final (created, duplicate, or permanently rejected). Safe to delete from the outbox.
- `207`: some events hit a server error (`error: "could not save, try again"`). Re-send the whole batch; duplicates are harmless.
- `413` too big, `429` too many (600/min/device), `401` bad token, `403` wrong route.

### Recommended device flow
1. `POST /cash/events` with the event JSON (idempotent, retry freely).
2. `POST /cash/uploads` → `PUT` each file to its URL with the given `content_type` (max 10 MB each).
3. `POST /cash/assets/confirm`. Anything in `missing` is retried later.
Raw and annotated snapshots are separate kinds, so the Jetson can send both once it keeps a clean frame.

## Database
`cash_events`, `cash_pos_payments` (owner-only RLS; the app can read and change only `label` / `label_note`), private bucket
`cash-snapshots` with no browser policies. Migration: `supabase/migrations/20261113_cash_audit_phase1.sql`.

## Deployment order (needs approval; nothing here has been done)
1. Apply the migration to production (adds `agent_devices.store_key`, allows channel `camera`, creates the tables and the bucket).
2. Deploy `agent-gateway` with **all** files: `index.ts`, `cma.ts`, `stockwise_def.ts`, `cash.ts`, `cash_core.ts`, `cash_store.ts`.
3. Create the camera device: `POST /admin/devices {label, store_key}` with a Daybook login, or `node tools/make-device-token.mjs ...` and run the printed SQL. Put the token on the Jetson.
