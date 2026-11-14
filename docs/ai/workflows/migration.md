# Add a database migration

History: one numbered file per schema change, `0001_init.sql` to `0021_learning_rewrite_attempts.sql`.

1. Add `packages/db/migrations/NNNN_<what>.sql` with the next number. Never edit an applied migration.
2. Start it with a comment that says why the change exists. Use raw SQL; there is no ORM.
3. A column whose values mirror `packages/core` (stages, lanes, roles) gets a named check constraint, and `packages/db/test/migrate.test.ts` checks it against the core list.
4. A table the board watches gets the `officina_notify` trigger, like `0005_board.sql`, so open boards refresh.
5. Add the file to the list in `migrate.test.ts`, update the queries and row types in the `packages/db/src` module that owns the table, and run `bun run test:db`.
6. Update the data model in `docs/architecture.md` section 12.
