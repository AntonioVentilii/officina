-- An accept opens its pull request before it records the decision, so one whose record was lost (the
-- process stopped, the write failed, GitHub's answer was lost) left the learning proposed with its
-- pull request open, still offering Accept. Each accept now marks the learning, and by whom, so the
-- scheduler can find that pull request and record the accept. The learnings already proposed are
-- marked so each is looked at once.
alter table learnings
  add column accept_attempt uuid,
  add column accept_attempted_by uuid references members (id) on delete set null;
update learnings set accept_attempt = gen_random_uuid() where status = 'proposed';
