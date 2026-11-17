-- A build run's refs are checked once it ends, but the process can stop before the check is
-- written, or the check can fail. Each run records when its refs were checked, so the engine checks
-- again on its next start every run that ended without that. Runs that ended before this migration
-- were checked by the process that ran them.
alter table runs add column refs_checked_at timestamptz;

update runs set refs_checked_at = coalesce(finished_at, now())
  where refs_before is not null and status <> 'running';
