// Claude Managed Agents side of the gateway: setup, StockWise OAuth, runs, chat and webhook sync.
// Uses the Anthropic key stored as the Supabase secret ANTHROPIC_AGENT_API_KEY (never sent to the browser).
import Anthropic, { toFile } from "npm:@anthropic-ai/sdk@1.7.0";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { INSTRUCTIONS, RULES_MD, SCHEDULES, SKILL_FILES } from "./stockwise_def.ts";

export const MCP_URL = "https://mcp.stockwise.store/mcp";
const SW_BASE = "https://mcp.stockwise.store";
const SW_SCOPE = "inventory:read";
const SUPA_HOST = new URL(Deno.env.get("SUPABASE_URL")!).host;
export const GATEWAY_URL = `https://${SUPA_HOST}/functions/v1/agent-gateway`;
const MODEL = "claude-haiku-5-5"; // about 1c a run; tested against Opus on the morning brief
// Only StockWise's read tools are switched on; its HR write tools stay off.
const READ_TOOLS = ["query_metrics", "list_records", "get_record", "search_inventory"];

export class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

export type Cfg = {
  skill_id?: string; rules_store_id?: string; notes_store_id?: string;
  vault_id?: string; ingest_cred_id?: string; ingest_hash?: string;
  sw_client_id?: string; sw_cred_id?: string; sw_connected_at?: string;
  oauth?: { state_hash: string; verifier: string; return_to: string; exp: number } | null;
  deployments?: Record<string, string>; schedules_on?: boolean;
  chat_session_id?: string | null; chat_last_at?: string | null; setup_at?: string;
};
export type AgentRow = {
  id: string; owner_id: string; slug: string; name: string;
  anthropic_agent_id: string | null; anthropic_environment_id: string | null; config: Cfg | null;
};

export function hasKey() { return !!Deno.env.get("ANTHROPIC_AGENT_API_KEY"); }
function client() {
  const apiKey = Deno.env.get("ANTHROPIC_AGENT_API_KEY");
  if (!apiKey) throw new HttpError(503, "Anthropic key (ANTHROPIC_AGENT_API_KEY) is not set in Supabase");
  return new Anthropic({ apiKey });
}

export async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const rand = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function saveCfg(sb: SupabaseClient, row: AgentRow, cfg: Cfg, extra: Record<string, unknown> = {}) {
  const { error } = await sb.from("agents").update({ config: cfg, ...extra }).eq("id", row.id);
  if (error) throw error;
  row.config = cfg;
  Object.assign(row, extra);
}

function memResources(cfg: Cfg) {
  return [
    { type: "memory_store" as const, memory_store_id: cfg.rules_store_id!, access: "read_only" as const,
      instructions: "Targets, trading hours and standing rules set by Idris. Read rules.md at the start of every run." },
    { type: "memory_store" as const, memory_store_id: cfg.notes_store_id!, access: "read_only" as const,
      instructions: "Notes Idris has approved. Check them before reporting." },
  ];
}
const budget = () => ({ type: "limit" as const, max_list_cost: { amount: SCHEDULES.budget_usd_cents, currency: "USD" as const } });

async function upsertMemory(c: Anthropic, storeId: string, path: string, content: string) {
  const page = await c.beta.memoryStores.memories.list(storeId, { path_prefix: path.slice(0, path.lastIndexOf("/") + 1) });
  for (const m of page.data) {
    if (m.type === "memory" && m.path === path) {
      await c.beta.memoryStores.memories.update(m.id, { memory_store_id: storeId, content });
      return;
    }
  }
  await c.beta.memoryStores.memories.create(storeId, { path, content });
}

/* ---------- setup: idempotent create-or-update of everything the agent needs ---------- */
export async function setup(sb: SupabaseClient, row: AgentRow) {
  const c = client();
  const cfg: Cfg = { ...(row.config ?? {}) };
  const done: string[] = [];

  // 1. Skill (pop-scoreboard). New version on re-run so edits to the files ship.
  const files = await Promise.all(SKILL_FILES.map((f) => toFile(f.b64 ? fromB64(f.b64) : new TextEncoder().encode(f.text ?? ""), f.path)));
  if (!cfg.skill_id) { const sk = await c.skills.create({ files }); cfg.skill_id = sk.id; done.push("skill created"); }
  else { await c.skills.versions.create(cfg.skill_id, { files }); done.push("skill updated"); }

  // 2. Memory stores: rules (seeded from agents/stockwise/memory/rules.md) + approved notes. Both read-only to the agent.
  if (!cfg.rules_store_id) {
    const s = await c.beta.memoryStores.create({ name: "StockWise rules", description: "Targets, trading hours and standing rules set by Idris." });
    cfg.rules_store_id = s.id;
  }
  await upsertMemory(c, cfg.rules_store_id, "/rules.md", RULES_MD);
  if (!cfg.notes_store_id) {
    const s = await c.beta.memoryStores.create({ name: "StockWise notes", description: "Notes Idris approved in Daybook." });
    cfg.notes_store_id = s.id;
  }
  done.push("memory ready");

  // 3. Vault + the posting key the agent uses to send cards to Daybook (replaced on every setup).
  if (!cfg.vault_id) { const v = await c.beta.vaults.create({ display_name: "StockWise agent (Daybook)" }); cfg.vault_id = v.id; }
  const token = "ing_" + rand(32);
  if (cfg.ingest_cred_id) {
    try { await c.beta.vaults.credentials.archive(cfg.ingest_cred_id, { vault_id: cfg.vault_id }); } catch (_) { /* already gone */ }
  }
  const cred = await c.beta.vaults.credentials.create(cfg.vault_id, {
    display_name: "Daybook card posting",
    auth: {
      type: "environment_variable", secret_name: "DAYBOOK_INGEST_TOKEN", secret_value: token,
      networking: { type: "limited", allowed_hosts: [SUPA_HOST] }, injection_location: { header: true, body: false },
    },
  });
  cfg.ingest_cred_id = cred.id;
  cfg.ingest_hash = await sha256hex(token);
  done.push("posting key set");

  // 4. Environment: cloud sandbox, only Daybook + the StockWise MCP server + package registries.
  const config = {
    type: "cloud" as const,
    networking: { type: "limited" as const, allowed_hosts: [SUPA_HOST], allow_mcp_servers: true, allow_package_managers: true },
    packages: { pip: ["pillow"] },
  };
  let envId = row.anthropic_environment_id;
  if (!envId) { const e = await c.beta.environments.create({ name: "stockwise-daybook", config }); envId = e.id; }
  else await c.beta.environments.update(envId, { config });

  // 5. Agent.
  const agentBody = {
    name: "StockWise",
    description: "Watches Mobiletek and MCC Eastern Creek in StockWise and posts cards to Daybook.",
    model: { id: MODEL, effort: "low" as const },
    system: INSTRUCTIONS,
    mcp_servers: [{ type: "url" as const, name: "stockwise", url: MCP_URL }],
    tools: [
      { type: "agent_toolset_20260401" as const,
        default_config: { enabled: true, permission_policy: { type: "always_allow" as const } },
        configs: [{ name: "web_search" as const, enabled: false }, { name: "web_fetch" as const, enabled: false }] },
      { type: "mcp_toolset" as const, mcp_server_name: "stockwise",
        default_config: { enabled: false, permission_policy: { type: "always_allow" as const } },
        configs: READ_TOOLS.map((name) => ({ name, enabled: true, permission_policy: { type: "always_allow" as const } })) },
    ],
    skills: [{ type: "custom" as const, skill_id: cfg.skill_id!, version: "latest" }],
  };
  let agentId = row.anthropic_agent_id;
  if (!agentId) { const a = await c.beta.agents.create(agentBody); agentId = a.id; done.push("agent created"); }
  else {
    const cur = await c.beta.agents.retrieve(agentId);
    await c.beta.agents.update(agentId, { ...agentBody, version: cur.version });
    done.push("agent updated");
  }
  await saveCfg(sb, row, cfg, { anthropic_agent_id: agentId, anthropic_environment_id: envId });

  // 6. Scheduled deployments. New ones start PAUSED until Idris switches schedules on.
  const deps: Record<string, string> = { ...(cfg.deployments ?? {}) };
  for (const r of SCHEDULES.runs) {
    const body = {
      name: `StockWise · ${r.name}`,
      agent: agentId,
      environment_id: envId,
      vault_ids: [cfg.vault_id],
      resources: memResources(cfg),
      budget: budget(),
      initial_events: [{ type: "user.message" as const, content: [{ type: "text" as const, text: r.prompt }] }],
      schedule: { type: "cron" as const, expression: r.cron, timezone: SCHEDULES.timezone },
      metadata: { label: r.label, daybook_agent: row.slug },
    };
    if (deps[r.label]) await c.beta.deployments.update(deps[r.label], body);
    else {
      const d = await c.beta.deployments.create(body);
      deps[r.label] = d.id;
      if (!cfg.schedules_on) await c.beta.deployments.pause(d.id);
    }
  }
  cfg.deployments = deps;
  cfg.setup_at = new Date().toISOString();
  await saveCfg(sb, row, cfg);
  done.push(`${SCHEDULES.runs.length} schedules ready (${cfg.schedules_on ? "on" : "paused"})`);
  return done;
}

export async function setSchedules(sb: SupabaseClient, row: AgentRow, on: boolean) {
  const c = client();
  const cfg: Cfg = { ...(row.config ?? {}) };
  for (const id of Object.values(cfg.deployments ?? {})) {
    const d = await c.beta.deployments.retrieve(id);
    if (on && d.status === "paused") await c.beta.deployments.unpause(id);
    if (!on && d.status === "active") await c.beta.deployments.pause(id);
  }
  cfg.schedules_on = on;
  await saveCfg(sb, row, cfg);
}

export async function scheduleList(row: AgentRow) {
  const cfg = row.config ?? {};
  const out: { label: string; name: string; cron: string; status: string; next: string | null }[] = [];
  const c = hasKey() ? client() : null;
  for (const r of SCHEDULES.runs) {
    const id = cfg.deployments?.[r.label];
    let status = id ? "unknown" : "not set up", next: string | null = null;
    if (id && c) {
      try { const d = await c.beta.deployments.retrieve(id); status = d.status; next = d.schedule?.upcoming_runs_at?.[0] ?? null; }
      catch (_) { status = "error"; }
    }
    out.push({ label: r.label, name: r.name, cron: r.cron, status, next });
  }
  return out;
}

/* ---------- StockWise OAuth (authorization code + PKCE, public client) ---------- */
export async function oauthStart(sb: SupabaseClient, row: AgentRow, returnTo: string) {
  const cfg: Cfg = { ...(row.config ?? {}) };
  const redirect = GATEWAY_URL + "/oauth/callback";
  if (!cfg.sw_client_id) {
    const r = await fetch(SW_BASE + "/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Daybook StockWise agent", redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
        token_endpoint_auth_method: "none", scope: SW_SCOPE,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.client_id) throw new HttpError(502, "StockWise did not accept the app registration");
    cfg.sw_client_id = j.client_id;
  }
  const state = rand(24), verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  cfg.oauth = { state_hash: await sha256hex(state), verifier, return_to: returnTo, exp: Date.now() + 15 * 60e3 };
  await saveCfg(sb, row, cfg);
  const u = new URL(SW_BASE + "/oauth/authorize");
  u.search = new URLSearchParams({
    response_type: "code", client_id: cfg.sw_client_id!, redirect_uri: redirect, scope: SW_SCOPE,
    state, code_challenge: challenge, code_challenge_method: "S256", resource: MCP_URL,
  }).toString();
  return u.toString();
}

export async function oauthCallback(sb: SupabaseClient, code: string, state: string) {
  const hash = await sha256hex(state);
  const { data } = await sb.from("agents").select("id, owner_id, slug, name, anthropic_agent_id, anthropic_environment_id, config")
    .eq("config->oauth->>state_hash", hash).maybeSingle();
  const row = data as AgentRow | null;
  const p = row?.config?.oauth;
  if (!row || !p || p.exp < Date.now()) throw new HttpError(400, "This StockWise sign-in link has expired. Tap Connect StockWise again.");
  const cfg: Cfg = { ...(row.config ?? {}) };
  const r = await fetch(SW_BASE + "/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, redirect_uri: GATEWAY_URL + "/oauth/callback",
      client_id: cfg.sw_client_id!, code_verifier: p.verifier, resource: MCP_URL,
    }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new HttpError(502, "StockWise sign-in failed. Try again.");
  const c = client();
  if (!cfg.vault_id) { const v = await c.beta.vaults.create({ display_name: "StockWise agent (Daybook)" }); cfg.vault_id = v.id; }
  if (cfg.sw_cred_id) {
    try { await c.beta.vaults.credentials.archive(cfg.sw_cred_id, { vault_id: cfg.vault_id }); } catch (_) { /* already gone */ }
  }
  const cred = await c.beta.vaults.credentials.create(cfg.vault_id, {
    display_name: "StockWise (read only)",
    auth: {
      type: "mcp_oauth", mcp_server_url: MCP_URL, access_token: t.access_token,
      expires_at: t.expires_in ? new Date(Date.now() + Number(t.expires_in) * 1000).toISOString() : null,
      refresh: t.refresh_token ? {
        client_id: cfg.sw_client_id!, refresh_token: t.refresh_token, token_endpoint: SW_BASE + "/oauth/token",
        token_endpoint_auth: { type: "none" }, resource: MCP_URL, scope: SW_SCOPE,
      } : null,
    },
  });
  cfg.sw_cred_id = cred.id;
  cfg.sw_connected_at = new Date().toISOString();
  const returnTo = p.return_to;
  cfg.oauth = null;
  await saveCfg(sb, row, cfg);
  return returnTo;
}

/* ---------- runs ---------- */
export async function runNow(sb: SupabaseClient, row: AgentRow, label: string) {
  const id = row.config?.deployments?.[label];
  if (!id) throw new HttpError(409, "Set up the agent first");
  if (!row.config?.sw_cred_id) throw new HttpError(409, "Connect StockWise first");
  const run = await client().beta.deployments.run(id);
  if (!run.session_id) throw new HttpError(502, "Run did not start: " + (run.error?.message ?? "unknown error"));
  const { data, error } = await sb.from("agent_runs").upsert({
    owner_id: row.owner_id, agent_id: row.id, trigger: "manual", schedule_label: label, status: "running",
    session_id: run.session_id, started_at: new Date().toISOString(),
  }, { onConflict: "session_id" }).select("id, session_id").single();
  if (error) throw error;
  return data;
}

// One-off cost/quality test: same prompt as a schedule, but on a cheaper model. Nothing else changes (agent and schedules stay as they are).
const TEST_MODELS: Record<string, { id: "claude-haiku-5-5" | "claude-sonnet-5-5"; effort: "low" | "medium" }> = {
  haiku: { id: "claude-haiku-5-5", effort: "low" },
  sonnet: { id: "claude-sonnet-5-5", effort: "low" },
};
export async function runTest(sb: SupabaseClient, row: AgentRow, label: string, modelKey: string) {
  const m = TEST_MODELS[modelKey];
  const sched = SCHEDULES.runs.find((r) => r.label === label);
  if (!m || !sched) throw new HttpError(400, "unknown test");
  const cfg = row.config ?? {};
  if (!row.anthropic_agent_id || !row.anthropic_environment_id || !cfg.rules_store_id) throw new HttpError(409, "Set up the agent first");
  if (!cfg.sw_cred_id) throw new HttpError(409, "Connect StockWise first");
  const s = await client().beta.sessions.create({
    agent: { type: "agent_with_overrides", id: row.anthropic_agent_id, model: m },
    environment_id: row.anthropic_environment_id, vault_ids: [cfg.vault_id!], resources: memResources(cfg), budget: budget(),
    title: `StockWise · ${sched.name} · ${modelKey} test`, metadata: { kind: "test", model: modelKey, daybook_agent: row.slug },
    initial_events: [{ type: "user.message", content: [{ type: "text", text: `[${modelKey.toUpperCase()} TEST] Start every card headline with "${modelKey.toUpperCase()}: ". ` + sched.prompt }] }],
  });
  const { data, error } = await sb.from("agent_runs").insert({
    owner_id: row.owner_id, agent_id: row.id, trigger: "manual", schedule_label: `${label}-${modelKey}`, status: "running",
    session_id: s.id, started_at: new Date().toISOString(),
  }).select("id, session_id").single();
  if (error) throw error;
  return data;
}

export async function sendChat(sb: SupabaseClient, row: AgentRow, text: string) {
  if (!row.anthropic_agent_id || !row.anthropic_environment_id) throw new HttpError(409, "Set up the agent first");
  const c = client();
  const cfg: Cfg = { ...(row.config ?? {}) };
  const ev = { events: [{ type: "user.message" as const, content: [{ type: "text" as const, text }] }] };
  if (cfg.chat_session_id) {
    try { await c.beta.sessions.events.send(cfg.chat_session_id, ev); return cfg.chat_session_id; }
    catch (_) { /* session ended or reached its cap: start a fresh one below */ }
  }
  const s = await c.beta.sessions.create({
    agent: row.anthropic_agent_id, environment_id: row.anthropic_environment_id, vault_ids: [cfg.vault_id!],
    resources: memResources(cfg), budget: budget(), title: "StockWise chat (Daybook)", metadata: { kind: "chat", daybook_agent: row.slug },
  });
  cfg.chat_session_id = s.id;
  await saveCfg(sb, row, cfg);
  await sb.from("agent_runs").upsert({
    owner_id: row.owner_id, agent_id: row.id, trigger: "chat", schedule_label: "chat", status: "running",
    session_id: s.id, started_at: new Date().toISOString(),
  }, { onConflict: "session_id" });
  await c.beta.sessions.events.send(s.id, ev);
  return s.id;
}

/* ---------- webhook: keep agent_runs (status + cost) and chat replies in sync ---------- */
export function unwrapWebhook(body: string, headers: Headers) {
  const key = Deno.env.get("ANTHROPIC_WEBHOOK_SIGNING_KEY");
  if (!key) throw new HttpError(503, "webhook signing key not set");
  const h: Record<string, string> = {};
  headers.forEach((v, k) => { h[k] = v; });
  return client().beta.webhooks.unwrap(body, { headers: h, key });
}

export async function handleWebhook(sb: SupabaseClient, type: string, id: string) {
  if (type.startsWith("session.status_")) return syncSession(sb, id);
  if (type === "deployment_run.succeeded" || type === "deployment_run.failed") {
    const run = await client().beta.deploymentRuns.retrieve(id);
    if (run.session_id) return syncSession(sb, run.session_id);
    const { data: rows } = await sb.from("agents").select("id, owner_id, config");
    const row = (rows ?? []).find((r) => Object.values((r.config as Cfg)?.deployments ?? {}).includes(run.deployment_id));
    if (row) {
      const label = Object.entries((row.config as Cfg).deployments ?? {}).find(([, v]) => v === run.deployment_id)?.[0] ?? null;
      await sb.from("agent_runs").insert({
        owner_id: row.owner_id, agent_id: row.id, trigger: "schedule", schedule_label: label, status: "failed",
        started_at: run.created_at, finished_at: run.created_at, error: (run.error?.message ?? "run did not start").slice(0, 500),
      });
    }
  }
}

export async function syncSession(sb: SupabaseClient, sessionId: string) {
  const c = client();
  const s = await c.beta.sessions.retrieve(sessionId);
  const { data } = await sb.from("agents").select("id, owner_id, slug, name, anthropic_agent_id, anthropic_environment_id, config")
    .eq("anthropic_agent_id", s.agent.id).maybeSingle();
  const row = data as AgentRow | null;
  if (!row) return;
  const cfg: Cfg = row.config ?? {};
  const isChat = s.metadata?.kind === "chat";
  const label = isChat ? "chat" : s.metadata?.kind === "test" ? `test-${s.metadata.model}` : Object.entries(cfg.deployments ?? {}).find(([, v]) => v === s.deployment_id)?.[0] ?? null;

  // Latest events (newest first) tell us why the session went idle, and hold chat replies.
  const page = await c.beta.sessions.events.list(sessionId, { order: "desc", limit: 100 });
  const events = page.data;
  let status = "running", error: string | null = null;
  if (s.status === "idle" || s.status === "terminated") {
    const idle = events.find((e) => e.type === "session.status_idle");
    const why = idle && idle.type === "session.status_idle" ? idle.stop_reason.type : (s.status === "terminated" ? "end_turn" : "");
    if (why === "end_turn") status = "done";
    else if (why === "budget_reached") { status = "failed"; error = `Stopped at the US$${Number(SCHEDULES.budget_usd_cents) / 100} cap`; }
    else if (why === "retries_exhausted" || why === "refusal") { status = "failed"; error = why === "refusal" ? "The model declined this run" : "Run failed after retries"; }
  }
  const cents = Number(s.usage?.list_cost?.amount ?? 0);
  const { data: existing } = await sb.from("agent_runs").select("id, status, started_at").eq("session_id", sessionId).maybeSingle();
  const patch: Record<string, unknown> = {
    owner_id: row.owner_id, agent_id: row.id, session_id: sessionId, status, cost_usd: cents / 100, error,
    finished_at: status === "running" ? null : new Date().toISOString(),
  };
  let run: { id: string; started_at: string } | null = null;
  if (existing) {
    const { data: u, error: ue } = await sb.from("agent_runs").update(patch).eq("id", existing.id).select("id, started_at").single();
    if (ue) throw ue;
    run = u;
  } else {
    const { data: i, error: ie } = await sb.from("agent_runs")
      .insert({ ...patch, trigger: isChat ? "chat" : "schedule", schedule_label: label, started_at: s.created_at }).select("id, started_at").single();
    if (ie) throw ie;
    run = i;
  }

  if (!isChat && status !== "running" && run && existing?.status !== status) {
    // Link this run's cards to it.
    await sb.from("agent_cards").update({ run_id: run.id }).eq("agent_id", row.id).is("run_id", null).gte("created_at", run.started_at);
    if (error) {
      await sb.from("agent_cards").insert({
        owner_id: row.owner_id, agent_id: row.id, run_id: run.id, kind: "alert", severity: "watch", shop: null,
        headline: `${row.name}: ${label ?? "run"} stopped`.slice(0, 80), glance: error.slice(0, 280),
        summary: `${error}. Cost so far US$${(cents / 100).toFixed(2)}.`,
      });
    }
  }

  if (isChat) {
    // Save new agent replies to agent_messages (deduped by time + text).
    const since = cfg.chat_last_at ?? "";
    const replies = events.filter((e) => e.type === "agent.message" && e.processed_at > since).reverse();
    let last = since;
    for (const e of replies) {
      if (e.type !== "agent.message") continue;
      const text = e.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      if (!text) continue;
      const { data: dup } = await sb.from("agent_messages").select("id").eq("agent_id", row.id).eq("role", "agent").eq("created_at", e.processed_at).maybeSingle();
      if (!dup) await sb.from("agent_messages").insert({ owner_id: row.owner_id, agent_id: row.id, role: "agent", channel: "daybook", content: text.slice(0, 20000), created_at: e.processed_at });
      if (e.processed_at > last) last = e.processed_at;
    }
    if (last !== since) await saveCfg(sb, row, { ...cfg, chat_last_at: last });
  }
}

/* ---------- approved memory notes are written by the gateway, never by the agent ---------- */
export async function saveNote(row: AgentRow, title: string, text: string) {
  const store = row.config?.notes_store_id;
  if (!store) throw new HttpError(409, "Set up the agent first");
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "note";
  const day = new Date().toISOString().slice(0, 10);
  await client().beta.memoryStores.memories.create(store, { path: `/notes/${day}-${slug}-${rand(3)}.md`, content: `# ${title}\n\n${text}\n` });
}

/* Self-heal: refresh runs still marked "running" (a webhook can be missed). Called when the Setup tab opens. */
export async function healRuns(sb: SupabaseClient, row: AgentRow) {
  if (!hasKey()) return 0;
  const { data } = await sb.from("agent_runs").select("session_id").eq("agent_id", row.id).eq("status", "running")
    .not("session_id", "is", null).order("created_at", { ascending: false }).limit(5);
  let n = 0;
  for (const r of data ?? []) {
    try { await syncSession(sb, r.session_id as string); n++; } catch (e) { console.error("heal failed", r.session_id, e instanceof Error ? e.message : e); }
  }
  return n;
}
