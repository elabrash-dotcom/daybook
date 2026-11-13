#!/usr/bin/env node
// Makes a camera-device token OFFLINE and prints the SQL that registers it. Nothing is sent anywhere.
// Usage: node tools/make-device-token.mjs --owner <auth user uuid> --store mcc --label "Jetson MCC"
// The token is printed once for you to put on the device; only its SHA-256 goes in the database.
import { randomBytes, createHash } from "node:crypto";
const a = Object.fromEntries(process.argv.slice(2).reduce((r, x, i, all) => (x.startsWith("--") ? [...r, [x.slice(2), all[i + 1]]] : r), []));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!UUID.test(a.owner ?? "") || !/^[a-z0-9_-]{1,40}$/.test(a.store ?? "") || !a.label) {
  console.error('usage: node tools/make-device-token.mjs --owner <uuid> --store <lowercase-key> --label "Jetson MCC"'); process.exit(1);
}
const token = "dvc_" + randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
const label = a.label.replace(/'/g, "''").slice(0, 80);
console.log("TOKEN (give to the device, shown once):\n" + token + "\n");
console.log("SQL (run in the Supabase SQL editor, after the Cash Audit migration):");
console.log(`insert into public.agent_devices (owner_id, label, channel, store_key, token_hash)\nvalues ('${a.owner}', '${label}', 'camera', '${a.store}', '${hash}');`);
