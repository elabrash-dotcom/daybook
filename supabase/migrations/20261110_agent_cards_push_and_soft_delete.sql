-- Daybook Agents: swipe-delete with Undo, live chat/approvals, and a push for every new card.

-- 1. Soft delete so Undo can bring a card back (the gateway hides deleted cards).
alter table public.agent_cards add column if not exists deleted_at timestamptz;

-- 2. Live updates for the chat and approvals strip (agent_cards is already published).
alter publication supabase_realtime add table public.agent_messages, public.agent_approvals;

-- 3. New card -> push its glance through the existing `push` function.
--    Uses the same cron_key the reminder jobs already use; pg_net is async, so the insert is never blocked.
create or replace function public.agent_card_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform net.http_post(
    url := 'https://scjfvvwylrgpbrmdsjxb.supabase.co/functions/v1/push',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-key', (select v from public.app_secrets where k = 'cron_key')
    ),
    body := jsonb_build_object('action', 'card', 'card_id', new.id),
    timeout_milliseconds := 20000
  );
  return new;
end;
$$;

revoke all on function public.agent_card_push() from public, anon, authenticated;

drop trigger if exists agent_cards_push on public.agent_cards;
create trigger agent_cards_push
  after insert on public.agent_cards
  for each row execute function public.agent_card_push();
