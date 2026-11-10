-- One agent_runs row per Managed Agents session (the gateway upserts on it), and live run updates in Daybook.
create unique index if not exists agent_runs_session_id_key on public.agent_runs (session_id);
alter publication supabase_realtime add table public.agent_runs;
