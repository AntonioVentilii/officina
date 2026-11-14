-- Registering a project looked its workspace up by name and created it when the name was missing,
-- so two registrations of a new name at once could each create one. A unique name lets that lookup
-- be a single upsert, which lands on one workspace however many run at once.

-- A database that already holds a name twice keeps every workspace and what belongs to it: all but
-- the oldest get their id appended to the name (and a counter, should even that name be taken), so
-- the index can be built and the name keeps leading to the oldest.
do $$
declare
  twin record;
  candidate text;
  n int;
begin
  for twin in
    select w.id, w.name from workspaces w
    where exists (
      select 1 from workspaces older
      where older.name = w.name and (older.created_at, older.id) < (w.created_at, w.id)
    )
    order by w.created_at, w.id
  loop
    candidate := twin.name || ' (' || twin.id || ')';
    n := 1;
    while exists (select 1 from workspaces where name = candidate) loop
      n := n + 1;
      candidate := twin.name || ' (' || twin.id || ' ' || n || ')';
    end loop;
    update workspaces set name = candidate where id = twin.id;
  end loop;
end $$;

create unique index workspaces_name on workspaces (name);
