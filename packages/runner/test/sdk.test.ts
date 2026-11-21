import { describe, expect, test } from 'bun:test';
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import type { BetaManagedAgentsStreamSessionEvents } from '@anthropic-ai/sdk/resources/beta/sessions/events';
import type { BetaManagedAgentsSessionUsage } from '@anthropic-ai/sdk/resources/beta/sessions/sessions';
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
  const fakeClient = (usage?: BetaManagedAgentsSessionUsage) => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const answers: Record<string, unknown> = {
      'POST /v1/sessions': { id: 'sesn_1' },
      'GET /v1/sessions/sesn_1': { id: 'sesn_1', usage },
      'GET /v1/sessions/sesn_1/events': { data: [RUNNING, TOOL_USE], next_page: null },
      'POST /v1/environments': { id: 'env_1' },
      'POST /v1/environments/env_1': { id: 'env_1' }
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

  test('creates a session on the agent version at the chosen model, the repository branch and a budget in cents', async () => {
    const { port, calls } = fakeClient();
    expect(
      await port.createSession({
        agentId: 'agent_builder',
        agentVersion: 3,
        model: { id: 'claude-sonnet-5-5', effort: 'medium' },
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
          // The model replaces the agent's for this session only, effort included.
          agent: {
            type: 'agent_with_overrides',
            id: 'agent_builder',
            version: 3,
            model: { id: 'claude-sonnet-5-5', effort: 'medium' }
          },
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

  test("reads a session's history of events, each with every field", async () => {
    const { port, calls } = fakeClient();
    const events = [];
    for await (const event of port.listEvents('sesn_1')) events.push(event);
    expect(events).toEqual([RUNNING, TOOL_USE]);
    expect(calls).toMatchObject([{ method: 'GET', path: '/v1/sessions/sesn_1/events' }]);
  });

  test("reads a session's cost in cents and its tokens in one call, cache writes of both lifetimes as one", async () => {
    const used = fakeClient({
      list_cost: { amount: '556', currency: 'USD' },
      input_tokens: 164,
      output_tokens: 72_500,
      cache_read_input_tokens: 13_700_000,
      cache_creation: { ephemeral_5m_input_tokens: 260_000, ephemeral_1h_input_tokens: 9_000 }
    });
    expect(await used.port.sessionUsage('sesn_1')).toEqual({
      costCents: 556,
      tokens: { input: 164, output: 72_500, cacheRead: 13_700_000, cacheWrite: 269_000 }
    });
    expect(used.calls).toEqual([{ method: 'GET', path: '/v1/sessions/sesn_1', body: undefined }]);
  });

  test('a session with no list cost yet has no cost, and one with no usage no tokens either', async () => {
    expect(await fakeClient({ output_tokens: 10 }).port.sessionUsage('sesn_1')).toEqual({
      costCents: null,
      tokens: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0 }
    });
    expect(await fakeClient().port.sessionUsage('sesn_1')).toEqual({
      costCents: null,
      tokens: null
    });
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
