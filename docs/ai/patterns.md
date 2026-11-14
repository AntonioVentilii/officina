# Patterns

The patterns Officina really uses, each with one place to copy from. [`../architecture.md`](../architecture.md) says why; this page says how.

## Domain and state

- **Every change to a task is a command through `decide()`.** A pure function takes the task, a command, the actor and a context, and returns the new task plus the domain events, or a typed error: `decide` in `packages/core/src/lifecycle.ts`. Nothing writes `tasks.stage` any other way.
- **The store applies one command atomically.** `applyCommand` locks the row, decides on current state, writes the task and every event (and the approvals they imply) in one transaction, and runs `onApplied` inside it: `applyCommand` in `packages/db/src/store.ts`. Other multi-statement writes use `inTransaction`, exported from the same file; `addProject` (`apps/api/src/setup.ts`) registers a project with it. Writes that must land with a command take the transaction's client: `insertTask` and `applyCommandIn`, as `createRequestAs` (`apps/api/src/tasks.ts`) opens and submits a request at once.
- **A task's history is written in one place.** Every `task_events` row goes through `appendTaskEvent` and every `spec_versions` row through `saveSpecVersion` (`packages/db/src/task-history.ts`), and a task's number comes from `nextTaskNumber` in `store.ts`; never write those inserts again elsewhere.
- **Agent results only apply to the work the agent saw.** Pass a `guard` to `applyCommand`, as `sameWork` does in `packages/engine/src/step-apply.ts`.
- **A GitHub write is safe to retry: it lands once.** `openPullRequest` returns the pull request an earlier attempt opened from the same branch, and `createBranch` keeps a branch an earlier attempt left, never moving it (`packages/github/src/client.ts`). Accepting a learning writes its file only when the branch does not hold the edit yet (`apps/api/src/learnings.ts`), so an accept that failed halfway can simply run again, and rejecting the learning closes any pull request it left open (`closePullRequestsFrom`).
- **Risk comes from the real diff.** Lanes, guardrails and diff size use the paths the GitHub client reads (`pushFacts`), never what an agent says it changed.
- **A step is a sequence of named phases.** `runAgentStep` (`packages/engine/src/step.ts`) claims the run (`claimStep` in `claim.ts`, shared with the learner), gathers its inputs, runs the session, guards the refs, applies the result and mirrors it to GitHub, each in its own function over one `Step`: the inputs, brief and session in `step-session.ts`, applying and mirroring the result in `step-apply.ts`. New role-specific behaviour goes in the phase it belongs to, not in a new branch of `runAgentStep`.

## Results and errors

- **Expected failures are values, not exceptions.** Discriminated unions with `ok`: `Decision` (`packages/core/src/lifecycle.ts`), `ConfigResult` (`packages/core/src/config.ts`), `CommandResult`, `RunOutcome`. Error names are a closed union (`DecisionError`, `StoreError`) and the API turns them into words in one table: `ERROR_TEXT` in `apps/api/src/tasks.ts`.
- **Exceptions are for the unexpected**, and a few named classes the caller handles: `SetupError` (`apps/api/src/setup.ts`), `TaskCommandError` (`apps/api/src/tasks.ts`), `GitHubError` (`packages/github/src/http.ts`). An unexpected error reaches the client only as `{"error":"internal"}`: the `onError` handler in `apps/api/src/app.ts`.
- **Agent output is untrusted input.** Every role's result is parsed against its zod contract and redacted of anything shaped like a secret (`parseAgentOutput` in `packages/core/src/contracts.ts`, `redactDeep` in `guards.ts`), and project checks run through the `validate` hook of `executeRun` (`packages/runner/src/run.ts`), whose problems go back to the agent. What an agent should know about a field goes in the schema's `.describe()`, which reaches it in the `submit_result` tool, not in a second copy in its prompt (the preview kinds in `packages/core/src/questions.ts`).

## Seams

- **Ports, not clients, inside the engine.** `GitHubPort` (`packages/engine/src/step.ts`) and `ManagedAgentsPort` (`packages/runner/src/port.ts`) are `Pick`s or interfaces over the real clients; tests pass fakes. The real clients are built only in `apps/api`.
- **Text written by people or agents is fenced as data in a brief**, with a fence longer than any backtick run inside it: `fence` in `packages/engine/src/brief.ts`, which every brief uses.
- **Config is parsed once into a normalized shape.** Code reads `ProjectConfig` from `parseProjectConfig` (`packages/core/src/config.ts`), with defaults filled in, never the raw YAML.

## API and board

- **Realtime is a hint, never state.** Database triggers call `pg_notify` (`officina_notify` in `packages/db/migrations/0005_board.sql`), the API fans out "this changed" over server-sent events, and the board refetches (`refresh` in `apps/board/src/lib/state/board.svelte.ts`).
- **Agent-written HTML is drawn only in a sandboxed frame**, sanitized and with a policy of its own (`OptionPreview.svelte`); Markdown only through `Markdown.svelte`.
- **Every board write is a `POST` with the `x-officina-request` header** (`REQUEST_HEADER`, checked by `mutation` in `apps/api/src/api.ts`), so a cross-site form cannot make one.
- **A person's rights are one matrix.** Every check of what a member may do asks `can(member, action)` (`packages/core/src/permissions.ts`), never `hasRole` against a role written at the call site; `hasRole` is left for routing a question to the role it is asked of. A new kind of right is a new action in `ACTIONS` with its least role in `PERMISSIONS`, its words in `ACTION_LABELS` and its row in `docs/architecture.md` section 2, which a test compares with the code. The board reads the viewer's actions from the API (`session.can`), never a role.
- **What a viewer may see is decided in the API**, by the permission matrix, in the view builders of `apps/api/src/board.ts` (`PUBLIC_FIELDS` for event payloads). Every member sees every task of their projects; roles change the detail, not which tasks. The board never hides data the API sent.
- **Board state is one class instance per concern** with Svelte 5 runes, exported as a singleton from `apps/board/src/lib/state` (`board`, `session`, `look`, `live`, `clock`, `toasts`).
- **A component that differs per look branches in one place** (`look.current` in markup, or CSS under `[data-look='tecnica']`), never as a second copy.

## Anti-patterns found in the code

Named so nobody copies them; each is a follow-up of its own.

- Stage, lane and role types are mirrored by hand in `apps/board/src/lib/types.ts`.
