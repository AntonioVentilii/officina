-- People sign in with one-time links; a redeemed link becomes a session. Only token hashes are
-- stored, so a database read never yields a usable link or session.
create table login_links (
  token_hash text primary key,
  member_id uuid not null references members (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  member_id uuid not null references members (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index sessions_by_member on sessions (member_id);

-- Realtime: every change someone may be watching is announced on one channel, from the database
-- itself, so writes from the engine, the CLI and webhooks all reach open boards.
create or replace function officina_notify() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'tasks' then
    perform pg_notify('officina', json_build_object('kind', 'task', 'taskId', new.id)::text);
  elsif tg_table_name = 'run_events' then
    perform pg_notify('officina', json_build_object('kind', 'run', 'runId', new.run_id)::text);
  else
    perform pg_notify('officina', json_build_object('kind', 'task', 'taskId', new.task_id)::text);
  end if;
  return null;
end;
$$;

create trigger tasks_notify after insert or update on tasks
  for each row execute function officina_notify();
create trigger task_events_notify after insert on task_events
  for each row execute function officina_notify();
create trigger comments_notify after insert or update on comments
  for each row execute function officina_notify();
create trigger runs_notify after insert or update on runs
  for each row execute function officina_notify();
create trigger run_events_notify after insert on run_events
  for each row execute function officina_notify();
