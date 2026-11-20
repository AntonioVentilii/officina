-- Handing in a build reads the push from GitHub and opens the pull request, which takes a while, and
-- nothing marked it under way: a second click, or the CLI meanwhile, ran it again and got an error,
-- and no other board showed it. A claim now records who is handing the build in and since when, so
-- the second hand-in is refused plainly and every open board shows the task at work.
alter table tasks
  add column hand_in_claim uuid,
  add column hand_in_claimed_at timestamptz,
  add column hand_in_claimed_by uuid references members (id) on delete set null;
