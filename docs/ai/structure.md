# Structure

A Bun workspace: five packages and two apps. The layout in [`AGENTS.md`](../../AGENTS.md) says what each one holds; this page says where new code goes and which way imports point.

## Dependencies

```
core  <-  db  <-  engine  <-  api
  ^        ^        ^         ^
  +---- runner -----+         |
  +---- github -----+---------+
board (separate app: talks to api over HTTP only)
```

- `packages/core` imports nothing of ours and does no I/O: no `pg`, no `fetch`, no SDK. Bun's `Glob` and `zod` are the only outside imports.
- `packages/db` imports `core` for its types and `decide()`; it never imports `engine`, `runner` or `github`.
- `packages/runner` imports `core` (contracts). Only `src/sdk.ts` calls the Managed Agents API; `credentials.ts` builds the authenticated SDK client and `definitions.ts` borrows a type. Everything else uses `ManagedAgentsPort`.
- `packages/github` imports one `core` type (`PushFacts`); only it calls the GitHub REST and GraphQL APIs.
- `packages/engine` composes `core`, `db`, `runner` and `github` through ports (`GitHubPort`, `ManagedAgentsPort`), never their concrete clients.
- `apps/api` is the only place that wires real clients, reads the environment and starts the scheduler.
- `apps/board` never imports a workspace package; it reads `/api/*`. Its types in `src/lib/types.ts` mirror what the API returns.

`eslint.config.js` enforces these directions (`no-restricted-imports`), including that only `packages/runner/src/sdk.ts`, `credentials.ts` and `definitions.ts` import `@anthropic-ai/sdk`.

## Where new code goes

| New code                                       | Goes in                                                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A rule about what may happen to a task         | `packages/core/src/lifecycle.ts` (`decide`), with its test                                                                                                                 |
| What a role returns and the command it maps to | `packages/core/src/contracts.ts`                                                                                                                                           |
| A project config key                           | `packages/core/src/config.ts` (schema plus normalized `ProjectConfig`)                                                                                                     |
| A query or a write                             | the `packages/db/src` module that owns that table (`store.ts` for tasks and events, `runs.ts`, `board.ts`, `learnings.ts`, `auth.ts`, `projects.ts`, `github-accounts.ts`) |
| What an agent reads for a step                 | `packages/engine/src/brief.ts`                                                                                                                                             |
| Running a step, applying its result            | `packages/engine/src/step.ts`; opening a task's pull request in `pull-request.ts`; GitHub mirroring in `github-sync.ts`; the learner in `learner.ts`                       |
| A GitHub call                                  | `packages/github/src/client.ts` (as the App) or `user.ts` (as a member)                                                                                                    |
| A Managed Agents call                          | `packages/runner/src/port.ts` (the port) and `sdk.ts` (its only implementation)                                                                                            |
| An HTTP route                                  | `apps/api/src/api.ts`, with the view it returns in `board.ts`                                                                                                              |
| A CLI command                                  | `apps/api/src/cli.ts`, logic in `tasks.ts` or `setup.ts`                                                                                                                   |
| A board surface                                | `apps/board/src/routes/<surface>/+page.svelte`, pieces in `src/lib/components`, shared state in `src/lib/state`                                                            |
| A role prompt                                  | `agents/<role>.md`                                                                                                                                                         |
| Design, decisions, the why                     | `docs/architecture.md`                                                                                                                                                     |
