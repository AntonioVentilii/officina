-- A task is a request people made, or the onboarding that writes a project's agent docs. While a
-- project's onboarding task is open the engine dispatches no other build in it.
alter table tasks add column kind text not null default 'request'
  constraint tasks_kind_check check (kind in ('request', 'onboarding'));

-- Agent role values mirror @officina/core like stages and lanes; migrate.test.ts checks them.
alter table runs add constraint runs_agent_role_check check (agent_role in (
  'interviewer', 'spec', 'builder', 'reviewer_spec', 'reviewer_correctness', 'chooser', 'learner',
  'onboarder'
));
alter table agent_versions add constraint agent_versions_role_check check (role in (
  'interviewer', 'spec', 'builder', 'reviewer_spec', 'reviewer_correctness', 'chooser', 'learner',
  'onboarder'
));
