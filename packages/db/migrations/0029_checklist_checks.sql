-- The verification checklist was posted with every box empty and never touched again, and the
-- board's ticks lived in one browser. A check is now a recorded fact: what a person found for one
-- item of one head, how they checked it, and where they recorded it. Checks are only added, so an
-- item that went from a problem to ok after a fix keeps both.
create table checklist_checks (
  id bigint generated always as identity primary key,
  task_id uuid not null references tasks (id),
  head_sha text not null,
  item integer not null check (item >= 0),
  outcome text not null constraint checklist_checks_outcome_check
    check (outcome in ('ok', 'problem', 'partial')),
  evidence text not null,
  member_id uuid not null references members (id),
  channel text not null constraint checklist_checks_channel_check
    check (channel in ('board', 'claude')),
  created_at timestamptz not null default now()
);
create index checklist_checks_by_head on checklist_checks (task_id, head_sha, id);
create trigger checklist_checks_append_only before update or delete on checklist_checks
  for each row execute function officina_reject_mutation();

-- The one checklist comment Officina keeps on a task's pull request, and the text it last wrote
-- there, so it is edited only when that text would change. A row without a comment id is a claim:
-- one writer is posting it, and a claim older than its lease may be taken over.
create table checklist_comments (
  task_id uuid not null references tasks (id),
  pull_request integer not null,
  comment_id bigint,
  head_sha text,
  round text not null default '',
  earlier text not null default '',
  body text not null default '',
  claimed_at timestamptz not null default now(),
  primary key (task_id, pull_request)
);
