-- Who got into the workshop and how: sign-ins and sign-outs, invites and sign-in links, linked
-- GitHub accounts, and apps connected through the Claude connector. Append-only, read by owners,
-- kept for a year. Task decisions stay in task_events; this is about access, not work.
create table access_events (
  id bigserial primary key,
  -- Whose access it is.
  member_id uuid not null references members (id) on delete cascade,
  -- Who did it when that is someone else (an owner sending a link); null when the member did it
  -- themselves, or when the CLI on the server did it.
  actor_member_id uuid references members (id) on delete set null,
  type text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index access_events_by_member on access_events (member_id, created_at desc);
create index access_events_by_time on access_events (created_at desc);
