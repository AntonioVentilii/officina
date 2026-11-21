-- A large request is built as ordered sub-tasks: a task may have a parent and may wait for other
-- tasks, and the engine builds it only once those have merged. Each spec version keeps the paths
-- its spec predicted, so sub-tasks of one parent that change the same files are built one at a
-- time. Adding a column is not a row update, so the spec versions' immutability trigger stays quiet.
alter table tasks
  add column parent_id uuid references tasks (id),
  add constraint tasks_parent_not_self check (parent_id <> id);
create index tasks_by_parent on tasks (parent_id);

create table task_dependencies (
  task_id uuid not null references tasks (id),
  depends_on uuid not null references tasks (id),
  created_at timestamptz not null default now(),
  primary key (task_id, depends_on),
  check (task_id <> depends_on)
);
create index task_dependencies_by_depends_on on task_dependencies (depends_on);

alter table spec_versions add column predicted_paths text[] not null default '{}';
