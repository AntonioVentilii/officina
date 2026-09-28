-- The approval chooser's decision per human gate: extra approvals, check depth, named verifiers.
alter table tasks add column approval_plans jsonb not null default '{}';

-- Tasks already waiting for verification were never planned; they keep the lane policy unchanged,
-- so the new "no approval before a plan" rule does not strand them. Tasks at spec review get a
-- real plan: the scheduler runs the chooser for them.
update tasks set approval_plans = jsonb_build_object('verifying', jsonb_build_object(
  'subject', 'sha:' || head_sha,
  'depth', 'test',
  'rationale', 'Planned before the approval chooser existed: the lane policy applies unchanged.',
  'extra', '[]'::jsonb,
  'verifiers', '[]'::jsonb
))
where stage = 'verifying' and head_sha is not null;
