-- A change over its lane's size limit could only pass by raising the limit for the whole lane. The
-- size check now offers to allow that size for one task: who allowed how many lines, in which
-- lane, is kept on the task (null when nothing was allowed) and recorded as a `diff_allowed` event.
alter table tasks add column diff_allowance jsonb;
