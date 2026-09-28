-- Learnings proposed by the learner agent after a task is done, and what people decided about them.
-- `text` holds the lesson and `proposed_change` the text of the edit; `evidence` keeps its shape.
alter table learnings
  add column project_id uuid references projects (id) on delete cascade,
  add column run_id uuid references runs (id),
  add column title text,
  add column target text check (target in ('project', 'agent')),
  add column file text,
  add column find text,
  add column decided_by uuid references members (id),
  add column decided_at timestamptz,
  add column decision_note text,
  add column pr_number integer;
create index learnings_by_project on learnings (project_id, status, created_at);

create trigger learnings_notify after insert or update on learnings
  for each row execute function officina_notify();
