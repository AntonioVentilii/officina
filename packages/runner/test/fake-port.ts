import type {
  AgentWrite,
  EnvironmentWrite,
  FoundAgent,
  ManagedAgentsPort,
  OutboundEvent,
  SessionEvent,
  SessionRequest
} from '../src';

/** A scripted step: an event to emit, or an action to run at that point in the session. */
export type ScriptItem = SessionEvent | (() => Promise<void>);

let eventCounter = 0;
const nextId = () => `sevt_${++eventCounter}`;

export const running = (): SessionEvent => ({ type: 'session.status_running', id: nextId() });
export const toolUse = (result: unknown, name = 'submit_result'): SessionEvent => ({
  type: 'agent.custom_tool_use',
  id: nextId(),
  name,
  input: { result }
});
export const idle = (reason: string): SessionEvent => ({
  type: 'session.status_idle',
  id: nextId(),
  stop_reason: { type: reason }
});
export const sessionError = (type: string, message: string, retry = 'exhausted'): SessionEvent => ({
  type: 'session.error',
  id: nextId(),
  error: { type, message, retry_status: { type: retry } }
});
/** An event of the reader's thread as the session stream shows it, e.g. `session.thread_status_idle`. */
export const threadEvent = (type: string, fields: Record<string, unknown> = {}): SessionEvent => ({
  type,
  id: nextId(),
  session_thread_id: 'sthr_1',
  agent_name: 'officina-reader',
  ...fields
});
export const terminated = (): SessionEvent => ({ type: 'session.status_terminated', id: nextId() });

export interface FakePort extends ManagedAgentsPort {
  readonly sessions: SessionRequest[];
  readonly sent: { sessionId: string; events: readonly OutboundEvent[] }[];
  readonly log: string[];
  readonly agentWrites: { id: string | null; agent: AgentWrite }[];
  readonly environments: Map<string, EnvironmentWrite & { id: string }>;
}

export const createFakePort = (
  scriptFor: (request: SessionRequest) => readonly ScriptItem[],
  costCents: number | null = 12
): FakePort => {
  const sessions: SessionRequest[] = [];
  const sent: FakePort['sent'] = [];
  const log: string[] = [];
  const agentWrites: FakePort['agentWrites'] = [];
  const environments = new Map<string, EnvironmentWrite & { id: string }>();
  // The latest version written under each name, as the agents list shows it.
  const latest = new Map<string, FoundAgent>();
  let agentVersion = 0;
  const written = (id: string, agent: AgentWrite) => {
    const saved = { id, version: ++agentVersion };
    latest.set(agent.name, { ...saved, hash: agent.hash });
    return saved;
  };

  return {
    sessions,
    sent,
    log,
    agentWrites,
    environments,
    async findEnvironmentByName(name) {
      const found = environments.get(name);
      return found ? { id: found.id } : null;
    },
    async createEnvironment(environment) {
      const id = `env_${environments.size + 1}`;
      environments.set(environment.name, { ...environment, id });
      return { id };
    },
    async updateEnvironment(environmentId, environment) {
      environments.set(environment.name, { ...environment, id: environmentId });
    },
    async createSession(request) {
      sessions.push(request);
      const id = `sesn_${sessions.length}`;
      log.push(`create ${id}`);
      return { id };
    },
    async openStream(sessionId) {
      log.push(`stream ${sessionId}`);
      const request = sessions[Number(sessionId.split('_')[1]) - 1]!;
      const script = scriptFor(request);
      return (async function* () {
        for (const item of script) {
          if (typeof item === 'function') await item();
          else yield item;
        }
      })();
    },
    async send(sessionId, events) {
      log.push(`send ${sessionId} ${events.map((event) => event.type).join(',')}`);
      sent.push({ sessionId, events });
    },
    async sessionCostCents() {
      return costCents;
    },
    async findAgentByName(name) {
      return latest.get(name) ?? null;
    },
    async createAgent(agent) {
      agentWrites.push({ id: null, agent });
      return written(`agent_${agentWrites.length}`, agent);
    },
    async updateAgent(agentId, agent) {
      agentWrites.push({ id: agentId, agent });
      return written(agentId, agent);
    },
    async listModels() {
      return [];
    }
  };
};
