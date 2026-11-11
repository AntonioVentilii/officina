-- A learning can edit a project's agent docs (`docs/ai/**` and its entry document) as a target of
-- its own, next to its other Markdown docs and Officina's role prompts. Values mirror
-- LEARNING_TARGETS in @officina/core; migrate.test.ts checks them.
alter table learnings drop constraint learnings_target_check;
alter table learnings add constraint learnings_target_check
  check (target in ('project', 'docs', 'agent'));
