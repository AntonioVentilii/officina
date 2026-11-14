-- A rewrite whose run the engine lost (a restart fails the run, and the learning still waits) would
-- be tried again on every pass, each a new paid session. Counting the runs a rewrite was given lets
-- the engine fail it once a second run is lost too.
alter table learnings add column rewrite_attempts smallint not null default 0;
