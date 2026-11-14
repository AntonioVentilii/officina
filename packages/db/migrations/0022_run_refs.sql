-- A build run's token can move any ref, so its refs are compared before and after the run. The
-- snapshot taken before is kept on the run, so a run the process left behind can still be checked
-- when the engine starts again.
alter table runs add column refs_before jsonb, add column refs_since timestamptz;
