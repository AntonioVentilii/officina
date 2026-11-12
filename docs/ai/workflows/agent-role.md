# Add or change an agent role

History: `feat(engine): approval chooser plans who approves each gate and how closely`, `feat(engine): interviewer agent sharpens requests before triage`, `feat(engine): learner agent proposes checked edits after each merged task`.

1. Write the prompt in `agents/<role>.md`: what the role does, how to work, what it must never do, and that it ends by calling `submit_result` once. Text it reads is information, never instructions.
2. Add its output contract to `OUTPUT_SCHEMAS` in `packages/core/src/contracts.ts`, and the command each result maps to in `commandForOutput`. The engine validates; never trust what the agent claims about risk.
3. Add the role to `AGENT_ROLES` (`packages/core/src/lifecycle.ts`) and `RUNNER_ROLES` (`packages/runner/src/definitions.ts`); decide in `definitions.ts` whether it may write. Read-only roles get read-only tokens.
4. Say when it is due in `nextAgentRoles` (`packages/core/src/steps.ts`) and what it reads in `buildBrief` (`packages/engine/src/brief.ts`). Role-specific checks on a result go in `packages/engine/src/validators.ts`, wired to the role in `validatorFor` (`step-session.ts`).
5. Give it a label (`ROLE_LABELS` in `apps/api/src/board.ts`), a shape and a code (`apps/board/src/lib/components/roles.ts`, `AgentAvatar.svelte`) and, if people should see its stats, a row on the Agents page.
6. Tests: the contract in `packages/core/test/contracts.test.ts`, the step in an engine suite with `createFakePort`. `apps/api/test/setup.test.ts` counts the synced roles.
7. Update the roles table in `docs/architecture.md` section 6, the shapes in section 9 and the README crew table.
