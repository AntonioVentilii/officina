# Show something new on the board

History: `feat(board): kanban board with live agent logs, task page, inbox and agents`, `feat(board): two selectable looks, Modernista and Tecnica`.

1. Read the data in `packages/db/src/board.ts` (the row) and shape it for people in `apps/api/src/board.ts` (the view). Decide there who may see it: owners and maintainers see technical detail, contributors and watchers only what states a decision.
2. Test the view in `apps/api/test/board.test.ts`, for a maintainer and for a contributor.
3. Mirror the field in `apps/board/src/lib/types.ts` and render it in the component that owns that part of the surface, reusing what [the catalog](../reusability.md) lists. Agent-written text goes through `Markdown.svelte`.
4. When the two looks draw it differently, branch once (`look.current`, or CSS under `[data-look='tecnica']`). Keep the meaning of yellow (waiting on you) and red (an error).
5. Run `bun run check:board` and `bun run build:board`, and update `docs/architecture.md` section 9 when a surface changes.
