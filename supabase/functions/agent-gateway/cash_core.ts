// Cash Audit: pure logic (no network, no database). Tested under Node; runs unchanged in Deno.
// Turns whatever JSON the Jetson wrote for one event into the shape of a cash_events row,
// scrubs secrets from the stored copy, and builds storage paths.

export const TZ = "Australia/Sydney";
export const MAX_BATCH = 50;
export const MAX_BODY_BYTES = 512 * 1024;
export const MAX_RAW_BYTES = 64 * 1024;
export const MAX_DETECTIONS = 50;
export const MAX_AGE_MS = 30 * 86400e3;
export const MAX_FUTURE_MS = 10 * 60e3;
export const EVENT_UID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const STORE_KEY_RE = /^[a-z0-9_-]{1,40}$/;

export type Box = { x: number; y: number; w: number; h: number; norm: boolean; label?: string; confidence?: number; track_id?: string };

export type NormalEvent = {
  event_uid: string;
  detected_at: string; // ISO UTC
  device_sent_at: string | null;
  kind: string | null;
  confidence: number | null;
  track_id: string | null;
  bbox: Box | null;
  detections: Box[];
  frame_width: number | null;
  frame_height: number | null;
  raw: Record<string, unknown>;
  claimed_store: string | null;
  warnings: string[];
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const pick = (o: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
};

// ---- time ---------------------------------------------------------------------------------------------------------

// Offset (ms) of Australia/Sydney from UTC at a given instant.
function sydneyOffsetMs(utcMs: number): number {
  const p = new Intl.DateTimeFormat("en-AU", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// A wall-clock time in Sydney (no zone given) to a UTC instant. Handles daylight saving.
export function sydneyWallToUtcMs(y: number, mo: number, d: number, h: number, mi: number, s: number, ms = 0): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  let t = guess - sydneyOffsetMs(guess);
  t = guess - sydneyOffsetMs(t);
  return t;
}

export function sydneyDate(utcMs: number): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(utcMs));
  return p; // YYYY-MM-DD
}

// Accepts ISO with or without offset, epoch seconds, epoch milliseconds. Returns UTC ms, or null.
export function parseTime(v: unknown): number | null {
  if (typeof v === "number" || (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n < 1e11) return Math.round(n * 1000); // seconds
    if (n < 1e14) return Math.round(n); // milliseconds
    return null;
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) {
    const d = s.match(/^(\d{4})(\d{2})(\d{2})[T_-]?(\d{2})(\d{2})(\d{2})$/); // 20261113_142501
    if (!d) return null;
    return sydneyWallToUtcMs(+d[1], +d[2], +d[3], +d[4], +d[5], +d[6]);
  }
  const [, y, mo, da, h, mi, sec = "0", frac = "", zone] = m;
  const msPart = frac ? Math.round(Number("0." + frac) * 1000) : 0;
  if (+mo < 1 || +mo > 12 || +da < 1 || +da > 31 || +h > 23 || +mi > 59 || +sec > 60) return null;
  if (!zone) return sydneyWallToUtcMs(+y, +mo, +da, +h, +mi, +sec, msPart);
  const base = Date.UTC(+y, +mo - 1, +da, +h, +mi, +sec, msPart);
  if (/^z$/i.test(zone)) return base;
  const sign = zone[0] === "-" ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  return base - sign * (+digits.slice(0, 2) * 60 + +digits.slice(2, 4)) * 60e3;
}

// ---- secrets ------------------------------------------------------------------------------------------------------

const SECRET_KEY = /pass(word|wd)?|secret|token|rtsp|credential|api[-_ ]?key|authorization|bearer|private[-_ ]?key|cookie|session/i;
const URL_CREDS = /\b([a-z][a-z0-9+.-]*):\/\/[^\s/@"']+(?::[^\s/@"']*)?@/gi;
const RTSP_URL = /\brtsps?:\/\/[^\s"']+/gi;

export function scrubString(s: string): string {
  return s.replace(RTSP_URL, "[camera-url-removed]").replace(URL_CREDS, "$1://[removed]@");
}

function looksLikePath(s: string): boolean {
  return /^(\/|[A-Za-z]:\\)/.test(s) && s.length < 400;
}

// Copy of the Jetson JSON that is safe to keep: no secret-looking keys, no camera URLs, no passwords in URLs,
// and file paths reduced to the file name.
export function sanitizeRaw(input: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (typeof input === "string") {
    const t = scrubString(input);
    return looksLikePath(t) ? t.split(/[\\/]/).pop() : t.slice(0, 2000);
  }
  if (Array.isArray(input)) return input.slice(0, 200).map((x) => sanitizeRaw(x, depth + 1));
  if (isObj(input)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input).slice(0, 200)) {
      if (SECRET_KEY.test(k)) continue;
      out[k.slice(0, 80)] = sanitizeRaw(v, depth + 1);
    }
    return out;
  }
  return input;
}

// ---- boxes --------------------------------------------------------------------------------------------------------

function toBox(v: unknown, frameW: number | null, frameH: number | null): Box | null {
  let x: number | null = null, y: number | null = null, w: number | null = null, h: number | null = null;
  let label: string | undefined, conf: number | undefined, tid: string | undefined;
  if (Array.isArray(v)) {
    const a = v.map(num);
    if (a.length < 4 || a.slice(0, 4).some((n) => n === null)) return null;
    // [x1,y1,x2,y2] when the second pair is bigger than the first and looks like corners; else [x,y,w,h]
    const [p, q, r, s] = a as number[];
    if (r > p && s > q && (r > 1 || s > 1 || (r > p + 0.0001 && s > q + 0.0001 && r + s > 1.2))) { x = p; y = q; w = r - p; h = s - q; }
    else { x = p; y = q; w = r; h = s; }
  } else if (isObj(v)) {
    const nested = pick(v, ["bbox", "box", "bounding_box", "boundingBox", "xyxy", "xywh"]);
    if (nested !== undefined && (Array.isArray(nested) || isObj(nested))) {
      const b = toBox(nested, frameW, frameH);
      if (!b) return null;
      b.label = str(pick(v, ["label", "class", "class_name", "name", "category"]), 40) ?? b.label;
      const c = normConfidence(pick(v, ["confidence", "conf", "score", "probability"]));
      if (c !== null) b.confidence = c;
      const t = pick(v, ["track_id", "trackId", "tracker_id", "tid", "id"]);
      if (t !== undefined && (typeof t === "string" || typeof t === "number")) b.track_id = String(t).slice(0, 64);
      return b;
    }
    const x1 = num(pick(v, ["x1", "xmin", "left"])), y1 = num(pick(v, ["y1", "ymin", "top"]));
    const x2 = num(pick(v, ["x2", "xmax", "right"])), y2 = num(pick(v, ["y2", "ymax", "bottom"]));
    const cx = num(pick(v, ["cx", "center_x", "xc"])), cy = num(pick(v, ["cy", "center_y", "yc"]));
    const ww = num(pick(v, ["w", "width"])), hh = num(pick(v, ["h", "height"]));
    const xx = num(pick(v, ["x", "left"])), yy = num(pick(v, ["y", "top"]));
    if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) { x = x1; y = y1; w = x2 - x1; h = y2 - y1; }
    else if (cx !== null && cy !== null && ww !== null && hh !== null) { x = cx - ww / 2; y = cy - hh / 2; w = ww; h = hh; }
    else if (xx !== null && yy !== null && ww !== null && hh !== null) { x = xx; y = yy; w = ww; h = hh; }
    label = str(pick(v, ["label", "class", "class_name", "name", "category"]), 40) ?? undefined;
    const c = normConfidence(pick(v, ["confidence", "conf", "score", "probability"]));
    if (c !== null) conf = c;
    const t = pick(v, ["track_id", "trackId", "tracker_id", "tid"]);
    if (t !== undefined && (typeof t === "string" || typeof t === "number")) tid = String(t).slice(0, 64);
  } else return null;
  if (x === null || y === null || w === null || h === null || !(w > 0) || !(h > 0)) return null;
  const norm = x >= -0.01 && y >= -0.01 && w <= 1.01 && h <= 1.01 && x + w <= 1.05 && y + h <= 1.05;
  const r = (n: number) => Math.round(n * 10000) / 10000;
  const box: Box = { x: r(x), y: r(y), w: r(w), h: r(h), norm };
  if (!norm && frameW && frameH && (x + w > frameW * 1.05 || y + h > frameH * 1.05)) return null; // outside the frame
  if (label) box.label = label;
  if (conf !== undefined) box.confidence = conf;
  if (tid) box.track_id = tid;
  return box;
}

function str(v: unknown, max: number): string | null {
  if (typeof v === "string" && v.trim()) return v.trim().slice(0, max);
  if (typeof v === "number" && Number.isFinite(v)) return String(v).slice(0, max);
  return null;
}

function normConfidence(v: unknown): number | null {
  const n = num(v);
  if (n === null || n < 0) return null;
  const c = n > 1 ? n / 100 : n;
  return c > 1 ? null : Math.round(c * 10000) / 10000;
}

// ---- event --------------------------------------------------------------------------------------------------------

// ctx.nowMs is injectable so tests are deterministic.
export function normalizeEvent(input: unknown, ctx: { nowMs: number }): Result<NormalEvent> {
  if (!isObj(input)) return { ok: false, error: "event must be a JSON object" };
  const warnings: string[] = [];

  const uidRaw = str(pick(input, ["event_id", "eventId", "id", "uuid", "event_uid"]), 200);
  if (!uidRaw) return { ok: false, error: "event_id is required" };
  if (!EVENT_UID_RE.test(uidRaw) || uidRaw.includes("..")) return { ok: false, error: "event_id may only contain letters, digits and . _ : - (max 128, no '..')" };

  // Event time: the first alias that parses wins.
  let t: number | null = null;
  for (const k of ["detected_at", "timestamp", "ts", "time", "datetime", "event_time", "start_time", "created_at", "epoch"]) {
    if (input[k] !== undefined && input[k] !== null) { t = parseTime(input[k]); if (t !== null) break; }
  }
  if (t === null) return { ok: false, error: "no usable event time (expected detected_at / timestamp / ts as ISO text or epoch)" };
  if (t < ctx.nowMs - MAX_AGE_MS) return { ok: false, error: "event time is more than 30 days old" };
  if (t > ctx.nowMs + MAX_FUTURE_MS) return { ok: false, error: "event time is in the future (check the device clock)" };

  let sentAt: number | null = null;
  const sentRaw = pick(input, ["device_sent_at", "sent_at", "uploaded_at"]);
  if (sentRaw !== undefined) sentAt = parseTime(sentRaw);

  const frameW = (() => { const n = num(pick(input, ["frame_width", "frameWidth", "image_width", "width", "img_w"])); return n && n > 0 && n < 20000 ? Math.round(n) : null; })();
  const frameH = (() => { const n = num(pick(input, ["frame_height", "frameHeight", "image_height", "height", "img_h"])); return n && n > 0 && n < 20000 ? Math.round(n) : null; })();

  const kind = str(pick(input, ["event_type", "type", "kind", "category", "class", "label"]), 64);

  // Detections list: first array-valued alias.
  const list = pick(input, ["detections", "boxes", "objects", "bboxes", "results", "predictions"]);
  const detections: Box[] = [];
  if (Array.isArray(list)) {
    for (const d of list.slice(0, MAX_DETECTIONS)) { const b = toBox(d, frameW, frameH); if (b) detections.push(b); }
    if (list.length > MAX_DETECTIONS) warnings.push(`only the first ${MAX_DETECTIONS} detections were kept`);
    if (list.length && !detections.length) warnings.push("detections were present but no box could be read");
  }
  let bbox: Box | null = null;
  const single = pick(input, ["bbox", "box", "bounding_box", "boundingBox"]);
  if (single !== undefined) bbox = toBox(single, frameW, frameH);
  if (!bbox && detections.length) bbox = [...detections].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  if (single !== undefined && !bbox) warnings.push("bbox present but unreadable");

  let confidence = normConfidence(pick(input, ["confidence", "conf", "score", "probability"]));
  if (confidence === null && bbox?.confidence !== undefined) confidence = bbox.confidence;
  const tr = pick(input, ["track_id", "trackId", "tracker_id", "tid"]);
  let track = tr !== undefined && (typeof tr === "string" || typeof tr === "number") ? String(tr).slice(0, 64) : null;
  if (!track && bbox?.track_id) track = bbox.track_id;

  const claimed = str(pick(input, ["store", "store_key", "shop", "location", "site"]), 80);

  const clean = sanitizeRaw(input) as Record<string, unknown>;
  let rawJson = JSON.stringify(clean);
  let raw = clean;
  if (rawJson.length > MAX_RAW_BYTES) { raw = { truncated: true, note: "original JSON was larger than 64 KB" }; warnings.push("raw JSON too large, not stored"); }

  return {
    ok: true,
    value: {
      event_uid: uidRaw,
      detected_at: new Date(t).toISOString(),
      device_sent_at: sentAt === null ? null : new Date(sentAt).toISOString(),
      kind, confidence, track_id: track, bbox, detections,
      frame_width: frameW, frame_height: frameH, raw, claimed_store: claimed, warnings,
    },
  };
}

// ---- storage ------------------------------------------------------------------------------------------------------

export type AssetKind = "raw" | "annotated" | "clip";
export const ASSET_KINDS: AssetKind[] = ["raw", "annotated", "clip"];
export const ASSET_INFO: Record<AssetKind, { ext: string; mime: string; column: string; maxBytes: number }> = {
  raw: { ext: "jpg", mime: "image/jpeg", column: "snapshot_raw_path", maxBytes: 10 * 1024 * 1024 },
  annotated: { ext: "jpg", mime: "image/jpeg", column: "snapshot_annotated_path", maxBytes: 10 * 1024 * 1024 },
  clip: { ext: "mp4", mime: "video/mp4", column: "clip_path", maxBytes: 10 * 1024 * 1024 },
};

export function assetPath(ownerId: string, storeKey: string, detectedAtIso: string, eventUid: string, kind: AssetKind): string {
  const day = sydneyDate(Date.parse(detectedAtIso));
  return `${ownerId}/${storeKey}/${day}/${eventUid}/${kind}.${ASSET_INFO[kind].ext}`;
}
