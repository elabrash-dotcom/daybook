-- Cash Audit: false-detection training examples.
-- When a camera event is labelled "False Detection" in Daybook, one training example is recorded for it automatically.
--  * No image is copied or changed: the example points at the original frame and the annotated frame that already sit in the
--    private 'cash-snapshots' bucket, and an evidence hold (the existing cash_events.preserve) keeps them from being archived.
--  * One example per event (unique key), however many times the label is set, cleared or edited.
--  * The structured JSON is stored on the row, so it survives even after the event itself expires.
-- Additive only: no existing column, constraint, policy or row is changed. Applying this file does not collect anything by itself;
-- run public.cash_training_backfill(<owner>) once if events labelled before this migration should be collected too.

create table if not exists public.cash_training_examples (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  event_id      uuid references public.cash_events (id) on delete set null,       -- link to the original detection (null once the event expired)
  event_uid     text not null,                                                      -- the Jetson's event_id, kept for the life of the example
  device_id     uuid not null,
  camera_label  text,
  store_key     text not null check (store_key ~ '^[a-z0-9_-]{1,40}$'),
  class_name    text not null default 'unknown' check (char_length(class_name) <= 64),
  detected_at   timestamptz not null,
  confidence    real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  model_version text check (model_version is null or char_length(model_version) <= 120),
  reason        text check (reason is null or char_length(reason) <= 500),          -- the user's note on the false label
  raw_path      text,                                                               -- original frame, exactly as the camera sent it
  annotated_path text,                                                              -- annotated frame (boxes drawn by the camera)
  image_state   text not null default 'missing' check (image_state in ('ok', 'raw_only', 'annotated_only', 'archived', 'missing')),
  status        text not null default 'collected' check (status in ('collected', 'reviewed', 'excluded', 'withdrawn')),
  review_note   text check (review_note is null or char_length(review_note) <= 500),
  hold_set      boolean not null default false,                                     -- true when THIS feature placed the evidence hold
  meta          jsonb not null check (jsonb_typeof(meta) = 'object'),               -- the training JSON (schema daybook.cash.false_detection/1)
  collected_at  timestamptz not null default now(),
  collected_by  uuid,
  reviewed_at   timestamptz,
  updated_at    timestamptz not null default now(),
  constraint cash_training_one_per_event unique (owner_id, device_id, event_uid)
);
create unique index if not exists cash_training_event on public.cash_training_examples (event_id) where event_id is not null;
create index if not exists cash_training_owner_time on public.cash_training_examples (owner_id, detected_at desc);
create index if not exists cash_training_group on public.cash_training_examples (owner_id, store_key, class_name, detected_at desc);

-- Row level security: an owner can read their own examples. Everything else goes through the gateway or the trigger below.
alter table public.cash_training_examples enable row level security;
revoke all on public.cash_training_examples from anon, authenticated;
grant select on public.cash_training_examples to authenticated;
drop policy if exists cash_training_select on public.cash_training_examples;
create policy cash_training_select on public.cash_training_examples for select to authenticated using (owner_id = (select auth.uid()));

-- Core: create or refresh the example for one event. Safe to call any number of times.
create or replace function public.cash_training_upsert(e public.cash_events)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_state text; v_meta jsonb; v_model text; v_camera text; v_archived boolean; v_new_id uuid; v_old public.cash_training_examples;
begin
  select a.label into v_camera from public.agent_devices a where a.id = e.device_id;
  select exists (select 1 from cash_retention.assets r where r.event_id = e.id and r.original_deleted) into v_archived;
  v_state := case when v_archived then 'archived'
                  when e.snapshot_raw_path is not null and e.snapshot_annotated_path is not null then 'ok'
                  when e.snapshot_raw_path is not null then 'raw_only'
                  when e.snapshot_annotated_path is not null then 'annotated_only'
                  else 'missing' end;
  v_model := nullif(left(coalesce(e.raw ->> 'model_version', e.raw ->> 'model', e.raw ->> 'model_name', e.raw ->> 'weights', ''), 120), '');
  v_meta := jsonb_build_object(
    'schema', 'daybook.cash.false_detection/1',
    'detection', jsonb_build_object(
      'event_id', e.id, 'event_uid', e.event_uid, 'detected_at', e.detected_at, 'class', coalesce(e.kind, 'unknown'),
      'confidence', e.confidence, 'track_id', e.track_id, 'bbox', e.bbox, 'detections', e.detections,
      'frame', jsonb_build_object('width', e.frame_width, 'height', e.frame_height),
      'conf_threshold', e.raw -> 'conf_threshold_used'),
    'camera', jsonb_build_object('device_id', e.device_id, 'label', v_camera, 'store_key', e.store_key),
    'model', jsonb_build_object('version', v_model),
    'feedback', jsonb_build_object('label', 'false_detection', 'reason', e.label_note, 'labelled_at', e.labelled_at, 'labelled_by', e.labelled_by),
    'images', jsonb_build_object('raw_path', e.snapshot_raw_path, 'annotated_path', e.snapshot_annotated_path, 'state', v_state),
    'source_event', e.raw);

  insert into public.cash_training_examples
    (owner_id, event_id, event_uid, device_id, camera_label, store_key, class_name, detected_at, confidence, model_version, reason,
     raw_path, annotated_path, image_state, hold_set, meta, collected_by)
  values
    (e.owner_id, e.id, e.event_uid, e.device_id, v_camera, e.store_key, coalesce(left(e.kind, 64), 'unknown'), e.detected_at, e.confidence, v_model, e.label_note,
     e.snapshot_raw_path, e.snapshot_annotated_path, v_state, not e.preserve, v_meta, e.labelled_by)
  on conflict (owner_id, device_id, event_uid) do nothing
  returning id into v_new_id;

  if v_new_id is not null then
    if not e.preserve then update public.cash_events set preserve = true where id = e.id; end if;   -- the existing evidence hold (audited)
    return;
  end if;

  -- Already collected: refresh what can legitimately change (note, frames that arrived later); never duplicate, never un-exclude.
  select * into v_old from public.cash_training_examples where owner_id = e.owner_id and device_id = e.device_id and event_uid = e.event_uid;
  update public.cash_training_examples x set
      event_id = e.id, camera_label = coalesce(v_camera, x.camera_label), class_name = coalesce(left(e.kind, 64), x.class_name),
      confidence = e.confidence, model_version = v_model, reason = e.label_note,
      raw_path = coalesce(e.snapshot_raw_path, x.raw_path), annotated_path = coalesce(e.snapshot_annotated_path, x.annotated_path),
      image_state = v_state, meta = v_meta, updated_at = now(),
      status = case when x.status = 'withdrawn' then 'collected' else x.status end,
      hold_set = case when x.status = 'withdrawn' and not e.preserve then true else x.hold_set end
    where x.id = v_old.id;
  if v_old.status = 'withdrawn' and not e.preserve then update public.cash_events set preserve = true where id = e.id; end if;
end $$;
revoke all on function public.cash_training_upsert(public.cash_events) from public, anon, authenticated;

-- Trigger: runs only for events that are (or just stopped being) false detections, so normal detection traffic never touches it.
create or replace function public.cash_training_on_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ex public.cash_training_examples;
begin
  if new.label = 'false_detection' then
    -- Collection must never stop the user's label from saving: on any error the label still saves, the failure is written to the
    -- retention audit log, and public.cash_training_backfill() collects the event later.
    begin
      perform public.cash_training_upsert(new);
    exception when others then
      raise warning 'cash training collect failed for event %: %', new.id, sqlerrm;
      insert into cash_retention.audit (event_id, action) values (new.id, left('training collect failed: ' || sqlerrm, 200));
    end;
  elsif old.label = 'false_detection' then                                   -- the user took the false label off again
    update public.cash_training_examples set status = 'withdrawn', updated_at = now()
      where owner_id = new.owner_id and device_id = new.device_id and event_uid = new.event_uid and status <> 'excluded'
      returning * into v_ex;
    if v_ex.id is not null and v_ex.hold_set then
      update public.cash_events set preserve = false where id = new.id and preserve;
      update public.cash_training_examples set hold_set = false where id = v_ex.id;
    end if;
  end if;
  return null;
end $$;
revoke all on function public.cash_training_on_event() from public, anon, authenticated;

drop trigger if exists cash_training_on_event on public.cash_events;
create trigger cash_training_on_event after update of label, label_note, snapshot_raw_path, snapshot_annotated_path on public.cash_events
  for each row when (new.label = 'false_detection' or old.label = 'false_detection') execute function public.cash_training_on_event();

-- Review actions from the gateway: 'reviewed', 'excluded' (also releases a hold this feature placed), 'include' (collect again).
create or replace function public.cash_training_review(p_owner uuid, p_id uuid, p_action text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.cash_training_examples; ev public.cash_events;
begin
  select * into v from public.cash_training_examples where id = p_id and owner_id = p_owner for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not found'); end if;
  if p_action = 'reviewed' then
    if v.status in ('excluded', 'withdrawn') then return jsonb_build_object('ok', false, 'error', 'include it again first'); end if;
    update public.cash_training_examples set status = 'reviewed', reviewed_at = now(), review_note = left(p_note, 500), updated_at = now() where id = v.id;
  elsif p_action = 'excluded' then
    if v.hold_set and v.event_id is not null then update public.cash_events set preserve = false where id = v.event_id and preserve; end if;
    update public.cash_training_examples set status = 'excluded', reviewed_at = now(), review_note = left(p_note, 500), hold_set = false, updated_at = now() where id = v.id;
  elsif p_action = 'include' then
    if v.status = 'withdrawn' then return jsonb_build_object('ok', false, 'error', 'the false label was removed on the event'); end if;
    update public.cash_training_examples set status = 'collected', review_note = left(p_note, 500), updated_at = now() where id = v.id;
    if v.event_id is not null then
      select * into ev from public.cash_events where id = v.event_id;
      if found and not ev.preserve then
        update public.cash_events set preserve = true where id = ev.id;
        update public.cash_training_examples set hold_set = true where id = v.id;
      end if;
    end if;
  else
    return jsonb_build_object('ok', false, 'error', 'bad action');
  end if;
  return jsonb_build_object('ok', true, 'id', v.id);
end $$;
revoke all on function public.cash_training_review(uuid, uuid, text, text) from public, anon, authenticated;

-- Archive locations for the export (the retention schema is not readable from the app).
create or replace function public.cash_training_assets(p_owner uuid, p_event_ids uuid[])
returns table (event_id uuid, kind text, archive text, original_deleted boolean)
language sql stable security definer set search_path = '' as $$
  select a.event_id, a.kind, a.archive, a.original_deleted
    from cash_retention.assets a join public.cash_events e on e.id = a.event_id
   where e.owner_id = p_owner and a.event_id = any (p_event_ids)
$$;
revoke all on function public.cash_training_assets(uuid, uuid[]) from public, anon, authenticated;

-- One-off: collect events that were labelled false before this migration. Idempotent.
create or replace function public.cash_training_backfill(p_owner uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare r public.cash_events; n integer := 0;
begin
  for r in select * from public.cash_events e
            where e.owner_id = p_owner and e.label = 'false_detection'
              and not exists (select 1 from public.cash_training_examples x where x.owner_id = e.owner_id and x.device_id = e.device_id and x.event_uid = e.event_uid)
  loop perform public.cash_training_upsert(r); n := n + 1; end loop;
  return n;
end $$;
revoke all on function public.cash_training_backfill(uuid) from public, anon, authenticated;

-- Live refresh of the Training data screen.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cash_training_examples') then
    alter publication supabase_realtime add table public.cash_training_examples;
  end if;
end $$;

comment on table public.cash_training_examples is 'False-detection training examples. Points at the original frames (never copied or edited); written by trigger/gateway only.';
