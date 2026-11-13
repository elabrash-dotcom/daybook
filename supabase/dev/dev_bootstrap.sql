-- DEVELOPMENT PROJECT ONLY. Never run on production (production already has this table; the statements are no-ops there, but do not run it).
-- Minimal copy of the production table that the Cash Audit migration alters. Run this BEFORE 20261113_cash_audit_phase1.sql.
create table if not exists public.agent_devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  label text not null,
  channel text not null,
  token_hash text not null unique,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint agent_devices_channel_check check (channel = any (array['glasses'::text, 'phone'::text, 'voice'::text]))
);
alter table public.agent_devices enable row level security;
