import type {
  AgentWrite,
  EnvironmentWrite,
  FoundAgent,
  ManagedAgentsPort,
  OutboundEvent,
  SessionEvent,
  SessionRequest,
  SessionThread
} from '../src';
import type { RunUsage } from '@officina/core';

/**
 * A scripted step: an event to emit, an action to run at that point in the session, `DROP`, where
 * the stream closes as a dropped connection would while the session goes on, or an event sent
 * while it was closed (`whileClosed`), which only the history holds.
 */
export type ScriptItem = SessionEvent | (() => Promise<void>) | typeof DROP | ClosedEvent;
export const DROP = 'drop';
interface ClosedEvent {
  readonly whileClosed: SessionEvent;
}
export const whileClosed = (event: SessionEvent): ClosedEvent => ({ whileClosed: event });
const isClosed = (item: ScriptItem | undefined): item is ClosedEvent =>
  typeof item === 'object' && !('type' in item);

/** What every fake session reports it used, unless a test says otherwise. */
export const FAKE_USAGE: RunUsage = {
  costCents: 12,
  tokens: { input: 40, output: 1_500, cacheRead: 90_000, cacheWrite: 12_000 }
};

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
  /**
   * The threads a session reports, set by a test; a session without any has only its primary
   * thread, whose events are those its script sent.
   */
  readonly threads: Map<string, FakeThread[]>;
}

export interface FakeThread {
  readonly thread: SessionThread;
  readonly events: readonly SessionEvent[];
}

export const createFakePort = (
  scriptFor: (request: SessionRequest) => readonly ScriptItem[],
  usage: RunUsage = FAKE_USAGE
): FakePort => {
  const sessions: SessionRequest[] = [];
  const sent: FakePort['sent'] = [];
  const log: string[] = [];
  const agentWrites: FakePort['agentWrites'] = [];
  const environments = new Map<string, EnvironmentWrite & { id: string }>();
  const threads = new Map<string, FakeThread[]>();
  const threadsOf = (sessionId: string): FakeThread[] =>
    threads.get(sessionId) ?? [
      {
        thread: { id: `${sessionId}_primary`, parentId: null, agentName: 'fake', usage },
        events: playOf(sessionId).sent
      }
    ];
  // The latest version written under each name, as the agents list shows it.
  const latest = new Map<string, FoundAgent>();
  let agentVersion = 0;
  const written = (id: string, agent: AgentWrite) => {
    const saved = { id, version: ++agentVersion };
    latest.set(agent.name, { ...saved, hash: agent.hash });
    return saved;
  };
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
    threads,
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
      // What the session sent before this stream opened is in its history, never on the stream.
      for (let item = play.script[play.next]; isClosed(item); item = play.script[++play.next]) {
        play.sent.push(item.whileClosed);
      }
      return (async function* () {
        while (play.next < play.script.length) {
          const item = play.script[play.next++]!;
          if (item === DROP) return;
          if (isClosed(item)) continue;
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
    async sessionUsage() {
      return usage;
    },
    async sessionThreads(sessionId) {
      return threadsOf(sessionId).map(({ thread }) => thread);
    },
    async *threadEvents(sessionId, threadId) {
      yield* threadsOf(sessionId).find(({ thread }) => thread.id === threadId)?.events ?? [];
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
