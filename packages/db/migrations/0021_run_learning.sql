-- A rewrite whose run the engine lost (a restart fails the run, and the learning still waits) would
-- be tried again on every pass, each a new paid session. A run claimed for a rewrite names its
-- learning in the same insert that claims it, so the runs a rewrite was given can be counted even
-- when the engine dies right after the claim.
alter table runs add column learning_id uuid references learnings (id);
