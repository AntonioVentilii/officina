-- A request too large or too mixed for one change comes back from the spec agent as a proposed
-- split: its spec version keeps the ordered sub-tasks it proposes (null for an ordinary spec), and
-- the task says its current version is one, so the lifecycle never plans, approves or builds it as
-- a spec. Adding a column is not a row update, so the spec versions' immutability trigger stays quiet.
alter table spec_versions add column split jsonb;
alter table tasks add column split_proposed boolean not null default false;
