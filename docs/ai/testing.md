# Testing

`bun test`, no other framework. Tests live in each package's `test/` folder, never next to the source.

| Command               | Runs                                                                                                                       | Needs   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------- |
| `bun run test`        | `packages/core`, `packages/github`, `packages/runner`, the parts of `apps/api` that need no database and `apps/board/test` | nothing |
| `bun run test:db`     | `packages/db`, `packages/engine` and `apps/api` against a throwaway Postgres (`packages/db/test/with-postgres.ts`)         | Docker  |
| `bun run check:board` | svelte-check on the board, warnings fail it                                                                                | nothing |

What the board shows is decided and tested in the API views (`apps/api/test/board.test.ts`). Its own logic is tested only where it is a plain module of `src/lib` with no Svelte in it, in `apps/board/test` (`latestOnly`); the rest (Markdown sanitizing, formatting, run log folding) is not covered yet.

## Where a test goes

- **A lifecycle rule:** `packages/core/test/lifecycle.test.ts`, driving commands through `createDriver` from `packages/core/test/fixtures.ts`, as people and agents would. Test the outcome (stage, events, error), not the internals.
- **A contract or a config key:** `contracts.test.ts` or `config.test.ts` in `packages/core/test`.
- **A GitHub call:** `packages/github/test/client.test.ts`, with the fake `fetch` there, and `http.test.ts` for the request every call shares; never the network.
- **A runner behaviour:** `packages/runner/test`, with `createFakePort` from `fake-port.ts`; never the Managed Agents API.
- **A query, a step, a tick, an API route:** the database suites, starting from `resetAndSeed` (`packages/db/test/seed.ts`), which recreates the schema for each test. Suites skip themselves when `TEST_DATABASE_URL` is unset (`describe.skipIf(!url)`), so `bun run test` stays fast.
- **A migration:** `packages/db/test/migrate.test.ts` lists every migration and checks the constraints still mirror `packages/core`.

## How tests are written

- A test name says the behaviour in a sentence: "an agent that touches red paths is stopped and the owner is asked".
- Fakes implement the port the code depends on (`GitHubPort`, `ManagedAgentsPort`, `LearningGitHub`) and record calls, so a test asserts what was sent.
- Tests may spell out the values they expect; production code never copies them from a test.
