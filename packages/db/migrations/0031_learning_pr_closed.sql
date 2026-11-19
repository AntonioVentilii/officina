-- A learning's pull request can be closed on GitHub without merging. Until now the learning stayed
-- accepted as if its pull request were still open, so a finished task kept waiting on a merge that
-- could no longer happen. The time GitHub said it was closed is kept, so the task shows it closed.
alter table learnings add column pr_closed_at timestamptz;
