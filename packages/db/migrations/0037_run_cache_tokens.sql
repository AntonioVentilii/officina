-- A run's cost is its model requests times the context each one reads, and most of a build's
-- tokens are cache reads and writes. Runs already had input and output token columns; these hold
-- the rest of the session's usage, so runs can be compared per model, effort and role.
alter table runs
  add column cache_read_tokens bigint,
  add column cache_write_tokens bigint;
