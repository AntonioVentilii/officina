import { describe, expect, test } from 'bun:test';
import {
  executeRun,
  measureSession,
  readSession,
  type SessionEvent,
  type SessionThread
} from '../src';
import { createFakePort, FAKE_USAGE, idle } from './fake-port';

let counter = 0;
const event = (type: string, fields: Record<string, unknown> = {}): SessionEvent => ({
  type,
  id: `sevt_m${++counter}`,
  ...fields
});
const request = (input: number, cacheRead: number, cacheWrite: number) =>
  event('span.model_request_end', {
    model_usage: {
      input_tokens: input,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
      output_tokens: 300
    }
  });
const text = (value: string) => [{ type: 'text', text: value }];
const tool = (name: string, input: Record<string, unknown>) =>
  event('agent.tool_use', { name, input });
const result = (use: SessionEvent, chars: number) =>
  event('agent.tool_result', { tool_use_id: use.id, content: text('x'.repeat(chars)) });

const primary: SessionThread = {
  id: 'sthr_p',
  parentId: null,
  agentName: 'officina-builder',
  usage: FAKE_USAGE
};
const reader: SessionThread = {
  id: 'sthr_r',
  parentId: 'sthr_p',
  agentName: 'officina-reader',
  usage: { costCents: 1, tokens: { input: 10, output: 900, cacheRead: 40_000, cacheWrite: 9_000 } }
};

describe('measuring a session', () => {
  test('counts the requests and largest prompt of each thread, the questions handed off and the files read again after an answer named them', () => {
    const before = tool('read', { file_path: '/workspace/officina/apps/api/src/board.ts' });
    const reread = tool('bash', {
      command: "cd /workspace/officina && sed -n '10,40p' apps/api/src/board.ts"
    });
    const absolute = tool('bash', {
      command: 'grep -n waitingOn /workspace/officina/apps/api/src/board.ts'
    });
    const viaRead = tool('read', { file_path: '/workspace/officina/packages/core/src/steps.ts' });
    const formatting = tool('bash', { command: 'bunx prettier --write apps/api/src/board.ts' });
    const unnamed = tool('read', { file_path: '/workspace/officina/apps/api/src/tasks.ts' });
    const records = [
      {
        thread: reader,
        events: [request(5, 0, 3_000), request(5, 3_000, 9_000)]
      },
      {
        thread: primary,
        events: [
          request(10, 0, 20_000),
          before,
          result(before, 4_000),
          event('agent.thread_message_sent', {
            to_agent_name: 'officina-reader',
            content: text('where is waitingOn?')
          }),
          request(10, 20_000, 3_000),
          event('agent.thread_message_received', {
            from_agent_name: 'officina-reader',
            content: text(
              '`waitingOn` is in apps/api/src/board.ts:120-160; tick uses packages/core/src/steps.ts:42.'
            )
          }),
          reread,
          result(reread, 1_200),
          absolute,
          result(absolute, 300),
          viaRead,
          result(viaRead, 800),
          formatting,
          unnamed,
          request(10, 23_000, 5_000)
        ]
      }
    ];

    expect(measureSession(records)).toEqual({
      threads: [
        {
          agentName: 'officina-builder',
          primary: true,
          usage: FAKE_USAGE,
          requests: 3,
          peakContext: 28_010
        },
        {
          agentName: 'officina-reader',
          primary: false,
          usage: reader.usage,
          requests: 2,
          peakContext: 12_005
        }
      ],
      delegations: 1,
      rereads: [
        { path: 'apps/api/src/board.ts', tool: 'bash', resultChars: 1_200 },
        { path: 'apps/api/src/board.ts', tool: 'bash', resultChars: 300 },
        { path: 'packages/core/src/steps.ts', tool: 'read', resultChars: 800 }
      ]
    });
  });

  test('a session that worked alone has one thread, no hand-off and nothing read again', async () => {
    const agents = createFakePort(() => [
      request(4, 0, 18_000),
      request(4, 18_000, 2_000),
      idle('end_turn')
    ]);
    const { sessionId } = await executeRun(agents, {
      role: 'builder',
      brief: 'Build it.',
      session: {
        agentId: 'agent_1',
        agentVersion: 1,
        model: { id: 'claude-opus-5-5', effort: 'high' },
        environmentId: 'env_1',
        title: 'Officina trial #9 builder solo 1',
        metadata: {},
        repository: {
          url: 'https://github.com/o/r',
          token: 'tok',
          branch: 'main',
          commit: 'a'.repeat(40)
        },
        budgetCents: 200
      }
    });

    expect(measureSession(await readSession(agents, sessionId))).toEqual({
      threads: [
        { agentName: 'fake', primary: true, usage: FAKE_USAGE, requests: 2, peakContext: 20_004 }
      ],
      delegations: 0,
      rereads: []
    });
  });
});
