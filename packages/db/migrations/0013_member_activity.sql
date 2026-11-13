-- Owners and maintainers see who accepted their invite and who is active, and owners are told when
-- an invite is accepted. Spent sign-in links are purged, so a member's first sign-in is kept on the
-- member: setting it once is what makes the owners' notification go out once.
alter table members add column first_signed_in_at timestamptz;

-- Members who signed in before this take the earliest trace that only a signed-in person leaves: a
-- used link, a session, a linked GitHub account or a Claude connector consent. Tasks, comments and
-- approvals do not count, since the CLI writes them on a member's behalf. A member with no trace
-- left stays unset and counts as not joined yet; if they did sign in long ago, their next sign-in
-- tells the owners once more, which is the cheaper mistake than showing a pending invite as joined.
-- least() skips nulls.
update members m set first_signed_in_at = least(
  (select min(used_at) from login_links where member_id = m.id),
  (select min(created_at) from sessions where member_id = m.id),
  (select updated_at from github_accounts where member_id = m.id),
  (select min(created_at) from connector_codes where member_id = m.id),
  (select min(created_at) from connector_tokens where member_id = m.id)
);

-- Notifications so far could only point at a task; an accepted invite is about a project.
alter table notifications add column project_id uuid references projects (id) on delete cascade;
