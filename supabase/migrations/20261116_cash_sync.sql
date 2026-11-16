-- Cash Audit: POS sync log, manual "Sync POS Now" jobs with a one-at-a-time lock, and report sync status.
-- Additive only: no existing column, constraint or row is changed or removed.

-- 1. Every ingestion the Stockwise agent sends (scheduled or manual), including empty ones. This is the "last successful sync".
create table if not exists public.cash_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'starting' check (status in ('starting', 'running', 'done', 'failed')),
  session_id text,
  requested_via text not null default 'button' check (requested_via in ('button', 'ops')),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  error text check (error is null or char_length(error) <= 500)
);
-- At most ONE manual sync can be starting or running per owner: a second press cannot create a second run.
create unique index if not exists cash_sync_one_active on public.cash_sync_jobs (owner_id) where status in ('starting', 'running');
create index if not exists cash_sync_jobs_owner_time on public.cash_sync_jobs (owner_id, created_at desc);

create table if not exists public.cash_sync_log (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  store_key text not null default 'mcc',
  received_at timestamptz not null default now(),
  accepted integer not null check (accepted >= 0),
  new_count integer not null check (new_count >= 0),
  job_id uuid references public.cash_sync_jobs (id) on delete set null
);
create index if not exists cash_sync_log_owner_time on public.cash_sync_log (owner_id, received_at desc);

-- 2. Report status columns (the report says whether its POS data is complete).
alter table public.cash_daily_reports add column if not exists pos_sync_state text check (pos_sync_state is null or pos_sync_state in ('complete', 'incomplete'));
alter table public.cash_daily_reports add column if not exists pos_synced_at timestamptz;

-- 3. Row level security: the owner can read; only the gateway (service role) writes.
alter table public.cash_sync_jobs enable row level security;
alter table public.cash_sync_log enable row level security;
revoke all on public.cash_sync_jobs, public.cash_sync_log from anon, authenticated;
grant select on public.cash_sync_jobs, public.cash_sync_log to authenticated;
drop policy if exists cash_sync_jobs_select on public.cash_sync_jobs;
create policy cash_sync_jobs_select on public.cash_sync_jobs for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists cash_sync_log_select on public.cash_sync_log;
create policy cash_sync_log_select on public.cash_sync_log for select to authenticated using (owner_id = (select auth.uid()));

-- 4. Settle: close manual jobs whose agent run has finished, and time out jobs that never finished.
create or replace function public.cash_sync_settle(p_owner uuid, p_stale_minutes integer default 20)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.cash_sync_jobs j
     set status = r.status, finished_at = coalesce(r.finished_at, now()),
         error = case when r.status = 'failed' then left(coalesce(r.error, 'the agent run failed'), 500) end
    from public.agent_runs r
   where j.owner_id = p_owner and j.status in ('starting', 'running') and j.session_id is not null
     and r.session_id = j.session_id and r.status in ('done', 'failed');
  update public.cash_sync_jobs
     set status = 'failed', finished_at = now(), error = 'timed out waiting for the agent'
   where owner_id = p_owner and status in ('starting', 'running') and created_at < now() - make_interval(mins => p_stale_minutes);
end $$;
revoke all on function public.cash_sync_settle(uuid, integer) from public, anon, authenticated;

-- 5. Claim: atomically start a manual sync, or say why not. Serialised per owner with an advisory lock.
create or replace function public.cash_sync_claim(p_owner uuid, p_via text default 'button', p_stale_minutes integer default 20)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('cash_sync:' || p_owner::text));
  perform public.cash_sync_settle(p_owner, p_stale_minutes);
  select id into v_id from public.cash_sync_jobs where owner_id = p_owner and status in ('starting', 'running') limit 1;
  if found then return jsonb_build_object('ok', false, 'reason', 'already_running', 'job_id', v_id); end if;
  if exists (
    select 1 from public.agent_runs r join public.agents a on a.id = r.agent_id
     where a.owner_id = p_owner and r.status = 'running' and left(coalesce(r.schedule_label, ''), 9) = 'cash_sync'
       and r.started_at > now() - make_interval(mins => p_stale_minutes)
  ) then return jsonb_build_object('ok', false, 'reason', 'scheduled_running'); end if;
  insert into public.cash_sync_jobs (owner_id, requested_via) values (p_owner, p_via) returning id into v_id;
  return jsonb_build_object('ok', true, 'job_id', v_id);
end $$;
revoke all on function public.cash_sync_claim(uuid, text, integer) from public, anon, authenticated;
