import type {
  AgentWrite,
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
export const terminated = (): SessionEvent => ({ type: 'session.status_terminated', id: nextId() });

export interface FakePort extends ManagedAgentsPort {
  readonly sessions: SessionRequest[];
  readonly sent: { sessionId: string; events: readonly OutboundEvent[] }[];
  readonly log: string[];
  readonly agentWrites: { id: string | null; agent: AgentWrite }[];
}

export const createFakePort = (
  scriptFor: (request: SessionRequest) => readonly ScriptItem[],
  costCents: number | null = 12
): FakePort => {
  const sessions: SessionRequest[] = [];
  const sent: FakePort['sent'] = [];
  const log: string[] = [];
  const agentWrites: FakePort['agentWrites'] = [];
  let agentVersion = 0;

  return {
    sessions,
    sent,
    log,
    agentWrites,
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
    async createAgent(agent) {
      agentWrites.push({ id: null, agent });
      return { id: `agent_${agentWrites.length}`, version: ++agentVersion };
    },
    async updateAgent(agentId, agent) {
      agentWrites.push({ id: agentId, agent });
      return { id: agentId, version: ++agentVersion };
    }
  };
};
