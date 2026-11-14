-- Accepting a learning writes its edit to a branch of its own. The commit written there, and the
-- commit it was written on, are kept, so the check after a build running meanwhile can tell
-- Officina's own write on that branch from anything else pushed to it.
alter table learnings add column branch_sha text, add column branch_parent_sha text;
