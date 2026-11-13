-- Cash Audit, Phase 1: event ingestion tables, review labels, POS-matching columns, private snapshot bucket.
--
-- STATUS: written and tested on a local PostgreSQL only. NOT applied to production.
-- Safe to run more than once (idempotent). Apply this BEFORE deploying the agent-gateway code that uses it.
--
-- What it touches in existing production objects:
--   * public.agent_devices: adds column store_key, and widens the channel check to allow 'camera'.
--   * storage.buckets: adds the private bucket 'cash-snapshots'.
-- Everything else is new.

-- 1. Devices: allow camera devices and remember which store each one belongs to ------------------------------------
alter table public.agent_devices add column if not exists store_key text;

alter table public.agent_devices drop constraint if exists agent_devices_channel_check;
alter table public.agent_devices add constraint agent_devices_channel_check
  check (channel = any (array['glasses'::text, 'phone'::text, 'voice'::text, 'camera'::text]));

alter table public.agent_devices drop constraint if exists agent_devices_store_key_check;
alter table public.agent_devices add constraint agent_devices_store_key_check
  check (store_key is null or store_key ~ '^[a-z0-9_-]{1,40}$');

alter table public.agent_devices drop constraint if exists agent_devices_camera_needs_store;
alter table public.agent_devices add constraint agent_devices_camera_needs_store
  check (channel <> 'camera' or store_key is not null);

-- 2. POS cash payments (filled in by the 7 PM agent run in a later phase) ----------------------------------------------
create table if not exists public.cash_pos_payments (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  store_id      uuid not null,                       -- StockWise store id
  store_key     text not null check (store_key ~ '^[a-z0-9_-]{1,40}$'),
  source        text not null check (source in ('invoice', 'ticket')),
  source_uuid   text not null,                       -- StockWise record id
  source_ref    text not null,                       -- invoice_id (e.g. I31Q60) or ticket_number
  payment_ref   text not null default '',            -- due_payments[].id for ticket payments, '' for a normal sale
  paid_at       timestamptz not null,                -- invoice created_at, or ticket due_payments[].paid_at
  business_date date not null,                       -- Australia/Sydney calendar day of paid_at
  cash_amount   numeric(12, 2) not null check (cash_amount >= 0),
  bank_amount   numeric(12, 2) not null default 0 check (bank_amount >= 0),
  total_amount  numeric(12, 2),
  payment_method text,
  staff         text,
  raw           jsonb not null default '{}'::jsonb check (jsonb_typeof(raw) = 'object'),
  fetched_at    timestamptz not null default now(),
  constraint cash_pos_payments_key unique (owner_id, source, source_uuid, payment_ref)
);
create index if not exists cash_pos_payments_store_time on public.cash_pos_payments (owner_id, store_id, paid_at desc);
create index if not exists cash_pos_payments_day on public.cash_pos_payments (owner_id, business_date, store_key);

-- 3. Cash events from the Jetson ------------------------------------------------------------------------------------
create table if not exists public.cash_events (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  device_id     uuid not null references public.agent_devices (id) on delete restrict,
  store_key     text not null check (store_key ~ '^[a-z0-9_-]{1,40}$'),

  -- identity and timing
  event_uid     text not null check (event_uid ~ '^[A-Za-z0-9._:-]{1,128}$' and event_uid not like '%..%'),   -- the Jetson's event_id
  detected_at   timestamptz not null,
  device_sent_at timestamptz,                         -- device clock at upload time (to spot clock drift)
  received_at   timestamptz not null default now(),   -- server clock at ingestion

  -- detection data
  kind          text check (kind is null or char_length(kind) <= 64),
  confidence    real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  track_id      text check (track_id is null or char_length(track_id) <= 64),
  bbox          jsonb check (bbox is null or jsonb_typeof(bbox) = 'object'),       -- primary box {x,y,w,h,norm,fmt}
  detections    jsonb not null default '[]'::jsonb check (jsonb_typeof(detections) = 'array'),
  frame_width   integer check (frame_width is null or frame_width > 0),
  frame_height  integer check (frame_height is null or frame_height > 0),
  raw           jsonb not null default '{}'::jsonb check (jsonb_typeof(raw) = 'object'),  -- sanitised original JSON

  -- storage objects inside the private 'cash-snapshots' bucket (always under '<owner_id>/')
  snapshot_raw_path       text check (snapshot_raw_path       is null or snapshot_raw_path       like owner_id::text || '/%'),
  snapshot_annotated_path text check (snapshot_annotated_path is null or snapshot_annotated_path like owner_id::text || '/%'),
  clip_path               text check (clip_path               is null or clip_path               like owner_id::text || '/%'),
  assets_confirmed_at     timestamptz,

  -- POS matching (filled in by a later phase)
  match_status  text not null default 'pending' check (match_status in ('pending', 'matched', 'unmatched', 'ignored')),
  matched_payment_id uuid references public.cash_pos_payments (id) on delete set null,
  match_delta_seconds numeric(10, 1),
  matched_at    timestamptz,
  match_method  text check (match_method is null or char_length(match_method) <= 40),

  -- manual review
  label         text check (label is null or label in ('confirmed_cash', 'false_detection', 'unsure', 'other')),
  label_note    text check (label_note is null or char_length(label_note) <= 500),
  labelled_at   timestamptz,
  labelled_by   uuid,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint cash_events_device_event unique (device_id, event_uid),
  constraint cash_events_match_consistent check (match_status <> 'matched' or matched_payment_id is not null)
);
create index if not exists cash_events_owner_time  on public.cash_events (owner_id, detected_at desc);
create index if not exists cash_events_store_time  on public.cash_events (owner_id, store_key, detected_at desc);
create index if not exists cash_events_to_review   on public.cash_events (owner_id, detected_at desc) where label is null;
create index if not exists cash_events_unmatched   on public.cash_events (owner_id, store_key, detected_at desc) where match_status in ('pending', 'unmatched');
create index if not exists cash_events_device_time on public.cash_events (device_id, received_at desc);
-- a POS payment can be claimed by only one event
create unique index if not exists cash_events_one_event_per_payment on public.cash_events (matched_payment_id) where matched_payment_id is not null;

-- 4. Triggers: keep updated_at fresh, and stamp who/when for manual labels ----------------------------------------------
create or replace function public.cash_events_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.label is distinct from old.label or new.label_note is distinct from old.label_note then
    if new.label is null and new.label_note is null then
      new.labelled_at := null;
      new.labelled_by := null;
    else
      new.labelled_at := now();
      new.labelled_by := (select auth.uid());
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.cash_events_before_update() from public, anon, authenticated;

drop trigger if exists cash_events_before_update on public.cash_events;
create trigger cash_events_before_update before update on public.cash_events
  for each row execute function public.cash_events_before_update();

-- 5. Row level security -----------------------------------------------------------------------------------------------
-- The gateway writes with the service role (bypasses RLS). A signed-in Daybook user can only READ their own rows and
-- change the review label and note of their own events. Nothing can be inserted or deleted from the app.
alter table public.cash_events       enable row level security;
alter table public.cash_pos_payments enable row level security;

revoke all on public.cash_events, public.cash_pos_payments from anon, authenticated;
grant select on public.cash_events, public.cash_pos_payments to authenticated;
grant update (label, label_note) on public.cash_events to authenticated;

drop policy if exists cash_events_select on public.cash_events;
create policy cash_events_select on public.cash_events
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists cash_events_label on public.cash_events;
create policy cash_events_label on public.cash_events
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists cash_pos_payments_select on public.cash_pos_payments;
create policy cash_pos_payments_select on public.cash_pos_payments
  for select to authenticated using (owner_id = (select auth.uid()));

-- 6. Live updates for the review screen ------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cash_events') then
    alter publication supabase_realtime add table public.cash_events;
  end if;
end
$$;

-- 7. Private bucket for snapshots and clips -----------------------------------------------------------------------------------
-- No storage policies are created on purpose: browsers get nothing directly. The gateway issues short-lived signed
-- upload links to the Jetson and signed view links to the signed-in owner.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cash-snapshots', 'cash-snapshots', false, 10485760, array['image/jpeg', 'image/png', 'video/mp4'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

comment on table public.cash_events is 'Cash handling events sent by the camera device. Written by the gateway; owners can read and label.';
comment on table public.cash_pos_payments is 'Cash payments read from StockWise by the agent, used to match camera events to sales.';
