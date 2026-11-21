import type {
  AgentWrite,
  EnvironmentWrite,
  ManagedAgentsPort,
  OutboundEvent,
  SessionEvent,
  SessionRequest
} from '../src';

/**
 * A scripted step: an event to emit, an action to run at that point in the session, or `DROP`, where
 * the stream closes as a dropped connection would while the session goes on.
 */
export type ScriptItem = SessionEvent | (() => Promise<void>) | typeof DROP;
export const DROP = 'drop';

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
  let agentVersion = 0;
  // Each session's script runs once, across every stream opened on it; what it sent is its history.
  const played = new Map<
    string,
    { script: readonly ScriptItem[]; next: number; sent: SessionEvent[] }
  >();
  const playOf = (sessionId: string) => {
    let play = played.get(sessionId);
    if (!play) {
      const request = sessions[Number(sessionId.split('_')[1]) - 1]!;
      play = { script: scriptFor(request), next: 0, sent: [] };
      played.set(sessionId, play);
    }
    return play;
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
      const play = playOf(sessionId);
      return (async function* () {
        while (play.next < play.script.length) {
          const item = play.script[play.next++]!;
          if (item === DROP) return;
          if (typeof item === 'function') await item();
          else {
            play.sent.push(item);
            yield item;
          }
        }
      })();
    },
    async *listEvents(sessionId) {
      log.push(`history ${sessionId}`);
      yield* [...playOf(sessionId).sent];
    },
    async send(sessionId, events) {
      log.push(`send ${sessionId} ${events.map((event) => event.type).join(',')}`);
      sent.push({ sessionId, events });
    },
    async sessionCostCents() {
      return costCents;
    },
    async findAgentByName(name) {
      const index = agentWrites.findIndex(
        (write) => write.id === null && write.agent.name === name
      );
      return index === -1 ? null : { id: `agent_${index + 1}` };
    },
    async createAgent(agent) {
      agentWrites.push({ id: null, agent });
      return { id: `agent_${agentWrites.length}`, version: ++agentVersion };
    },
    async updateAgent(agentId, agent) {
      agentWrites.push({ id: agentId, agent });
      return { id: agentId, version: ++agentVersion };
    },
    async listModels() {
      return [];
    }
  };
};
