-- A task's pull request merged on GitHub before the task reached merging was ignored: the task
-- went on through reviews and verification of code already on the default branch. The merge is
-- now kept on the task (who merged it, when, and the stage it was at; null when it did not happen)
-- and recorded as a `pull_request_merged_early` event, and the task is held for a person to close.
alter table tasks add column merged_early jsonb;
