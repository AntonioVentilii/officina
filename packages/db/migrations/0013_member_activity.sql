-- Owners and maintainers see who accepted their invite and who is active, and owners are told when
-- an invite is accepted. Spent sign-in links are purged, so a member's first sign-in is kept on the
-- member: setting it once is what makes the owners' notification go out once. Members who already
-- signed in take the earliest trace they left.
alter table members add column first_signed_in_at timestamptz;

update members m set first_signed_in_at = (
  select min(seen.at) from (
    select used_at as at from login_links where member_id = m.id and used_at is not null
    union all
    select created_at from sessions where member_id = m.id
  ) seen
);

-- Notifications so far could only point at a task; an accepted invite is about a project.
alter table notifications add column project_id uuid references projects (id) on delete cascade;
