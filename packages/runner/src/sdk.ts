import type Anthropic from '@anthropic-ai/sdk';
import type { AgentCreateParams } from '@anthropic-ai/sdk/resources/beta/agents/agents';
import type { EventSendParams } from '@anthropic-ai/sdk/resources/beta/sessions/events';
import type { SessionCreateParams } from '@anthropic-ai/sdk/resources/beta/sessions/sessions';
import type { EnvironmentCreateParams } from '@anthropic-ai/sdk/resources/beta/environments/environments';
import type { ListedModel } from './models';
import type {
  AgentWrite,
  EnvironmentWrite,
  ManagedAgentsPort,
  OutboundEvent,
  SessionEvent
} from './port';

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
    const stream = await client.beta.sessions.events.stream(sessionId);
    return stream as unknown as AsyncIterable<SessionEvent>;
  },
  async send(sessionId, events) {
    await client.beta.sessions.events.send(sessionId, { events: events.map(toSdkEvent) });
  },
  async sessionCostCents(sessionId) {
    const session = await client.beta.sessions.retrieve(sessionId);
    const amount = session.usage?.list_cost?.amount;
    return amount === undefined ? null : Number(amount);
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
