-- The engine picks each step's model by rule. A maintainer may now force one tier for every agent
-- step on a task, over the rule, and clear it again; null means the rule picks. The tiers mirror
-- `MODEL_TIERS` in packages/core, which a test checks against this constraint.
alter table tasks
  add column forced_model text
    constraint tasks_forced_model_check check (forced_model in ('haiku', 'sonnet', 'opus'));
