# AGENTS.md

Entry point for every AI agent working on this repository. Read it first.

## What this is

Officina: a collaborative agent workshop. The design lives in [`docs/architecture.md`](./docs/architecture.md), which is the source of truth. Read it before changing anything; if code and that document disagree, flag it.

## Commands

- `bun install`
- `bun run typecheck`, `bun run lint`, `bun run format`
- `bun run test`: core domain tests, no I/O
- `bun run test:db`: database tests against a throwaway Postgres container (needs Docker)
- `DATABASE_URL=... bun packages/db/src/migrate.ts`: apply migrations

## Layout

- `packages/core`: pure domain logic (config, lanes, approval policies, task lifecycle). No I/O; every stage change goes through `decide()`.
- `packages/db`: SQL migrations and the migration runner. Stage, lane and role values must match `packages/core`; a DB test enforces it.

## Rules

- **Collaborative first.** Every feature must work for several people on the same task. A design that only works for one user is incomplete.
- **Engine logic is deterministic code.** Do not move scheduling, state transitions, limits or recovery into a model prompt.
- **Nothing project-specific.** Officina serves any repository; project details belong in that project's `.github/officina.yml` and docs.
- **Stack:** Bun, Elysia, Postgres with raw `pg`, SvelteKit with Svelte 5 runes. New dependencies need a stated reason.
- **Docs are for agents too.** When a change introduces a pattern, update `docs/architecture.md` in the same PR.
- **Writing style:** no em dashes or en dashes anywhere; use hyphens, commas or colons. Comments explain why, never what.
- **Commits and PRs:** no AI attribution lines.
