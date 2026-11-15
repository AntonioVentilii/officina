import { describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaManagedAgentsStreamSessionEvents } from '@anthropic-ai/sdk/resources/beta/sessions/events';
import { createSdkPort, portEvents } from '../src/sdk';

const RUNNING = {
  type: 'session.status_running',
  id: 'sevt_1',
  processed_at: '2026-11-13T10:00:00Z'
} satisfies BetaManagedAgentsStreamSessionEvents;
const PREVIEW = {
  type: 'event_delta',
  event_id: 'sevt_2',
  delta: { type: 'content_delta', content: { type: 'text', text: 'Hel' } }
} satisfies BetaManagedAgentsStreamSessionEvents;
const TOOL_USE = {
  type: 'agent.custom_tool_use',
  id: 'sevt_2',
  name: 'submit_result',
  input: { result: { summary: 'done' } },
  processed_at: '2026-11-13T10:00:01Z'
} satisfies BetaManagedAgentsStreamSessionEvents;

/** The SDK's stream as `openStream` receives it, with the events above. */
async function* stream(): AsyncGenerator<BetaManagedAgentsStreamSessionEvents> {
  yield* [RUNNING, PREVIEW, TOOL_USE];
}

describe('the SDK port', () => {
  test('streams each session event with every field, and no previews', async () => {
    const events = [];
    for await (const event of portEvents(stream())) events.push(event);
    expect(events).toEqual([RUNNING, TOOL_USE]);
  });

  /** An Anthropic client that records what the port sends and answers with fixed ids. */
  const fakeClient = (usage?: { list_cost?: { amount: string; currency: string } }) => {
    const calls: { method: string; args: unknown[] }[] = [];
    const record =
      <T>(method: string, answer: T) =>
      async (...args: unknown[]) => {
        calls.push({ method, args });
        return answer;
      };
    const client = {
      beta: {
        sessions: {
          create: record('sessions.create', { id: 'sesn_1' }),
          retrieve: record('sessions.retrieve', { id: 'sesn_1', usage })
        },
        environments: {
          create: record('environments.create', { id: 'env_1' }),
          update: record('environments.update', { id: 'env_1' })
        }
      }
    } as unknown as Anthropic;
    return { port: createSdkPort(client), calls };
  };

  test('creates a session on the agent version, the repository branch and a budget in cents', async () => {
    const { port, calls } = fakeClient();
    expect(
      await port.createSession({
        agentId: 'agent_builder',
        agentVersion: 3,
        environmentId: 'env_1',
        title: 'Officina #7 builder',
        metadata: { task_id: 't1', run_id: 'r1', role: 'builder' },
        repository: {
          url: 'https://github.com/ViciApp/vici-app',
          token: 'ghs_token',
          branch: 'officina/task-7'
        },
        budgetCents: 300
      })
    ).toEqual({ id: 'sesn_1' });
    expect(calls).toEqual([
      {
        method: 'sessions.create',
        args: [
          {
            agent: { type: 'agent', id: 'agent_builder', version: 3 },
            environment_id: 'env_1',
            title: 'Officina #7 builder',
            metadata: { task_id: 't1', run_id: 'r1', role: 'builder' },
            resources: [
              {
                type: 'github_repository',
                url: 'https://github.com/ViciApp/vici-app',
                authorization_token: 'ghs_token',
                checkout: { type: 'branch', name: 'officina/task-7' }
              }
            ],
            // The amount is in the currency's minor units: 300 is three dollars.
            budget: { type: 'limit', max_list_cost: { amount: '300', currency: 'USD' } }
          }
        ]
      }
    ]);
  });

  test("reads a session's cost in cents, and none when it has no list cost yet", async () => {
    const priced = fakeClient({ list_cost: { amount: '2500', currency: 'USD' } });
    expect(await priced.port.sessionCostCents('sesn_1')).toBe(2500);
    expect(priced.calls).toEqual([{ method: 'sessions.retrieve', args: ['sesn_1'] }]);
    expect(await fakeClient().port.sessionCostCents('sesn_1')).toBeNull();
  });

  test('an environment reaches package registries and the allowed hosts, and no MCP server', async () => {
    const { port, calls } = fakeClient();
    const environment = { name: 'officina-vici-app', allowedHosts: ['api.vici.example'] };
    expect(await port.createEnvironment(environment)).toEqual({ id: 'env_1' });
    await port.updateEnvironment('env_1', environment);
    const config = {
      type: 'cloud',
      networking: {
        type: 'limited',
        allow_package_managers: true,
        allow_mcp_servers: false,
        allowed_hosts: ['api.vici.example']
      }
    };
    expect(calls).toEqual([
      { method: 'environments.create', args: [{ name: 'officina-vici-app', config }] },
      { method: 'environments.update', args: ['env_1', { config }] }
    ]);
  });
});
