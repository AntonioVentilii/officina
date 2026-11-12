import { parseAgentOutput, type AgentOutput } from '@officina/core';
import { RESULT_TOOL, type RunnerRole } from './definitions';
import type { ManagedAgentsPort, SessionEvent, SessionRequest } from './port';

export const MAX_RESULT_ATTEMPTS = 3;

/** The runner every run records: Managed Agents is the only one. */
export const RUNNER = 'managed_agents';

export type RunOutcome =
  | { readonly kind: 'result'; readonly output: AgentOutput<RunnerRole> }
  | { readonly kind: 'invalid_result'; readonly errors: readonly string[] }
  | { readonly kind: 'no_result' }
  | { readonly kind: 'budget_reached' }
  | { readonly kind: 'failed'; readonly reason: string };

export interface RunReport {
  readonly sessionId: string;
  readonly outcome: RunOutcome;
  readonly costCents: number | null;
}

const stopReason = (event: SessionEvent): string | undefined =>
  (event.stop_reason as { type?: string } | undefined)?.type;

/**
 * Runs one agent role in one session: opens the event stream before sending the brief so no early
 * event is missed, validates every `submit_result` call against the role's contract, returns the
 * problems to the agent when a result is invalid, and stops only when the session is truly done.
 */
export const executeRun = async (
  port: ManagedAgentsPort,
  input: {
    readonly role: RunnerRole;
    readonly session: SessionRequest;
    readonly brief: string;
    readonly onSessionCreated?: (sessionId: string) => Promise<void> | void;
    /** Project-specific checks beyond the contract, e.g. the pull request title format. */
    readonly validate?:
      | ((output: AgentOutput<RunnerRole>) => readonly string[] | Promise<readonly string[]>)
      | undefined;
    readonly onEvent?: (event: SessionEvent) => Promise<void> | void;
  }
): Promise<RunReport> => {
  const { id: sessionId } = await port.createSession(input.session);
  await input.onSessionCreated?.(sessionId);
  const stream = await port.openStream(sessionId);
  await port.send(sessionId, [{ type: 'user.message', text: input.brief }]);

  let result: AgentOutput<RunnerRole> | null = null;
  let attempts = 0;
  let lastErrors: readonly string[] = [];
  let outcome: RunOutcome | null = null;

  for await (const event of stream) {
    await input.onEvent?.(event);

    if (event.type === 'agent.custom_tool_use') {
      const toolUseId = event.id;
      if (event.name !== RESULT_TOOL) {
        await port.send(sessionId, [
          {
            type: 'user.custom_tool_result',
            toolUseId,
            text: `Unknown tool. Use ${RESULT_TOOL}.`,
            isError: true
          }
        ]);
        continue;
      }
      if (result !== null) {
        // The accepted result stands: a later submission neither replaces it nor counts against it.
        await port.send(sessionId, [
          {
            type: 'user.custom_tool_result',
            toolUseId,
            text: 'A result was already accepted. Stop here.',
            isError: true
          }
        ]);
        continue;
      }
      attempts += 1;
      const parsed = parseAgentOutput(
        input.role,
        (event.input as { result?: unknown } | undefined)?.result
      );
      const problems = parsed.ok ? ((await input.validate?.(parsed.output)) ?? []) : parsed.errors;
      if (parsed.ok && problems.length === 0) {
        result = parsed.output;
        await port.send(sessionId, [
          {
            type: 'user.custom_tool_result',
            toolUseId,
            text: 'Result accepted. Stop here.',
            isError: false
          }
        ]);
        continue;
      }
      lastErrors = problems;
      await port.send(sessionId, [
        {
          type: 'user.custom_tool_result',
          toolUseId,
          text: `Result rejected:\n${problems.map((error) => `- ${error}`).join('\n')}`,
          isError: true
        }
      ]);
      if (attempts >= MAX_RESULT_ATTEMPTS) {
        await port.send(sessionId, [{ type: 'user.interrupt' }]);
        outcome = { kind: 'invalid_result', errors: lastErrors };
      }
      continue;
    }

    if (event.type === 'session.status_terminated') break;
    if (event.type === 'session.status_idle') {
      const reason = stopReason(event);
      if (reason === 'requires_action') continue;
      if (reason === 'budget_reached' && result === null) outcome ??= { kind: 'budget_reached' };
      if (reason === 'retries_exhausted' && result === null) {
        outcome ??= { kind: 'failed', reason: 'the session exhausted its retries' };
      }
      break;
    }
  }

  const costCents = await port.sessionCostCents(sessionId).catch(() => null);
  if (result !== null && outcome?.kind !== 'invalid_result') {
    return { sessionId, costCents, outcome: { kind: 'result', output: result } };
  }
  return { sessionId, costCents, outcome: outcome ?? { kind: 'no_result' } };
};
