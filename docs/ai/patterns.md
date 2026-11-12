# Patterns

The patterns Officina really uses, each with one place to copy from. [`../architecture.md`](../architecture.md) says why; this page says how.

## Domain and state

- **Every change to a task is a command through `decide()`.** A pure function takes the task, a command, the actor and a context, and returns the new task plus the domain events, or a typed error: `packages/core/src/lifecycle.ts:367`. Nothing writes `tasks.stage` any other way.
- **The store applies one command atomically.** `applyCommand` locks the row, decides on current state, writes the task and every event (and the approvals they imply) in one transaction, and runs `onApplied` inside it: `packages/db/src/store.ts:141`. Other multi-statement writes use `inTransaction`, exported from `packages/db/src/store.ts`; `addProject` (`apps/api/src/setup.ts`) registers a project with it.
- **Agent results only apply to the work the agent saw.** Pass a `guard` to `applyCommand`, as `sameWork` does: `packages/engine/src/step.ts:119`.
- **Risk comes from the real diff.** Lanes, guardrails and diff size use the paths the GitHub client reads (`pushFacts`), never what an agent says it changed.

## Results and errors

- **Expected failures are values, not exceptions.** Discriminated unions with `ok`: `Decision` (`packages/core/src/lifecycle.ts:213`), `ConfigResult` (`packages/core/src/config.ts:177`), `CommandResult`, `RunOutcome`. Error names are a closed union (`DecisionError`, `StoreError`) and the API turns them into words in one table: `apps/api/src/tasks.ts:33`.
- **Exceptions are for the unexpected**, and a few named classes the caller handles: `SetupError` (`apps/api/src/setup.ts:46`), `TaskCommandError`, `GitHubError` (`packages/github/src/client.ts:9`). An unexpected error reaches the client only as `{"error":"internal"}`: `apps/api/src/app.ts:42`.
- **Agent output is untrusted input.** Every role's result is parsed against its zod contract (`parseAgentOutput`, `packages/core/src/contracts.ts:140`), and project checks run through the `validate` hook of `executeRun` (`packages/runner/src/run.ts:28`), whose problems go back to the agent.

## Seams

- **Ports, not clients, inside the engine.** `GitHubPort` (`packages/engine/src/step.ts:41`) and `ManagedAgentsPort` (`packages/runner/src/port.ts:52`) are `Pick`s or interfaces over the real clients; tests pass fakes. The real clients are built only in `apps/api`.
- **Text written by people or agents is fenced as data in a brief**, with a fence longer than any backtick run inside it: `fence` in `packages/engine/src/brief.ts:69`.
- **Config is parsed once into a normalized shape.** New code reads `ProjectConfig` from `parseProjectConfig` (`packages/core/src/config.ts:181`), with defaults filled in, not the raw YAML. Two older reads of the raw config remain and are listed below as follow-ups.

## API and board

- **Realtime is a hint, never state.** Database triggers call `pg_notify` (`packages/db/migrations/0005_board.sql:26`), the API fans out "this changed" over server-sent events, and the board refetches (`refresh` in `apps/board/src/lib/state/board.svelte.ts:36`).
- **Every board write is a `POST` with the `x-officina-request` header** (`apps/api/src/api.ts:73`), so a cross-site form cannot make one.
- **What a viewer may see is decided in the API**, by role, in the view builders of `apps/api/src/board.ts` (`PUBLIC_FIELDS` for event payloads). The board never hides data the API sent.
- **Board state is one class instance per concern** with Svelte 5 runes, exported as a singleton from `apps/board/src/lib/state` (`board`, `session`, `look`, `live`, `clock`, `toasts`).
- **A component that differs per look branches in one place** (`look.current` in markup, or CSS under `[data-look='tecnica']`), never as a second copy.

## Anti-patterns found in the code

Named so nobody copies them; each is a follow-up of its own.

- `const RUNNER = 'managed_agents'` and `const ENGINE: Actor = { kind: 'engine' }` are repeated in several engine and API modules. One owner should export each.
- SQL outside `packages/db`: the interviewer's question count (`packages/engine/src/step.ts:209`) and the learner's "looked once" check (`packages/engine/src/learner.ts:233`). Queries belong in the db module that owns the table.
- `runAgentStep` (`packages/engine/src/step.ts`) is one long function that prepares, runs, verifies and applies every role. New role-specific behaviour goes in a helper, not in another branch inside it.
- Stage, lane and role types are mirrored by hand in `apps/board/src/lib/types.ts`.
