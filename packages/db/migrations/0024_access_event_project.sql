-- An access event about one project (an invite to it, a sign-in link sent from its Members page)
-- belongs to that project's log alone; sign-ins, GitHub and connector events stay with the member
-- in every project they belong to. Past invites are matched to their project by repository. A
-- link sent from the board goes to a project its sender and its member shared, the sender being an
-- owner of each of the member's projects when they sent it. An event of these kinds whose project
-- cannot be named any more is kept, as the record of what happened, but hidden from every log, so
-- no log shows another project's repository, role or sender.
alter table access_events
  add column project_id uuid references projects (id) on delete cascade,
  add column hidden boolean not null default false;

update access_events e set project_id = p.id
from members m join projects p on p.workspace_id = m.workspace_id
where e.type = 'invited' and m.id = e.member_id and p.github_repo = e.detail ->> 'project';

update access_events e set project_id = (
  select mine.project_id from project_roles mine
  join project_roles sender
    on sender.project_id = mine.project_id and sender.member_id = e.actor_member_id
  where mine.member_id = e.member_id
  order by sender.role = 'owner' desc, mine.project_id
  limit 1
)
where e.type = 'sign_in_link_created' and e.actor_member_id is not null;

update access_events set hidden = true
where project_id is null
  and (type = 'invited' or (type = 'sign_in_link_created' and actor_member_id is not null));
