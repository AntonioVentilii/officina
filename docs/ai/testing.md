# Testing

`bun test`, no other framework. Tests live in each package's `test/` folder, never next to the source.

| Command               | Runs                                                                                                                                       | Needs   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `bun run test`        | `packages/core`, `packages/github`, `packages/runner`, the parts of `apps/api` that need no database, `apps/board/test` and `scripts/test` | nothing |
| `bun run test:db`     | `packages/db`, `packages/engine` and `apps/api` against a throwaway Postgres (`packages/db/test/with-postgres.ts`)                         | Docker  |
| `bun run check:board` | svelte-check on the board, warnings fail it                                                                                                | nothing |

What the board shows is decided and tested in the API views (`apps/api/test/board.test.ts`). Its own pure logic is tested in `apps/board/test` (formatting in `format.test.ts`, overlapping loads in `latest.test.ts`, loads triggered by live events in `coalesce.test.ts`, which view refreshes on which live event in `live-events.test.ts`, the path a sign-in returns to in `return-path.test.ts`, Markdown sanitizing in `markdown.test.ts`, the Inbox's groups in `inbox.test.ts`, each checklist item's latest check and what is still open in `checklist.test.ts`, which stages count as open, each column's hue and the stamps a stage move earns in `stages.test.ts`, the diff of a learning's edit in `diff.test.ts`, what a dialog makes inert in `inert.test.ts`, where focus goes and which Escape closes the task drawer in `drawer.test.ts`, the timeline's sentences about a task's links in `links.test.ts`), importing from `src/lib` directly; run log folding is not covered yet. A test of code that needs the DOM, such as DOMPurify, calls `installWindow` from `apps/board/test/dom.ts` before importing that code: it sets up a jsdom window (a devDependency for tests only, never in the board's bundle). The Markdown table check of `scripts/check-repo.ts` is tested in `scripts/test/markdown-tables.test.ts`.

## Where a test goes

- **A lifecycle rule:** `packages/core/test/lifecycle.test.ts`, driving commands through `createDriver` from `packages/core/test/fixtures.ts`, as people and agents would. Test the outcome (stage, events, error), not the internals.
- **A contract or a config key:** `contracts.test.ts` or `config.test.ts` in `packages/core/test`, and a proposed split in `split.test.ts`.
- **A GitHub call:** `packages/github/test/client.test.ts`, with the fake `fetch` there, and `http.test.ts` for the request every call shares; never the network.
- **A runner behaviour:** `packages/runner/test`, with `createFakePort` from `fake-port.ts`; never the Managed Agents API. The SDK adapter itself (`src/sdk.ts`) is tested in `sdk.test.ts` through a real `Anthropic` client given a fake `fetch`, which records each request, as the GitHub client's tests do.
- **A query, a step, a tick, an API route:** the database suites, starting from `resetAndSeed` (`packages/db/test/seed.ts`), which recreates the schema for each test. Suites skip themselves when `TEST_DATABASE_URL` is unset (`describe.skipIf(!url)`), so `bun run test` stays fast.
- **A migration:** `packages/db/test/migrate.test.ts` lists every migration and checks the constraints still mirror `packages/core`.

## How tests are written

- A test name says the behaviour in a sentence: "an agent that touches red paths is stopped and the owner is asked".
- Fakes implement the port the code depends on (`GitHubPort`, `ManagedAgentsPort`, `LearningGitHub`) and record calls, so a test asserts what was sent. They are typed as that port, never cast to it: an engine test gives `gitHubWith` (`packages/engine/test/fake-github.ts`) only the GitHub calls it expects.
- A race between two transactions waits until one waits on the other's lock (`untilWaitingOn` in `packages/db/test/locks.ts`; `rowLockHolder` names the holder when the code under test takes the lock), never for a fixed sleep. A test ages a row past a window by the constant that names it (`STALE_CLAIM`, `DECISION_LEASE`), never by a copy of its length.
- Tests may spell out the values they expect; production code never copies them from a test.
