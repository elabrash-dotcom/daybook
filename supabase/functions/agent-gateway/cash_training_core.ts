// Cash Audit training data: pure helpers (no network, no database). Tested under Node; runs unchanged in Deno.
// Builds the export ZIP (stored, no compression: the JPEGs are already compressed), the folder layout and the manifest.

export const EXPORT_DEFAULT_LIMIT = 100;
export const EXPORT_MAX_LIMIT = 200;
export const EXPORT_MAX_BYTES = 40 * 1024 * 1024; // the gateway builds the ZIP in memory: stop adding images past this
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// ---- ZIP writer (PKZIP 2.0, method 0 = stored, UTF-8 names) -----------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getUTCFullYear());
  return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
}

export type ZipEntry = { name: string; data: Uint8Array };

export function buildZip(entries: ZipEntry[], when = new Date()): Uint8Array {
  const enc = new TextEncoder(), { time, date } = dosTime(when);
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: DataView, o: number, n: number) => v.setUint16(o, n, true);
  const u32 = (v: DataView, o: number, n: number) => v.setUint32(o, n >>> 0, true);
  for (const e of entries) {
    if (e.data.length >= 0xffffffff || entries.length >= 0xffff) throw new Error("zip too large");
    const name = enc.encode(e.name), crc = crc32(e.data);
    const lh = new Uint8Array(30 + name.length), lv = new DataView(lh.buffer);
    u32(lv, 0, 0x04034b50); u16(lv, 4, 20); u16(lv, 6, 0x0800); u16(lv, 8, 0); u16(lv, 10, time); u16(lv, 12, date);
    u32(lv, 14, crc); u32(lv, 18, e.data.length); u32(lv, 22, e.data.length); u16(lv, 26, name.length); u16(lv, 28, 0);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length), cv = new DataView(ch.buffer);
    u32(cv, 0, 0x02014b50); u16(cv, 4, 20); u16(cv, 6, 20); u16(cv, 8, 0x0800); u16(cv, 10, 0); u16(cv, 12, time); u16(cv, 14, date);
    u32(cv, 16, crc); u32(cv, 20, e.data.length); u32(cv, 24, e.data.length); u16(cv, 28, name.length); u16(cv, 30, 0); u16(cv, 32, 0);
    u16(cv, 34, 0); u16(cv, 36, 0); u32(cv, 38, 0); u32(cv, 42, offset);
    ch.set(name, 46);
    parts.push(lh, e.data); central.push(ch); offset += lh.length + e.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  u32(ev, 0, 0x06054b50); u16(ev, 4, 0); u16(ev, 6, 0); u16(ev, 8, entries.length); u16(ev, 10, entries.length); u32(ev, 12, cdSize); u32(ev, 16, offset); u16(ev, 20, 0);
  const all = [...parts, ...central, end], out = new Uint8Array(offset + cdSize + 22);
  let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

// ---- layout -----------------------------------------------------------------------------------------------------------------

export const slug = (s: unknown, fallback = "unknown") => {
  const t = String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return t || fallback;
};

export type Example = {
  id: string; event_id: string | null; event_uid: string; device_id: string; camera_label: string | null; store_key: string; class_name: string;
  detected_at: string; confidence: number | null; model_version: string | null; reason: string | null;
  raw_path: string | null; annotated_path: string | null; image_state: string; status: string; review_note: string | null; meta: Record<string, unknown>;
};

const sydDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

// <camera>/<YYYY-MM-DD>/<class>/<example id>/  (camera = store + camera name, date = Sydney day, class = detected object)
export function exampleDir(ex: Example): string {
  const cam = slug(ex.store_key) + "-" + slug(ex.camera_label ?? ex.device_id.slice(0, 8), "camera");
  const day = Number.isFinite(Date.parse(ex.detected_at)) ? sydDay(ex.detected_at) : "unknown-date";
  return `${cam}/${day}/${slug(ex.class_name)}/${slug(ex.event_uid, "event").slice(0, 40)}-${ex.id.slice(0, 8)}`;
}

export type FetchedFile = { bytes: Uint8Array | null; source: "original" | "archive" | null; warning?: string };

export function readmeText(total: number, included: number, truncated: boolean, filters: Record<string, string>): string {
  return `# Daybook Cash Audit: false detection examples

Each example is a camera detection that a person marked as **wrong** (false detection). Use them as hard negatives or to review
and relabel before training or fine-tuning.

## Layout
\`\`\`
<store>-<camera>/<YYYY-MM-DD>/<class>/<event>-<id>/
    raw.jpg          the original frame exactly as the camera sent it (not edited)
    annotated.jpg    the frame with the camera's boxes drawn on it
    meta.json        structured record (schema daybook.cash.false_detection/1)
manifest.jsonl       one JSON line per example (same data, flat, easy to load)
\`\`\`
A frame can be missing (the upload failed or the file expired). The example still has its metadata, and \`export.files\` and
\`export.warnings\` in meta.json say what is missing. An image from the long-term archive is a re-encoded WebP (raw.webp) and not
the original: \`export.image_source\` says which.

## meta.json fields
- \`detection\`: event id and uid, time (UTC ISO), class, confidence (0 to 1), track id, bbox and all detections (normalised 0 to 1
  when \`norm\` is true, otherwise pixels), frame width and height, confidence threshold used
- \`camera\`: device id, camera label, store
- \`model.version\`: only when the camera reported one, otherwise null
- \`feedback\`: the false-detection label, the user's reason, who and when
- \`images\`: the storage paths at the time of collection
- \`source_event\`: the camera's own JSON for the event (secrets removed)
- \`export\`: files included, image source, warnings, review status and note

## This export
${included} of ${total} matching examples${truncated ? " (limit reached: export again with a narrower filter or from the next page)" : ""}. Filters: ${Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}.
Only examples that are collected or reviewed are exported unless a status filter says otherwise. Excluded and withdrawn examples are never included by default.
`;
}

export function manifestLine(ex: Example, dir: string, files: { raw: string | null; annotated: string | null }, source: string | null, warnings: string[]): string {
  const d = (ex.meta?.detection ?? {}) as Record<string, unknown>;
  return JSON.stringify({
    example_id: ex.id, event_id: ex.event_id, event_uid: ex.event_uid, store: ex.store_key, camera: ex.camera_label, device_id: ex.device_id,
    class: ex.class_name, detected_at: ex.detected_at, confidence: ex.confidence, model_version: ex.model_version, bbox: d.bbox ?? null,
    reason: ex.reason, status: ex.status, image_state: ex.image_state, image_source: source, dir, raw: files.raw, annotated: files.annotated, warnings,
  });
}

export function extOf(path: string | null, fallback = "jpg"): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(path ?? "");
  return m ? m[1].toLowerCase() : fallback;
}

// Assemble the whole export from the examples and a function that fetches one stored file. No storage failure stops the export:
// it records a warning for that file and moves on. Returns the ZIP and a summary.
export type ExportDeps = {
  fetchFile: (ex: Example, kind: "raw" | "annotated") => Promise<FetchedFile>;
  now?: () => Date;
};
export async function assembleExport(examples: Example[], total: number, filters: Record<string, string>, deps: ExportDeps) {
  const entries: ZipEntry[] = [], lines: string[] = [], enc = new TextEncoder();
  let bytes = 0, included = 0, truncated = examples.length < total, imagesMissing = 0, imageErrors = 0;
  for (const ex of examples) {
    if (bytes >= EXPORT_MAX_BYTES) { truncated = true; break; }
    const dir = exampleDir(ex), warnings: string[] = [], files = { raw: null as string | null, annotated: null as string | null };
    let source: string | null = null;
    for (const kind of ["raw", "annotated"] as const) {
      let f: FetchedFile;
      try { f = await deps.fetchFile(ex, kind); } catch (e) { f = { bytes: null, source: null, warning: "storage error: " + (e instanceof Error ? e.message : String(e)).slice(0, 80) }; imageErrors++; }
      if (f.bytes && f.bytes.length > 0 && f.bytes.length <= MAX_IMAGE_BYTES) {
        const name = `${kind}.${f.source === "archive" ? "webp" : extOf(kind === "raw" ? ex.raw_path : ex.annotated_path)}`;
        entries.push({ name: `${dir}/${name}`, data: f.bytes }); files[kind] = name; bytes += f.bytes.length;
        source = source === "archive" || f.source === "archive" ? "archive" : "original";
      } else {
        imagesMissing++; warnings.push(f.warning ?? (f.bytes ? `${kind} frame is empty or too large` : `${kind} frame is not available`));
      }
    }
    const meta = { ...ex.meta, example_id: ex.id, export: { files, image_source: source, warnings, status: ex.status, review_note: ex.review_note, image_state_at_collection: ex.image_state } };
    entries.push({ name: `${dir}/meta.json`, data: enc.encode(JSON.stringify(meta, null, 2)) });
    lines.push(manifestLine(ex, dir, files, source, warnings)); included++;
  }
  entries.unshift({ name: "README.md", data: enc.encode(readmeText(total, included, truncated, filters)) });
  entries.splice(1, 0, { name: "manifest.jsonl", data: enc.encode(lines.join("\n") + (lines.length ? "\n" : "")) });
  return { zip: buildZip(entries, deps.now?.()), included, total, truncated, imagesMissing, imageErrors, bytes };
}
