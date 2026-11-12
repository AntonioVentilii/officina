import { describe, expect, test } from 'bun:test';
import { executeRun, type OutboundEvent, type SessionRequest } from '../src';
import { createFakePort, idle, running, terminated, toolUse, type ScriptItem } from './fake-port';

const session: SessionRequest = {
  agentId: 'agent_1',
  agentVersion: 3,
  environmentId: 'env_1',
  title: 'Officina #1 reviewer_spec',
  metadata: { task_id: 't1' },
  repository: { url: 'https://github.com/o/r', token: 'tok', branch: 'officina/task-1' },
  budgetCents: 500
};

const approve = { outcome: 'approve', summary: 'Checked the diff against the spec.' } as const;

const run = (script: readonly ScriptItem[], costCents: number | null = 12) => {
  const port = createFakePort(() => script, costCents);
  return {
    port,
    report: executeRun(port, { role: 'reviewer_spec', session, brief: 'Review it.' })
  };
};

const toolResults = (sent: { events: readonly OutboundEvent[] }[]) =>
  sent.flatMap((batch) => batch.events).filter((event) => event.type === 'user.custom_tool_result');

describe('executeRun', () => {
  test('opens the stream before sending the brief, accepts a valid result and reports cost', async () => {
    const { port, report } = run([
      running(),
      toolUse(approve),
      idle('requires_action'),
      idle('end_turn')
    ]);
    expect(await report).toEqual({
      sessionId: 'sesn_1',
      costCents: 12,
      outcome: { kind: 'result', output: approve }
    });
    expect(port.log.slice(0, 3)).toEqual([
      'create sesn_1',
      'stream sesn_1',
      'send sesn_1 user.message'
    ]);
    expect(toolResults(port.sent)).toMatchObject([{ isError: false }]);
  });

  test('returns contract errors to the agent and accepts a corrected result', async () => {
    const { port, report } = run([
      toolUse({ outcome: 'approve' }),
      idle('requires_action'),
      toolUse(approve),
      idle('end_turn')
    ]);
    expect((await report).outcome.kind).toBe('result');
    const results = toolResults(port.sent);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ isError: true });
    expect((results[0] as { text: string }).text).toContain('summary');
  });

  test('interrupts after three invalid results', async () => {
    const invalid = { outcome: 'maybe' };
    const { port, report } = run([
      toolUse(invalid),
      toolUse(invalid),
      toolUse(invalid),
      idle('end_turn')
    ]);
    expect((await report).outcome.kind).toBe('invalid_result');
    expect(port.sent.at(-1)!.events).toEqual([{ type: 'user.interrupt' }]);
  });

  test('an accepted result stands whatever the agent submits after it', async () => {
    const { port, report } = run([
      toolUse(approve),
      idle('requires_action'),
      toolUse({ outcome: 'approve', summary: 'A different, valid result.' }),
      toolUse({ outcome: 'approve' }),
      toolUse({ outcome: 'approve' }),
      toolUse({ outcome: 'approve' }),
      idle('requires_action'),
      idle('end_turn')
    ]);
    // Neither the valid replacement nor three invalid submissions (which once ended the run as
    // invalid_result) change the accepted output.
    expect((await report).outcome).toEqual({ kind: 'result', output: approve });
    const refused = { isError: true, text: 'A result was already accepted. Stop here.' };
    expect(toolResults(port.sent)).toMatchObject([
      { isError: false },
      refused,
      refused,
      refused,
      refused
    ]);
  });

  test('rejects unknown tools and reports a run without a result', async () => {
    const { port, report } = run([
      toolUse({}, 'deploy'),
      idle('requires_action'),
      idle('end_turn')
    ]);
    expect((await report).outcome).toEqual({ kind: 'no_result' });
    expect(toolResults(port.sent)).toMatchObject([{ isError: true }]);
  });

  test('maps retries, budget and termination to failures without a result', async () => {
    expect((await run([idle('retries_exhausted')]).report).outcome.kind).toBe('failed');
    expect((await run([idle('budget_reached')]).report).outcome).toEqual({
      kind: 'budget_reached'
    });
    expect((await run([terminated()]).report).outcome).toEqual({ kind: 'no_result' });
  });

  test('a result submitted before the budget pause still counts', async () => {
    const { report } = run([toolUse(approve), idle('budget_reached')], null);
    expect(await report).toMatchObject({ costCents: null, outcome: { kind: 'result' } });
  });
});
