# Change the task lifecycle

For a new command, a new guardrail or a new rule about who may move a task. History: `feat(core,db): task lifecycle, lanes, approval policies and initial schema`, `feat(engine): low-risk results merge unchecked, GitHub reviews reach the builder, and a simpler board`.

1. Read `docs/architecture.md` sections 5 and 8 and decide what the rule is in words. If it changes who may approve, merge or see what, ask first.
2. Add the command or event to the unions in `packages/core/src/lifecycle.ts` (`Command`, `DomainEvent`, `DecisionError`, `Guardrail`) and handle it in `decide`. Keep it pure: anything the rule needs from the database comes in through the command or `DecideContext`.
3. Write the test first in `packages/core/test/lifecycle.test.ts` with `createDriver`: the allowed path, each refusal, and the events.
4. If the engine issues the command, do it in `packages/engine/src/tick.ts` or `step.ts` through `applyCommand`, with a `guard` when it applies an agent's result.
5. A new `DecisionError` needs its words in `ERROR_TEXT` (`apps/api/src/tasks.ts`); a new event the board shows needs its line in `Timeline.svelte` and, if contributors may see it, its fields in `PUBLIC_FIELDS` (`apps/api/src/board.ts`).
6. Update `docs/architecture.md` (sections 5, 8 or 13) in the same pull request.
