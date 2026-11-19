-- A learning's pull request can be closed on GitHub without merging. Until now the learning stayed
-- accepted as if its pull request were still open, so a finished task kept waiting on a merge that
-- could no longer happen. The time GitHub said it was closed is kept, so the task shows it closed.
alter table learnings add column pr_closed_at timestamptz;

-- Every board row reads the pull requests of its task's learnings, so they are found by task.
create index learnings_pull_requests_by_task on learnings (task_id, pr_number)
  where pr_number is not null;
