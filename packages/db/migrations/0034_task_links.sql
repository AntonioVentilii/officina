-- A request too large for one build is split into sub-tasks built in order: a task can now have a
-- parent, built through its sub-tasks, and wait for other tasks to merge before its own build
-- starts. Sub-tasks of one parent that change the same files are built one after the other, so each
-- spec version keeps the paths it predicted.
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

-- DDL, not a row update: the immutability trigger does not fire.
alter table spec_versions add column predicted_paths text[] not null default '{}';
