import { describe, expect, test } from 'bun:test';
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
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

  /**
   * A real Anthropic client whose requests never leave the test: its `fetch` records each one and
   * answers with fixed ids.
   */
  const fakeClient = (usage?: { list_cost?: { amount: string; currency: string } }) => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const answers: Record<string, unknown> = {
      'POST /v1/sessions': { id: 'sesn_1' },
      'GET /v1/sessions/sesn_1': { id: 'sesn_1', usage },
      'POST /v1/environments': { id: 'env_1' },
      'POST /v1/environments/env_1': { id: 'env_1' },
      'POST /v1/agents': { id: 'agent_builder', version: 1 },
      'POST /v1/agents/agent_spec': { id: 'agent_spec', version: 3 },
      'GET /v1/agents': {
        data: [
          { id: 'agent_spec', name: 'officina-spec', version: 2, metadata: {} },
          {
            id: 'agent_reader',
            name: 'officina-reader',
            version: 4,
            metadata: { officina_definition_hash: 'h1' }
          }
        ],
        next_page: null
      }
    };
    const fetch: NonNullable<ClientOptions['fetch']> = async (input, init) => {
      const method = init?.method ?? 'GET';
      const path = new URL(input.toString()).pathname;
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      const answer = answers[`${method} ${path}`];
      return answer === undefined
        ? Response.json({ error: 'not found' }, { status: 404 })
        : Response.json(answer);
    };
    // The board's tests install a jsdom window in the same run, which the SDK takes for a browser.
    const client = new Anthropic({
      apiKey: 'test-key',
      fetch,
      maxRetries: 0,
      dangerouslyAllowBrowser: true
    });
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
        method: 'POST',
        path: '/v1/sessions',
        body: {
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
      }
    ]);
  });

  test('an agent with a roster is a coordinator pinned to its exact versions, one without has none', async () => {
    const { port, calls } = fakeClient();
    const agent = {
      name: 'officina-builder',
      model: { id: 'claude-opus-5-5', effort: 'high' as const },
      system: 'prompt',
      tools: [],
      hash: 'h2'
    };
    expect(
      await port.createAgent({ ...agent, roster: [{ id: 'agent_reader', version: 4 }] })
    ).toEqual({ id: 'agent_builder', version: 1 });
    await port.updateAgent('agent_spec', { ...agent, name: 'officina-spec', roster: [] });
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['POST', '/v1/agents'],
      ['POST', '/v1/agents/agent_spec']
    ]);
    expect(calls[0]!.body).toMatchObject({
      metadata: { officina_definition_hash: 'h2' },
      multiagent: {
        type: 'coordinator',
        agents: [{ type: 'agent', id: 'agent_reader', version: 4 }]
      }
    });
    expect(calls[1]!.body).toMatchObject({ multiagent: null });
  });

  test('finds an agent by name with its latest version and the hash it was written from', async () => {
    const { port } = fakeClient();
    expect(await port.findAgentByName('officina-reader')).toEqual({
      id: 'agent_reader',
      version: 4,
      hash: 'h1'
    });
    expect(await port.findAgentByName('officina-spec')).toEqual({
      id: 'agent_spec',
      version: 2,
      hash: null
    });
    expect(await port.findAgentByName('officina-learner')).toBeNull();
  });

  test("reads a session's cost in cents, and none when it has no list cost yet", async () => {
    const priced = fakeClient({ list_cost: { amount: '2500', currency: 'USD' } });
    expect(await priced.port.sessionCostCents('sesn_1')).toBe(2500);
    expect(priced.calls).toEqual([{ method: 'GET', path: '/v1/sessions/sesn_1', body: undefined }]);
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
      { method: 'POST', path: '/v1/environments', body: { name: 'officina-vici-app', config } },
      { method: 'POST', path: '/v1/environments/env_1', body: { config } }
    ]);
  });
});
