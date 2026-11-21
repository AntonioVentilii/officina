import type Anthropic from '@anthropic-ai/sdk';
import type { AgentCreateParams } from '@anthropic-ai/sdk/resources/beta/agents/agents';
import type {
  BetaManagedAgentsStreamSessionEvents,
  EventSendParams
} from '@anthropic-ai/sdk/resources/beta/sessions/events';
import type {
  BetaManagedAgentsSessionUsage,
  SessionCreateParams
} from '@anthropic-ai/sdk/resources/beta/sessions/sessions';
import type { EnvironmentCreateParams } from '@anthropic-ai/sdk/resources/beta/environments/environments';
import type { RunTokens, RunUsage } from '@officina/core';
import type { ListedModel } from './models';
import type {
  AgentWrite,
  EnvironmentWrite,
  ManagedAgentsPort,
  OutboundEvent,
  SessionEvent
} from './port';

/** A session's tokens; cache writes of both cache lifetimes are one count. */
const tokensOf = (usage: BetaManagedAgentsSessionUsage): RunTokens => {
  const written = usage.cache_creation ?? {};
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: (written.ephemeral_5m_input_tokens ?? 0) + (written.ephemeral_1h_input_tokens ?? 0)
  };
};

/**
 * A session's usage as the port reports it, the list cost's amount in cents. A session with no
 * usage yet has no tokens either.
 */
const usageOf = (usage: BetaManagedAgentsSessionUsage | undefined): RunUsage => {
  const amount = usage?.list_cost?.amount;
  return {
    costCents: amount === undefined ? null : Number(amount),
    tokens: usage ? tokensOf(usage) : null
  };
};

const toSdkEvent = (event: OutboundEvent): EventSendParams['events'][number] => {
  switch (event.type) {
    case 'user.message':
      return { type: 'user.message', content: [{ type: 'text', text: event.text }] };
    case 'user.custom_tool_result':
      return {
        type: 'user.custom_tool_result',
        custom_tool_use_id: event.toolUseId,
        content: [{ type: 'text', text: event.text }],
        is_error: event.isError
      };
    case 'user.interrupt':
      return { type: 'user.interrupt' };
  }
};

/**
 * Each SDK event as the port's, every field kept so the run log stores what the session sent. The
 * previews of an event still being produced (`event_start`, `event_delta`) have no id of their
 * own and come only when the stream asks for them, which this port never does.
 */
export async function* portEvents(
  stream: AsyncIterable<BetaManagedAgentsStreamSessionEvents>
): AsyncGenerator<SessionEvent> {
  for await (const event of stream) if ('id' in event) yield { ...event };
}

const agentParams = (agent: AgentWrite): AgentCreateParams => ({
  name: agent.name,
  model: { id: agent.model.id, effort: agent.model.effort },
  system: agent.system,
  tools: agent.tools
});

/** Deny-by-default egress: package registries plus the hosts a project explicitly allows. */
const environmentConfig = (
  environment: EnvironmentWrite
): NonNullable<EnvironmentCreateParams['config']> => ({
  type: 'cloud',
  networking: {
    type: 'limited',
    allow_package_managers: true,
    allow_mcp_servers: false,
    allowed_hosts: [...environment.allowedHosts]
  }
});

export const createSdkPort = (client: Anthropic): ManagedAgentsPort => ({
  async findEnvironmentByName(name) {
    for await (const environment of client.beta.environments.list()) {
      if (environment.name === name) return { id: environment.id };
    }
    return null;
  },
  async createEnvironment(environment) {
    const created = await client.beta.environments.create({
      name: environment.name,
      config: environmentConfig(environment)
    });
    return { id: created.id };
  },
  async updateEnvironment(environmentId, environment) {
    await client.beta.environments.update(environmentId, {
      config: environmentConfig(environment)
    });
  },
  async createSession(request) {
    const params: SessionCreateParams = {
      agent: { type: 'agent', id: request.agentId, version: request.agentVersion },
      environment_id: request.environmentId,
      title: request.title,
      metadata: { ...request.metadata },
      resources: [
        {
          type: 'github_repository',
          url: request.repository.url,
          authorization_token: request.repository.token,
          checkout: { type: 'branch', name: request.repository.branch }
        }
      ],
      budget: {
        type: 'limit',
        max_list_cost: { amount: String(request.budgetCents), currency: 'USD' }
      }
    };
    const session = await client.beta.sessions.create(params);
    return { id: session.id };
  },
  async openStream(sessionId) {
    return portEvents(await client.beta.sessions.events.stream(sessionId));
  },
  async send(sessionId, events) {
    await client.beta.sessions.events.send(sessionId, { events: events.map(toSdkEvent) });
  },
  async sessionUsage(sessionId) {
    return usageOf((await client.beta.sessions.retrieve(sessionId)).usage);
  },
  async findAgentByName(name) {
    for await (const agent of client.beta.agents.list()) {
      if (agent.name === name) return { id: agent.id };
    }
    return null;
  },
  async createAgent(agent) {
    const created = await client.beta.agents.create(agentParams(agent));
    return { id: created.id, version: created.version };
  },
  async updateAgent(agentId, agent) {
    // No expected version: this sync loop owns the agents it manages.
    const updated = await client.beta.agents.update(agentId, agentParams(agent));
    return { id: updated.id, version: updated.version };
  },
  async listModels() {
    const models: ListedModel[] = [];
    for await (const model of client.models.list()) {
      models.push({ id: model.id, createdAt: model.created_at });
    }
    return models;
  }
});
