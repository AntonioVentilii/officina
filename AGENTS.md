# AGENTS.md

Entry point for every AI agent working on this repository. Read it first.

## What this is

Officina: a collaborative agent workshop. The design lives in [`docs/architecture.md`](./docs/architecture.md), which is the source of truth. Read it before changing anything; if code and that document disagree, flag it.

## Rules

- **Collaborative first.** Every feature must work for several people on the same task. A design that only works for one user is incomplete.
- **Engine logic is deterministic code.** Do not move scheduling, state transitions, limits or recovery into a model prompt.
- **Nothing project-specific.** Officina serves any repository; project details belong in that project's `.github/officina.yml` and docs.
- **Stack:** Bun, Elysia, Postgres with raw `pg`, SvelteKit with Svelte 5 runes. New dependencies need a stated reason.
- **Docs are for agents too.** When a change introduces a pattern, update `docs/architecture.md` in the same PR.
- **Writing style:** no em dashes or en dashes anywhere; use hyphens, commas or colons. Comments explain why, never what.
- **Commits and PRs:** no AI attribution lines.
