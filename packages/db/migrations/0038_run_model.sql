-- The engine now picks each step's model and effort from the task, instead of every role running
-- on one model. Each run records what it ran on and why, so the runs page shows it and the choice
-- can be measured against what the run cost. Runs from before have none.
alter table runs
  add column model text,
  add column effort text,
  add column model_reason text;
