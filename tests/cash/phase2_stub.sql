-- Extra stand-ins for objects the Phase 2 migration touches. TEST ONLY.
create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
create or replace function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values (n,s,c) returning jobid $$;
create or replace function cron.unschedule(j bigint) returns boolean language sql as $$ delete from cron.job where jobid=j; select true $$;
create schema if not exists net;
create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds int default 1000) returns bigint language sql as $$ select 1::bigint $$;
create table if not exists public.app_secrets (k text primary key, v text not null);
insert into public.app_secrets values ('cron_key','test-key') on conflict do nothing;
create table if not exists public.agents (id uuid primary key default gen_random_uuid(), owner_id uuid, slug text);
create table if not exists public.agent_cards (id uuid primary key default gen_random_uuid(), owner_id uuid, agent_id uuid, kind text, headline text);
