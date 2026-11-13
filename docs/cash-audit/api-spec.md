# Cash Audit device API: specification for the Jetson uploader

Version 1.0 (Phase 1 + Phase 2). Owner: Daybook. Consumer: the Jetson uploader (GPT Work).
**Status: built and tested locally. Not deployed.** The base URL below only works after Idris approves deployment.

Base URL: `https://scjfvvwylrgpbrmdsjxb.supabase.co/functions/v1/agent-gateway`
All bodies are JSON (`Content-Type: application/json`) except the file uploads. All times in responses are UTC ISO-8601.

## 1. Authentication
Header on every call to the base URL: `Authorization: Bearer dvc_<43 characters>`

- One token per Jetson. It is created by Daybook (`POST /admin/devices`, or `tools/make-device-token.mjs`) and shown **once**. Store it in a root-only file or environment variable on the device (mode 600). Never log it.
- The token fixes the owner, the device and the **store**. Any owner/store field in the event body is ignored.
- A camera token can call `/cash/*` only. Everything else returns `403`.
- Revoked token → `401` immediately. On `401` the uploader must stop retrying, keep its outbox, and raise an alert (a human must issue a new token).
- Do **not** send, store or log RTSP URLs, camera passwords or the token inside event JSON. The server strips secret-looking fields and `rtsp://` URLs anyway, but do not rely on that.
- No other credential is needed. The file upload URLs in step 3 carry their own short-lived signature and need **no** Authorization header.

## 2. Upload sequence (per event)
```
1. POST /cash/events          event JSON (idempotent)            -> created | duplicate
2. POST /cash/uploads         {event_id, kinds}                  -> signed PUT URLs
3. PUT  <url>                 raw bytes, one request per file    -> 200
4. POST /cash/assets/confirm  {event_id, kinds}                  -> confirmed | missing
```
- Step 1 always comes first; steps 2–4 need the event to exist.
- Steps 2–4 may happen later (minutes or hours) and may be retried. Signed URLs live 2 hours; ask again after that.
- An event is **finished** when step 1 returned `created`/`duplicate` and step 4 returned every wanted kind in `confirmed`. Only then delete it from the local outbox.
- Send raw and annotated as separate files. If only one snapshot exists (old events), send it as `annotated` (alias `snapshot`).

### Health check: `GET /cash/ping`
```json
{ "ok": true, "server_time": "2026-11-13T05:00:00.000Z", "store_key": "mcc" }
```
Call at start-up and hourly. If `|server_time − device clock| > 60 s`, log a warning (events are timestamped by the device clock).

## 3. Endpoints

### 3.1 `POST /cash/events`
Body: one event object, an array, or `{ "events": [ ... ] }`. Max **50 events** and **512 KB** per request.

Recommended event (the server also accepts the aliases in section 5):
```json
{
  "event_id": "20261113T150102-0001",
  "detected_at": "2026-11-13T15:01:02.250+11:00",
  "event_type": "cash_handover",
  "confidence": 0.91,
  "track_id": 17,
  "frame_width": 1920,
  "frame_height": 1080,
  "detections": [
    { "label": "cash", "confidence": 0.91, "track_id": 17, "bbox": { "x1": 812, "y1": 430, "x2": 1011, "y2": 560 } }
  ],
  "device_sent_at": "2026-11-13T15:01:05+11:00"
}
```
Response `200`:
```json
{ "ok": true, "created": 1, "duplicate": 0, "rejected": 0,
  "results": [ { "event_id": "20261113T150102-0001", "status": "created" } ] }
```
`status` per event: `created`, `duplicate` (already stored; the stored copy is **not** changed), or `rejected` (permanent, with `error`; may include `warnings` on created ones).

| HTTP | Meaning | Uploader action |
|---|---|---|
| 200 | every event is final (created, duplicate, or rejected for a validation reason) | drop created/duplicate from the outbox; log + quarantine `rejected` (do not retry them) |
| 207 | some events hit a server error: `ok:false`, their `error` is `"could not save, try again"` | re-send the same batch; already stored ones come back as `duplicate` |
| 400 | body is not JSON / empty | fix the code; do not retry |
| 401 | bad or revoked token | stop, alert |
| 403 | wrong route for a camera token | fix the code |
| 413 | more than 50 events or over 512 KB | split the batch |
| 429 | more than 600 events/min for this device | wait, then retry with backoff |
| 5xx / network error | server or network trouble | retry with backoff |

Validation rules (permanent rejections): `event_id` required, letters/digits/`. _ : -` only, 1–128 chars, no `..`; a usable time is required; time not older than 30 days or more than 10 minutes in the future.

### 3.2 `POST /cash/uploads`
```json
{ "event_id": "20261113T150102-0001", "kinds": ["raw", "annotated", "clip"] }
```
`kinds` optional (default all three). Allowed: `raw`, `annotated` (alias `snapshot`), `clip`.
Response `200`:
```json
{ "ok": true, "event_id": "20261113T150102-0001", "expires_in_seconds": 7200,
  "uploads": {
    "raw":       { "method": "PUT", "url": "https://…/object/upload/sign/cash-snapshots/…?token=…", "content_type": "image/jpeg", "max_bytes": 10485760, "path": "…/raw.jpg" },
    "annotated": { "method": "PUT", "url": "…", "content_type": "image/jpeg", "max_bytes": 10485760, "path": "…/annotated.jpg" },
    "clip":      { "method": "PUT", "url": "…", "content_type": "video/mp4",  "max_bytes": 10485760, "path": "…/clip.mp4" } } }
```
`404 { "ok": false, "error": "unknown event_id: send the event first" }` if step 1 has not succeeded. `400` for an invalid kind.

### 3.3 `PUT <uploads.<kind>.url>`
- Body: the raw file bytes. Header `Content-Type` must equal the returned `content_type` (`image/jpeg` or `video/mp4`).
- Max **10 MB** per file. A clip over 10 MB must be re-encoded smaller or skipped (do not send partial data); events and snapshots do not depend on the clip.
- Overwriting is allowed, so a retry of the same URL is safe.
- `200` = stored. `403` = link expired or tampered → request new links (3.2). `413` = too large. `415` = wrong content type.

### 3.4 `POST /cash/assets/confirm`
Same body as 3.2. Checks the files exist (size > 0, ≤ 10 MB) and links them to the event.
```json
{ "ok": false, "event_id": "20261113T150102-0001", "confirmed": ["raw", "annotated"], "missing": ["clip"] }
```
Always HTTP `200` for a known event. `ok` is true only when `missing` is empty. Safe to call repeatedly.

## 4. Retry and backoff (required behaviour)
- Keep a persistent local outbox (the existing event folder is fine). Never delete an event or its files before it is finished (section 2).
- Retry network errors, `5xx`, `429` and `207` with exponential backoff: 2 s, 4 s, 8 s … capped at 5 minutes, plus random jitter of up to 25 %.
- Never retry `400`, `403`, `413` (split first), or per-event `rejected`. Never loop on `401`.
- Send events in order, in batches of up to 50. If a batch gets `429`, pause the whole uploader, not just that batch.
- Run uploads in the background. Detection must never wait on the network. If the outbox grows past the local disk budget, drop the oldest **clips** first, then oldest raw snapshots; keep event JSON as long as possible.
- Re-sending is always safe: the server de-duplicates on (device, `event_id`).

## 5. Field names the server accepts
The first name present wins. Use the canonical (first) name.

| Meaning | Names |
|---|---|
| id (required) | `event_id`, `eventId`, `id`, `uuid`, `event_uid` |
| time (required) | `detected_at`, `timestamp`, `ts`, `time`, `datetime`, `event_time`, `start_time`, `created_at`, `epoch` |
| type | `event_type`, `type`, `kind`, `category`, `class`, `label` |
| confidence | `confidence`, `conf`, `score`, `probability` (0–1, or percent) |
| track id | `track_id`, `trackId`, `tracker_id`, `tid` |
| boxes | `detections` / `boxes` / `objects` / `bboxes` / `results` / `predictions` (list), or a single `bbox` / `box` / `bounding_box` |
| frame size | `frame_width` / `width` / `image_width`, `frame_height` / `height` / `image_height` |

Time formats: ISO-8601 with offset or `Z` (preferred), epoch seconds, epoch milliseconds, or `YYYY-MM-DD HH:MM:SS` (read as Australia/Sydney, daylight saving aware). Always send the offset.
Box formats: `{x1,y1,x2,y2}`, `{x,y,w,h}`, `{cx,cy,w,h}`, `{left,top,right,bottom}` or `[x1,y1,x2,y2]`, in **pixels of the raw frame** (preferred, with `frame_width`/`frame_height`) or normalised 0–1. State which in the docs you give Idris; the server decides by value range.
Anything else in the JSON is kept (secrets removed) in `raw` for later use.

## 6. File naming and content
- `raw`: the clean frame, **before** any drawing. `annotated`: the same frame with boxes drawn. Both JPEG, same pixel size if possible (the review screen overlays boxes on the raw frame using `frame_width`/`frame_height`).
- Files are stored server-side as `<owner>/<store>/<Sydney date>/<event_id>/<kind>.<ext>`; the uploader never chooses paths.

## 7. Limits
| Item | Limit |
|---|---|
| events per request | 50 |
| request body | 512 KB |
| events per device per minute | 600 |
| stored raw JSON per event | 64 KB (larger is replaced by a note; event still saved) |
| detections kept per event | 50 |
| file size | 10 MB each (jpeg, png, mp4) |
| signed upload link | 2 hours |
| event age accepted | 30 days past, 10 minutes future |

## 8. Examples
```bash
TOKEN=dvc_xxxxxxxx; BASE=https://scjfvvwylrgpbrmdsjxb.supabase.co/functions/v1/agent-gateway
curl -sS "$BASE/cash/ping" -H "Authorization: Bearer $TOKEN"

curl -sS -X POST "$BASE/cash/events" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"event_id":"E1","detected_at":"2026-11-13T15:01:02+11:00","confidence":0.91,"track_id":17}'

curl -sS -X POST "$BASE/cash/uploads" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"event_id":"E1","kinds":["raw","annotated"]}'
# then, for each returned url (no Authorization header):
curl -sS -X PUT "<url from response>" -H "Content-Type: image/jpeg" --data-binary @raw.jpg

curl -sS -X POST "$BASE/cash/assets/confirm" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"event_id":"E1","kinds":["raw","annotated"]}'
```
```python
import requests, time, random
def post(path, body, tries=8):
    for n in range(tries):
        try:
            r = requests.post(BASE + path, json=body, headers={"Authorization": "Bearer " + TOKEN}, timeout=20)
            if r.status_code in (200,) or r.status_code in (400, 403, 404, 413): return r
            if r.status_code == 401: raise SystemExit("token revoked: stop and alert")
        except requests.RequestException: pass
        time.sleep(min(300, 2 ** (n + 1)) * (1 + random.random() * 0.25))
    return None
```

## 9. What this API does not do (yet)
No POS matching on the device, no reading of labels, no deletion. Daybook handles review labels and (later) matching to StockWise sales.

## 10. Verified vs not yet verified
| Verified (automated, local) | Not yet verified |
|---|---|
| The full sequence over real HTTP against real PostgreSQL with the real migration: auth boundaries, idempotency, upload/confirm, signature and expiry behaviour of an emulated storage. The 207, 413 and 429 paths are covered by the handler tests (in-memory store) | The real Supabase Storage signed-upload call (raw-body `PUT` with `Content-Type`). Must be run once against a **development** Supabase project before production |
