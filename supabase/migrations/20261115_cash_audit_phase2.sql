-- Cash Audit Phase 2: deterministic StockWise reconciliation, manual review history, and text-only daily reports.

alter table public.cash_events drop constraint if exists cash_events_match_status_check;
alter table public.cash_events add constraint cash_events_match_status_check
  check (match_status in ('pending', 'matched', 'unmatched', 'needs_review', 'ignored'));
alter table public.cash_events add column if not exists match_locked boolean not null default false;
alter table public.cash_events add column if not exists match_note text check (match_note is null or char_length(match_note) <= 500);
alter table public.cash_events add column if not exists match_reviewed_at timestamptz;
alter table public.cash_events add column if not exists match_reviewed_by uuid;

alter table public.cash_pos_payments add column if not exists reconciliation_status text not null default 'pending'
  check (reconciliation_status in ('pending', 'matched', 'needs_review', 'pos_without_detection'));
alter table public.cash_pos_payments add column if not exists matched_event_id uuid references public.cash_events(id) on delete set null;
create unique index if not exists cash_pos_one_payment_per_event
  on public.cash_pos_payments(matched_event_id) where matched_event_id is not null;

create table if not exists public.cash_reconciliation_settings (
  owner_id uuid not null references auth.users(id) on delete cascade,
  store_key text not null check (store_key ~ '^[a-z0-9_-]{1,40}$'),
  pos_store_id uuid not null,
  store_name text not null check (char_length(store_name) between 1 and 100),
  coverage_active boolean not null default true,
  window_seconds integer not null default 120 check (window_seconds between 30 and 600),
  ambiguity_seconds integer not null default 15 check (ambiguity_seconds between 0 and 120),
  pending_minutes integer not null default 15 check (pending_minutes between 2 and 180),
  clock_offset_seconds numeric(10,1) not null default 0 check (clock_offset_seconds between -300 and 300),
  observed_offset_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(owner_id, store_key),
  unique(owner_id, pos_store_id)
);

create table if not exists public.cash_match_audit (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid not null references public.cash_events(id) on delete cascade,
  actor text not null check (actor in ('automatic', 'manual')),
  old_status text,
  new_status text not null,
  old_payment_id uuid,
  new_payment_id uuid,
  note text,
  changed_by uuid,
  changed_at timestamptz not null default now()
);
create index if not exists cash_match_audit_event_time on public.cash_match_audit(event_id, changed_at desc);

create table if not exists public.cash_daily_reports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  store_key text not null,
  store_name text not null,
  business_date date not null,
  pos_cash_count integer not null,
  pos_cash_amount numeric(14,2) not null,
  camera_event_count integer not null,
  matched_count integer not null,
  unmatched_camera_count integer not null,
  pos_without_detection_count integer not null,
  needs_review_count integer not null,
  body_text text not null,
  card_id uuid references public.agent_cards(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, store_key, business_date)
);
create index if not exists cash_daily_reports_owner_date on public.cash_daily_reports(owner_id, business_date desc);

create or replace function public.cash_match_audit_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.match_status is distinct from old.match_status
     or new.matched_payment_id is distinct from old.matched_payment_id
     or new.match_locked is distinct from old.match_locked then
    insert into public.cash_match_audit(owner_id,event_id,actor,old_status,new_status,old_payment_id,new_payment_id,note,changed_by)
    values(new.owner_id,new.id,case when new.match_method='manual' or new.match_locked then 'manual' else 'automatic' end,
      old.match_status,new.match_status,old.matched_payment_id,new.matched_payment_id,new.match_note,(select auth.uid()));
  end if;
  return new;
end $$;
revoke all on function public.cash_match_audit_trigger() from public, anon, authenticated;
drop trigger if exists cash_match_audit on public.cash_events;
create trigger cash_match_audit after update of match_status,matched_payment_id,match_locked on public.cash_events
  for each row execute function public.cash_match_audit_trigger();

-- Apply one complete deterministic reconciliation snapshot atomically. Only the service-role gateway may call this.
create or replace function public.cash_apply_reconciliation(
  p_owner uuid, p_store text, p_from timestamptz, p_to timestamptz,
  p_matches jsonb, p_review_events uuid[], p_review_payments uuid[],
  p_clock_offset numeric, p_now timestamptz default now()
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb; pending_mins integer; matched_n integer := 0;
begin
  if coalesce(current_setting('request.jwt.claim.role', true),'') <> 'service_role' then raise exception 'service role required'; end if;
  if jsonb_typeof(p_matches) <> 'array' then raise exception 'matches must be an array'; end if;
  select pending_minutes into pending_mins from public.cash_reconciliation_settings where owner_id=p_owner and store_key=p_store;
  pending_mins := coalesce(pending_mins,15);

  update public.cash_events set match_status='ignored',matched_payment_id=null,match_delta_seconds=null,matched_at=null,match_method='label'
    where owner_id=p_owner and store_key=p_store and detected_at>=p_from and detected_at<p_to and not match_locked and label='false_detection';
  update public.cash_events set
      match_status=case when greatest(detected_at,received_at)>=p_now-make_interval(mins=>pending_mins) then 'pending' else 'unmatched' end,
      matched_payment_id=null,match_delta_seconds=null,matched_at=null,match_method='time_window'
    where owner_id=p_owner and store_key=p_store and detected_at>=p_from and detected_at<p_to and not match_locked
      and label is distinct from 'false_detection';

  update public.cash_pos_payments set matched_event_id=null,
      reconciliation_status=case when paid_at>=p_now-make_interval(mins=>pending_mins) then 'pending' else 'pos_without_detection' end
    where owner_id=p_owner and store_key=p_store and paid_at>=p_from and paid_at<p_to;

  update public.cash_events set match_status='needs_review',match_method='ambiguous'
    where owner_id=p_owner and store_key=p_store and id=any(coalesce(p_review_events,'{}'::uuid[])) and not match_locked;
  update public.cash_pos_payments set reconciliation_status='needs_review'
    where owner_id=p_owner and store_key=p_store and id=any(coalesce(p_review_payments,'{}'::uuid[]));

  for r in select value from jsonb_array_elements(p_matches) loop
    update public.cash_events e set match_status='matched',matched_payment_id=(r->>'payment_id')::uuid,
      match_delta_seconds=(r->>'delta_seconds')::numeric,matched_at=p_now,match_method='time_window'
      where e.id=(r->>'event_id')::uuid and e.owner_id=p_owner and e.store_key=p_store and not e.match_locked
        and not exists(select 1 from public.cash_events x where x.matched_payment_id=(r->>'payment_id')::uuid and x.id<>e.id and x.match_locked);
    if found then
      update public.cash_pos_payments set matched_event_id=(r->>'event_id')::uuid,reconciliation_status='matched'
        where id=(r->>'payment_id')::uuid and owner_id=p_owner and store_key=p_store;
      matched_n := matched_n + 1;
    end if;
  end loop;
  update public.cash_reconciliation_settings set clock_offset_seconds=p_clock_offset,observed_offset_at=p_now,updated_at=p_now
    where owner_id=p_owner and store_key=p_store;
  return jsonb_build_object('ok',true,'matched',matched_n);
end $$;
revoke all on function public.cash_apply_reconciliation(uuid,text,timestamptz,timestamptz,jsonb,uuid[],uuid[],numeric,timestamptz) from public,anon,authenticated;

create or replace function public.cash_manual_reconciliation(
  p_owner uuid, p_event uuid, p_action text, p_payment uuid default null, p_note text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare ev public.cash_events%rowtype; pay public.cash_pos_payments%rowtype; other public.cash_events%rowtype;
begin
  if coalesce(current_setting('request.jwt.claim.role', true),'') <> 'service_role' then raise exception 'service role required'; end if;
  if p_action not in ('match','clear','needs_review') then raise exception 'bad action'; end if;
  select * into ev from public.cash_events where id=p_event and owner_id=p_owner for update;
  if not found then raise exception 'event not found'; end if;
  if ev.matched_payment_id is not null then
    update public.cash_pos_payments set matched_event_id=null,reconciliation_status='pos_without_detection' where id=ev.matched_payment_id;
  end if;
  if p_action='match' then
    select * into pay from public.cash_pos_payments where id=p_payment and owner_id=p_owner and store_key=ev.store_key for update;
    if not found then raise exception 'payment not found'; end if;
    if pay.matched_event_id is not null and pay.matched_event_id<>ev.id then
      select * into other from public.cash_events where id=pay.matched_event_id for update;
      if other.match_locked then raise exception 'payment already matched by manual review'; end if;
      update public.cash_events set match_status='unmatched',matched_payment_id=null,match_delta_seconds=null,matched_at=null,match_method='time_window'
        where id=other.id;
    end if;
    update public.cash_events set match_status='matched',matched_payment_id=pay.id,
      match_delta_seconds=extract(epoch from (ev.detected_at-pay.paid_at)),matched_at=now(),match_method='manual',match_locked=true,
      match_note=nullif(left(coalesce(p_note,''),500),'') ,match_reviewed_at=now(),match_reviewed_by=(select auth.uid()) where id=ev.id;
    update public.cash_pos_payments set matched_event_id=ev.id,reconciliation_status='matched' where id=pay.id;
  elsif p_action='clear' then
    update public.cash_events set match_status='unmatched',matched_payment_id=null,match_delta_seconds=null,matched_at=null,match_method='manual',match_locked=true,
      match_note=nullif(left(coalesce(p_note,''),500),''),match_reviewed_at=now(),match_reviewed_by=(select auth.uid()) where id=ev.id;
  else
    update public.cash_events set match_status='needs_review',matched_payment_id=null,match_delta_seconds=null,matched_at=null,match_method='manual',match_locked=true,
      match_note=nullif(left(coalesce(p_note,''),500),''),match_reviewed_at=now(),match_reviewed_by=(select auth.uid()) where id=ev.id;
  end if;
  return jsonb_build_object('ok',true,'event_id',ev.id,'action',p_action);
end $$;
revoke all on function public.cash_manual_reconciliation(uuid,uuid,text,uuid,text) from public,anon,authenticated;

alter table public.cash_reconciliation_settings enable row level security;
alter table public.cash_match_audit enable row level security;
alter table public.cash_daily_reports enable row level security;
revoke all on public.cash_reconciliation_settings,public.cash_match_audit,public.cash_daily_reports from anon,authenticated;
grant select on public.cash_reconciliation_settings,public.cash_match_audit,public.cash_daily_reports to authenticated;
drop policy if exists cash_reconciliation_settings_select on public.cash_reconciliation_settings;
create policy cash_reconciliation_settings_select on public.cash_reconciliation_settings for select to authenticated using(owner_id=(select auth.uid()));
drop policy if exists cash_match_audit_select on public.cash_match_audit;
create policy cash_match_audit_select on public.cash_match_audit for select to authenticated using(owner_id=(select auth.uid()));
drop policy if exists cash_daily_reports_select on public.cash_daily_reports;
create policy cash_daily_reports_select on public.cash_daily_reports for select to authenticated using(owner_id=(select auth.uid()));

-- Reliable scheduler: the gateway reconciles cached rows every five minutes and creates one report at 19:05 Sydney.
select cron.unschedule(jobid) from cron.job where jobname='cash-audit-phase2-tick';
select cron.schedule('cash-audit-phase2-tick','*/5 * * * *',$$
  select net.http_post(
    url := 'https://scjfvvwylrgpbrmdsjxb.supabase.co/functions/v1/agent-gateway/internal/cash/tick',
    headers := jsonb_build_object('content-type','application/json','x-cron-key',(select v from public.app_secrets where k='cron_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
$$);
