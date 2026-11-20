-- A claim only said that a learning was being decided, so the board could not show it: a person who
-- clicked again, or a colleague with the board open, got "someone is deciding" with no warning. The
-- claim now records who is deciding and what, so every open board shows the learning at work.
alter table learnings
  add column decision_claimed_by uuid references members (id) on delete set null,
  add column decision_claimed_for text
    constraint learnings_decision_claimed_for_check check (decision_claimed_for in ('accept', 'reject'));
