# AGENTS.md

Entry point for every AI agent working on this repository. Read it first.

## What this is

Officina: a collaborative agent workshop. The design lives in [`docs/architecture.md`](./docs/architecture.md), which is the source of truth. Read it before changing anything; if code and that document disagree, flag it.

## Commands

- `bun install`
- `bun run typecheck`, `bun run lint`, `bun run format`
- `bun run test`: core, GitHub and runner tests, no network or database
- `bun run test:db`: database, engine and API tests against a throwaway Postgres container (needs Docker)
- `bun run dev` then `bun run dev:board`: the board at `http://localhost:5173` against a throwaway Postgres with a demo workshop in every stage and simulated agents; the first command prints a sign-in link (needs Docker)
- `bun run check:board`, `bun run build:board`: svelte-check and the static build of the board
- `DATABASE_URL=... bun packages/db/src/migrate.ts`: apply migrations
- `bun apps/api/src/cli.ts setup-agents`: sync the role agents from `agents/*.md`
- `bun apps/api/src/cli.ts add-project --workspace <name> --repo <owner/name> --owner-email <email> --owner-name <name> [--config-file <path>]`: register a repository

## Layout

- `packages/core`: pure domain logic (config, lanes, approval policies, task lifecycle). No I/O; every stage change goes through `decide()`.
- `packages/db`: SQL migrations, the migration runner and the task store (`applyCommand` applies one command atomically with its audit events). Stage, lane and role values must match `packages/core`; a DB test enforces it.
- `packages/github`: GitHub App authentication (repository-scoped installation tokens), push facts read from the real diff, pull requests and comments, webhook signature verification and event parsing. Tests use a fake `fetch`, never the network.
- `packages/runner`: runs one agent role in one Managed Agents session. `credentials.ts` and `fly-oidc.ts` authenticate by workload identity federation on Fly (no stored key), with an API key as the local-development fallback. Role definitions (tools per role, the `submit_result` tool built from the output contract, explicit effort), agent sync, `executeRun`, and `models.ts`, the only place that names model ids (Opus resolves to the newest listed at boot). Only `src/sdk.ts` touches the SDK; everything else uses `ManagedAgentsPort`, which tests fake.
- `packages/engine`: `runAgentStep` (claim, brief, run, verify the push, apply the result, open the pull request), `tick` (dispatch ready tasks, run due steps, holding every build while the project's onboarding task is open), `onboarding.ts` (the onboarding task and its spec) and `learner.ts` (looks back at each done task once and stores proposed learnings with checked edits).
- `agents/`: one system prompt per agent role. Changing a prompt produces a new agent version on the next sync.
- `apps/board`: the board, a SvelteKit single-page app built to static files that the API serves. It reads `/api/*`, listens to `/api/stream` (server-sent events that only say what changed, so views refetch) and sends decisions as `POST`s with the `x-officina-request` header. Agent-written text is rendered through `Markdown.svelte`, which sanitizes it.
- `apps/api`: the Elysia HTTP server (`/health`, `/github/webhook`, the board API in `api.ts` and `board.ts`, sign-in links in `people.ts`, realtime in `realtime.ts`, the board's static files in `static.ts`). `main.ts` validates the environment, runs migrations and, when GitHub App and Anthropic credentials are present, starts the scheduler (`engine.ts`, `scheduler.ts`), failing runs orphaned by a previous process first and syncing the role agents to the resolved model. `setup.ts` and `cli.ts` register projects and sync agents.

## Rules

- **Collaborative first.** Every feature must work for several people on the same task. A design that only works for one user is incomplete.
- **Engine logic is deterministic code.** Do not move scheduling, state transitions, limits or recovery into a model prompt.
- **Nothing project-specific.** Officina serves any repository; project details belong in that project's `.github/officina.yml` and docs.
- **Stack:** Bun, Elysia, Postgres with raw `pg`, SvelteKit with Svelte 5 runes. New dependencies need a stated reason.
- **Docs are for agents too.** When a change introduces a pattern, update `docs/architecture.md` in the same PR.
- **Writing style:** no em dashes or en dashes anywhere; use hyphens, commas or colons. Comments explain why, never what.
- **Commits and PRs:** no AI attribution lines.
