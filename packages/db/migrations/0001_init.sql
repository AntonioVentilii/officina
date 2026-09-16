-- Orchestration state for Officina. Stage, role and lane values mirror @officina/core;
-- packages/db/test/migrate.test.ts fails if they drift apart.

create or replace function officina_reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  display_name text not null,
  email text not null,
  created_at timestamptz not null default now()
);
create unique index members_workspace_email on members (workspace_id, lower(email));

create table identities (
  provider text not null check (provider in ('email', 'google', 'github')),
  subject text not null,
  member_id uuid not null references members (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (provider, subject)
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  name text not null,
  github_repo text not null,
  github_installation_id bigint,
  config jsonb not null default '{}',
  config_sha text,
  created_at timestamptz not null default now(),
  unique (workspace_id, github_repo)
);

create table project_roles (
  project_id uuid not null references projects (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  role text not null constraint project_roles_role_check
    check (role in ('watcher', 'contributor', 'maintainer', 'owner')),
  domains text[] not null default '{}',
  primary key (project_id, member_id)
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  number integer not null,
  title text not null,
  requester_id uuid not null references members (id),
  stage text not null constraint tasks_stage_check check (stage in (
    'request', 'triage', 'speccing', 'spec_review', 'ready', 'building', 'reviewing',
    'choosing', 'verifying', 'merging', 'done', 'declined', 'cancelled'
  )),
  lane text constraint tasks_lane_check check (lane in ('green', 'standard', 'red')),
  spec_version integer not null default 0,
  head_sha text,
  user_visible boolean not null default false,
  assignee jsonb,
  blocked jsonb,
  paused boolean not null default false,
  fix_rounds integer not null default 0,
  reviews jsonb not null default '{}',
  priority integer not null default 0,
  github_issue integer,
  github_pr integer,
  -- Optimistic concurrency: every write checks and bumps it, so two decisions can't race.
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, number)
);
create index tasks_board on tasks (project_id, stage);

-- The audit log. Every decision the engine applies lands here with its actor.
create table task_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references tasks (id),
  actor jsonb not null,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index task_events_by_task on task_events (task_id, id);
create trigger task_events_append_only before update or delete on task_events
  for each row execute function officina_reject_mutation();
create trigger task_events_no_truncate before truncate on task_events
  for each statement execute function officina_reject_mutation();

create table spec_versions (
  task_id uuid not null references tasks (id),
  version integer not null,
  body text not null,
  created_by jsonb not null,
  created_at timestamptz not null default now(),
  primary key (task_id, version)
);
create trigger spec_versions_immutable before update or delete on spec_versions
  for each row execute function officina_reject_mutation();

create table approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id),
  member_id uuid not null references members (id),
  gate text not null check (gate in ('spec_review', 'verifying')),
  subject text not null,
  decision text not null check (decision in ('approve', 'changes')),
  note text,
  created_at timestamptz not null default now()
);
create index approvals_by_subject on approvals (task_id, gate, subject);
create trigger approvals_append_only before update or delete on approvals
  for each row execute function officina_reject_mutation();

create table comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id) on delete cascade,
  author jsonb not null,
  body text not null,
  spec_version integer,
  anchor text,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index comments_by_task on comments (task_id, created_at);

create table leases (
  task_id uuid primary key references tasks (id) on delete cascade,
  stage text not null,
  holder jsonb not null,
  expires_at timestamptz not null
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks (id),
  stage text not null,
  runner text not null,
  agent_role text not null,
  agent_version integer not null,
  external_id text,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  list_cost_cents integer,
  input_tokens bigint,
  output_tokens bigint,
  result jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index runs_by_task on runs (task_id, created_at);

create table run_events (
  id bigint generated always as identity primary key,
  run_id uuid not null references runs (id) on delete cascade,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index run_events_by_run on run_events (run_id, id);

create table votes (
  task_id uuid not null references tasks (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, member_id)
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members (id) on delete cascade,
  task_id uuid references tasks (id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_inbox on notifications (member_id, read_at, created_at);

create table learnings (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references tasks (id),
  text text not null,
  proposed_change text,
  evidence jsonb not null default '{}',
  status text not null default 'proposed'
    check (status in ('proposed', 'accepted', 'rejected', 'applied')),
  pr_url text,
  created_at timestamptz not null default now()
);
