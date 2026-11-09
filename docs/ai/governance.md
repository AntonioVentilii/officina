# Governance

## Paths with an owner

| Path                                                                          | Rule                                                                                                                               |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/**`, `.github/actions/**`                                  | CI and release. Ask before changing; never weaken a check or the `checks-pass` gate.                                               |
| `Dockerfile`, `docker/**`, `fly.toml`, `scripts/officina`                     | The deployment ([`../deployment.md`](../deployment.md)). Ask before changing.                                                      |
| `CHANGELOG.md`, `.release-please-manifest.json`, `release-please-config.json` | Owned by release-please. Never edit by hand.                                                                                       |
| `packages/db/migrations/*.sql`                                                | Applied migrations never change. A schema change is a new numbered file ([workflow](./workflows/migration.md)).                    |
| `bun.lock`                                                                    | Only through `bun install` / `bun add`, and only with a dependency the owner approved.                                             |
| `apps/board/build/**`, `apps/board/.svelte-kit/**`                            | Generated. Never commit or edit.                                                                                                   |
| `docs/assets/*.png`                                                           | Screenshots of the board; retake them, never edit them.                                                                            |
| `agents/*.md`                                                                 | Role prompts. A change is a new agent version on the next sync; keep the output contract in `packages/core/src/contracts.ts` true. |
| `standards/code.md`                                                           | The universal standard other repositories link. Keep the path and the rule numbers; renumbering breaks every citation.             |

## Without asking, and not

An agent may, without asking: change code inside the package that owns the concern, add tests, add a new migration, add a field the board shows, change a role prompt with its contract, and update these pages and `docs/architecture.md`.

An agent asks first before it: adds a dependency, a package or an app; changes the stack; moves scheduling, limits, state transitions or recovery out of deterministic code; changes who may approve, merge or see what (the policies, the security model, `PUBLIC_FIELDS`); or touches a path in the table above.

## Meta-update map

A change that adds or changes one of these updates the matching page in the same pull request ([rule 13](https://github.com/AntonioVentilii/officina/blob/main/standards/code.md)):

| You changed                                                      | Update                                                         |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| A stage, command, guardrail, role, lane, policy or security rule | `docs/architecture.md`, and the README when people see it      |
| The project config (`.github/officina.yml`)                      | `docs/architecture.md` section 11                              |
| A package, a module, or the direction of an import               | [structure.md](./structure.md) and the layout in `AGENTS.md`   |
| A new way of doing something the code does more than once        | [patterns.md](./patterns.md)                                   |
| A shared helper, type, constant, component, store or test fake   | [reusability.md](./reusability.md)                             |
| How tests run or are written                                     | [testing.md](./testing.md)                                     |
| A command, a gate or the pull request convention                 | [pr-and-ci.md](./pr-and-ci.md) and the commands in `AGENTS.md` |
| A recurring kind of change                                       | a page in [workflows/](./workflows)                            |
| An agent role                                                    | the README crew table and `docs/architecture.md` section 6     |
