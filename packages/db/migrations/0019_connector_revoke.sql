-- An app a member connected acts only while they belong to a project: when their last project role
-- goes, so do their connector grants and pending codes, and adding them again later does not bring
-- an old grant back.
create function officina_revoke_connector_grants() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from project_roles where member_id = old.member_id) then
    delete from connector_tokens where member_id = old.member_id;
    delete from connector_codes where member_id = old.member_id;
  end if;
  return null;
end $$;

create trigger project_roles_revoke_connector after delete on project_roles
  for each row execute function officina_revoke_connector_grants();
