-- Accepting a learning makes several GitHub calls. A claim marks the learning as being decided
-- while they run, so a second decision is refused without a transaction and a row lock held open
-- across them. A claim older than its lease was left by a process that stopped, and the next
-- decision takes it over.
alter table learnings add column decision_claim uuid, add column decision_claimed_at timestamptz;
