-- Owners may only send a fresh sign-in link to a member who never signed in. A member who holds a
-- session, a linked GitHub account, a connector grant or a used link has signed in, whatever older
-- traces were purged before `first_signed_in_at` existed: mark them joined from the earliest trace
-- they still have (least() skips nulls, so members with none stay as they are), and end the
-- sign-in links still pending for them, since they have their own way in.
update members m set first_signed_in_at = least(
  (select min(used_at) from login_links where member_id = m.id),
  (select min(created_at) from sessions where member_id = m.id),
  (select updated_at from github_accounts where member_id = m.id),
  (select min(created_at) from connector_codes where member_id = m.id),
  (select min(created_at) from connector_tokens where member_id = m.id)
)
where m.first_signed_in_at is null;

update login_links l set expires_at = now()
from members m
where m.id = l.member_id and m.first_signed_in_at is not null
  and l.used_at is null and l.expires_at > now();
