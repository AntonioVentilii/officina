-- At most one active run per task and agent role, so two engine ticks can never start the same work.
create unique index runs_one_active_per_role on runs (task_id, agent_role)
  where status in ('queued', 'running');

-- The runner-side agent object and version currently used for each role.
create table agent_versions (
  role text primary key,
  external_agent_id text not null,
  version integer not null,
  definition_hash text not null,
  updated_at timestamptz not null default now()
);

alter table projects add column default_branch text not null default 'main';
