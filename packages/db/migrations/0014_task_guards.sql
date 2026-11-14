-- What a task touches that no agent may handle alone (secrets, access, publishing, confidential
-- content), set by rule from the request and the paths, so the owner's approval and the confidential
-- view follow the task. Values mirror GUARDS in packages/core/src/guards.ts.
alter table tasks add column guards text[] not null default '{}'
  constraint tasks_guards_check
  check (guards <@ array['secrets', 'access', 'publishing', 'confidential']::text[]);
