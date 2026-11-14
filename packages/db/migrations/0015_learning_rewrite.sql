-- A learning can wait weeks for a decision while its file changes on the default branch, so its edit
-- no longer applies. Accepting it then hands it back to the learner, which rewrites the edit against
-- the file as it is now (`rewrite` is 'requested' meanwhile, 'failed' when it could not); people
-- then see and decide the new edit, and `rewritten_at` says when it changed.
alter table learnings
  add column rewrite text constraint learnings_rewrite_check check (rewrite in ('requested', 'failed')),
  add column rewritten_at timestamptz;
