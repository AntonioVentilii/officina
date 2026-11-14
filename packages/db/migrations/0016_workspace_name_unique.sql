-- Registering a project looked its workspace up by name and created it when the name was missing,
-- so two registrations of a new name at once could each create one. A unique name lets that lookup
-- be a single upsert, which lands on one workspace however many run at once.

-- A database that already holds a name twice keeps every workspace and what belongs to it: all but
-- the oldest get their id appended to the name, so the index can be built and the name keeps
-- leading to the oldest.
update workspaces w
set name = w.name || ' (' || w.id || ')'
where exists (
  select 1 from workspaces older
  where older.name = w.name and (older.created_at, older.id) < (w.created_at, w.id)
);

create unique index workspaces_name on workspaces (name);
