# Pull requests and CI

Each pull request has one purpose and starts from `main`, in parallel with the others; stack one only when it needs another's code ([rules 2 and 3](https://github.com/AntonioVentilii/officina/blob/main/standards/code.md#2-scoped) of the code standard).

## Title and commits

Pull requests are squash-merged, so the title becomes the commit on `main` and the release-please changelog. CI requires a Conventional Commit with a scope: `type(scope): description`, or `type(scope)!:` for a breaking change. Types: `feat`, `fix`, `perf`, `deps`, `revert`, `docs`, `style`, `chore`, `refactor`, `test`, `build`, `ci`. The scope is the package or app (`core`, `db`, `engine`, `runner`, `github`, `api`, `board`), several joined by commas (`engine,api`), or `ci`, `release`, `repo`, `standards`, `ai`. The description is lowercase and says what changes for the reader, as in the history: `feat(engine): learner agent proposes checked edits after each merged task`.

## Body

What changed and why in a few bullets, what is out of scope or left as a follow-up, and the local gates you ran. No AI attribution lines, and no line that starts with `Test:` or `Fix:`.

## Local gates

Run before every pull request, in this order:

```bash
bun run lint
bun run typecheck
bun run test
bun run test:db
bun run check:board
```

`bun run lint` is Prettier's check; `bun run format` fixes it. `bun run test:db` needs Docker; when it is not available, say so in the body. Touching the board also means `bun run build:board`.

## CI

`.github/workflows/ci.yml` runs the title check, the `check` job (lint, typecheck, tests, svelte-check, board build) and the `db` job (database suites against Postgres 17). The `checks-pass` job is the one status the `main` ruleset requires. `release-please.yml` opens the release pull requests; a `v*` tag deploys to Fly (`deploy.yml`, see [`../deployment.md`](../deployment.md)).
