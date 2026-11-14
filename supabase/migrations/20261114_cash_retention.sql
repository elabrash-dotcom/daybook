alter table public.cash_events add column preserve boolean not null default false;
grant update (preserve) on public.cash_events to authenticated;
update storage.buckets set allowed_mime_types=array['image/jpeg','image/webp'] where id='cash-snapshots';

create schema cash_retention;
revoke all on schema cash_retention from public, anon, authenticated;
create table cash_retention.policy (
  singleton boolean primary key default true check(singleton),
  original_days integer not null default 30 check(original_days >= 1),
  archive_years integer not null default 3 check(archive_years >= 1),
  metadata_years integer not null default 10 check(metadata_years >= 1),
  quality integer not null default 82 check(quality between 1 and 100),
  check(metadata_years * 365 > original_days + archive_years * 366)
);
insert into cash_retention.policy default values;
create table cash_retention.assets (
  event_id uuid references public.cash_events on delete restrict,
  kind text check(kind in ('raw','annotated')),
  original text not null, archive text not null,
  source_sha text not null, archive_sha text not null,
  archived_at timestamptz not null default now(),
  original_deleted boolean not null default false,
  primary key(event_id,kind)
);
create table cash_retention.audit (
  recorded_at timestamptz default now(), event_id uuid, action text not null, actor uuid
);
create function cash_retention.log_hold() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into cash_retention.audit(event_id,action,actor) values(new.id,case when new.preserve then 'hold' else 'release' end,auth.uid());
  return new;
end $$;
create trigger cash_hold_changed after update of preserve on public.cash_events
for each row when(old.preserve is distinct from new.preserve) execute function cash_retention.log_hold();
alter table cash_retention.assets add column expired boolean not null default false;
-- Stop issuing two-hour signed upload URLs before the first possible archive operation.
create function public.cash_camera_upload_open(event_key uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.cash_events e cross join cash_retention.policy p
    where e.id=event_key and now()+interval '2 hours 5 minutes' < e.received_at+make_interval(days=>p.original_days)
    and not exists(select 1 from cash_retention.assets a where a.event_id=e.id));
$$;
revoke all on function public.cash_camera_upload_open(uuid) from public,anon,authenticated;
grant execute on function public.cash_camera_upload_open(uuid) to service_role;
