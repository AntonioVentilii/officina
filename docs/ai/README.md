# Agent docs

What an agent needs to change Officina well, read off the code. The universal rules live in the [code standard](https://github.com/AntonioVentilii/officina/blob/main/standards/code.md); these pages only add what is specific to this repository. The design itself lives in [`../architecture.md`](../architecture.md), the source of truth: these pages point to it and never restate it.

| Page                               | Read it when you                                                    |
| ---------------------------------- | ------------------------------------------------------------------- |
| [governance.md](./governance.md)   | touch anything outside a package's `src`, or wonder if you may      |
| [structure.md](./structure.md)     | add a file, a module or an import between packages                  |
| [patterns.md](./patterns.md)       | write engine, store, API, runner or board code                      |
| [reusability.md](./reusability.md) | are about to write a helper, a type, a component or a fake          |
| [testing.md](./testing.md)         | add or change behaviour                                             |
| [pr-and-ci.md](./pr-and-ci.md)     | open a pull request                                                 |
| [workflows/](./workflows)          | do one of the changes this repository sees most often, step by step |

Workflows:

- [Change the task lifecycle](./workflows/change-the-lifecycle.md)
- [Add or change an agent role](./workflows/agent-role.md)
- [Add a database migration](./workflows/migration.md)
- [Show something new on the board](./workflows/board-field.md)
