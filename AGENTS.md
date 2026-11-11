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
- `packages/runner`: runs one agent role in one Managed Agents session. `credentials.ts` and `fly-oidc.ts` authenticate by workload identity federation on Fly (no stored key), with an API key as the local-development fallback. Role definitions (tools per role, the `submit_result` tool built from the output contract, explicit effort, the code standard appended to every prompt by `standard.ts`), agent sync, `executeRun`, and `models.ts`, the only place that names model ids (Opus resolves to the newest listed at boot). Only `src/sdk.ts` touches the SDK; everything else uses `ManagedAgentsPort`, which tests fake.
- `packages/engine`: `runAgentStep` (claim, brief, run, verify the push, apply the result, open the pull request), `tick` (dispatch ready tasks, run due steps, holding every build while the project's onboarding task is open), `onboarding.ts` (the onboarding task and its spec) and `learner.ts` (looks back at each done task once and stores proposed learnings with checked edits).
- `agents/`: one system prompt per agent role. Changing a prompt produces a new agent version on the next sync.
- `apps/board`: the board, a SvelteKit single-page app built to static files that the API serves. It reads `/api/*`, listens to `/api/stream` (server-sent events that only say what changed, so views refetch) and sends decisions as `POST`s with the `x-officina-request` header. Agent-written text is rendered through `Markdown.svelte`, which sanitizes it.
- `apps/api`: the Elysia HTTP server (`/health`, `/github/webhook`, the board API in `api.ts` and `board.ts`, sign-in links in `people.ts`, realtime in `realtime.ts`, the board's static files in `static.ts`). `main.ts` validates the environment, runs migrations and, when GitHub App and Anthropic credentials are present, starts the scheduler (`engine.ts`, `scheduler.ts`), failing runs orphaned by a previous process first and syncing the role agents to the resolved model. `setup.ts` and `cli.ts` register projects and sync agents.

## Where to look

The agent docs in [`docs/ai/`](./docs/ai/README.md) are read off this code; [`docs/architecture.md`](./docs/architecture.md) says why it works this way.

| You are about to                                       | Read first                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Touch CI, deployment, migrations, releases or a prompt | [`docs/ai/governance.md`](./docs/ai/governance.md)                                         |
| Add a file or an import between packages               | [`docs/ai/structure.md`](./docs/ai/structure.md)                                           |
| Write engine, store, API, runner or board code         | [`docs/ai/patterns.md`](./docs/ai/patterns.md)                                             |
| Write a helper, a type, a component or a test fake     | [`docs/ai/reusability.md`](./docs/ai/reusability.md)                                       |
| Add or change a test                                   | [`docs/ai/testing.md`](./docs/ai/testing.md)                                               |
| Open a pull request                                    | [`docs/ai/pr-and-ci.md`](./docs/ai/pr-and-ci.md)                                           |
| Change a stage, a command or a guardrail               | [`docs/ai/workflows/change-the-lifecycle.md`](./docs/ai/workflows/change-the-lifecycle.md) |
| Add or change an agent role                            | [`docs/ai/workflows/agent-role.md`](./docs/ai/workflows/agent-role.md)                     |
| Change the database schema                             | [`docs/ai/workflows/migration.md`](./docs/ai/workflows/migration.md)                       |
| Show something new on the board                        | [`docs/ai/workflows/board-field.md`](./docs/ai/workflows/board-field.md)                   |

**Truth hierarchy:** the code, then CI, then `CODEOWNERS` (this repository has none yet), then `docs/ai/**` and `docs/architecture.md`, then this file, then tool layers such as `CLAUDE.md`; the [code standard](https://github.com/AntonioVentilii/officina/blob/main/standards/code.md#truth-hierarchy) says what to do on a contradiction. **Meta-update rule:** a change that adds a pattern, a shared piece, a convention or a workflow updates the matching page in the same pull request; [`docs/ai/governance.md`](./docs/ai/governance.md#meta-update-map) says which.

## Rules

Every change follows the universal code standard, [`standards/code.md`](./standards/code.md). Other repositories link it at `https://github.com/AntonioVentilii/officina/blob/main/standards/code.md`, so keep that path. What follows only adds what is specific to Officina.

- **Collaborative first.** Every feature must work for several people on the same task. A design that only works for one user is incomplete.
- **Engine logic is deterministic code.** Do not move scheduling, state transitions, limits or recovery into a model prompt.
- **Nothing project-specific.** Officina serves any repository; project details belong in that project's `.github/officina.yml` and docs.
- **Stack:** Bun, Elysia, Postgres with raw `pg`, SvelteKit with Svelte 5 runes.
- **Docs are for agents too.** When a change introduces a pattern, update `docs/architecture.md` in the same PR.
