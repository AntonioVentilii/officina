import { parseAgentOutput, type AgentOutput } from '@officina/core';
import { RESULT_TOOL, type RunnerRole } from './definitions';
import type { ManagedAgentsPort, SessionEvent, SessionRequest } from './port';

export const MAX_RESULT_ATTEMPTS = 3;

/**
 * How long one session may run before its step stops waiting: past it the session is interrupted
 * and the run fails, so a stream that stops sending events cannot hold the role forever.
 */
export const SESSION_DEADLINE_MS = 2 * 60 * 60 * 1000;

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
 * The stream's events until `deadlineMs` passes, then none: `passed()` says whether the deadline
 * ended them. A stream closed early is closed at its source too, except one that is hung past the
 * deadline, which is left without waiting on it.
 */
const untilDeadline = (stream: AsyncIterable<SessionEvent>, deadlineMs: number) => {
  let passed = false;
  async function* events() {
    const iterator = stream[Symbol.asyncIterator]();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), deadlineMs);
    });
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), deadline]);
        if (next === 'deadline') {
          passed = true;
          return;
        }
        if (next.done) return;
        yield next.value;
      }
    } finally {
      clearTimeout(timer);
      const closing = Promise.resolve(iterator.return?.()).catch(() => {});
      if (!passed) await closing;
    }
  }
  return { events: events(), passed: () => passed };
};

/**
 * Runs one agent role in one session: opens the event stream before sending the brief so no early
 * event is missed, validates every `submit_result` call against the role's contract, returns the
 * problems to the agent when a result is invalid, and stops only when the session is truly done, or
 * when it runs past its deadline (`SESSION_DEADLINE_MS` unless `deadlineMs` says otherwise), which
 * interrupts it and fails the run unless a result was already accepted.
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
    readonly deadlineMs?: number;
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
  const bounded = untilDeadline(stream, input.deadlineMs ?? SESSION_DEADLINE_MS);

  for await (const event of bounded.events) {
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

  if (bounded.passed()) {
    await port.send(sessionId, [{ type: 'user.interrupt' }]).catch(() => {});
    outcome ??= { kind: 'failed', reason: 'the session ran past its deadline and was interrupted' };
  }

  const costCents = await port.sessionCostCents(sessionId).catch(() => null);
  if (result !== null && outcome?.kind !== 'invalid_result') {
    return { sessionId, costCents, outcome: { kind: 'result', output: result } };
  }
  return { sessionId, costCents, outcome: outcome ?? { kind: 'no_result' } };
};
