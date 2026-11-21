import type { RunUsage } from '@officina/core';
import type { ManagedAgentsPort, SessionEvent, SessionThread } from './port';

/** One thread of a finished session with every event it sent, oldest first. */
export interface ThreadRecord {
  readonly thread: SessionThread;
  readonly events: readonly SessionEvent[];
}

export interface ThreadMeasure {
  readonly agentName: string;
  readonly primary: boolean;
  readonly usage: RunUsage;
  /** The model requests the thread made. */
  readonly requests: number;
  /** The largest prompt one of them sent: its uncached input, cache reads and cache writes. */
  readonly peakContext: number;
}

/** A file the primary thread read again after an answer it received had already named it. */
export interface Reread {
  readonly path: string;
  readonly tool: string;
  /** How much the read brought back into the primary thread's context. */
  readonly resultChars: number;
}

export interface SessionMeasure {
  /** The primary thread first. */
  readonly threads: readonly ThreadMeasure[];
  /** The messages the primary thread sent to other threads: the questions it handed off. */
  readonly delegations: number;
  readonly rereads: readonly Reread[];
}

/** A repository path as answers and commands write it: at least one folder and an extension. */
const PATH_PATTERN = /(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z]\w*/g;

/** A shell command that prints a file's content, as opposed to one that only edits or runs it. */
const READING_COMMAND = /\b(?:cat|sed|head|tail|grep|rg|awk|nl|less)\b/;

/**
 * The same file whichever way it is written: the mount point and `./` left out. A path found in a
 * command starts after its leading slash, since the slash is not part of what `PATH_PATTERN` matches.
 */
const normalPath = (path: string): string =>
  path.replace(/^\/?workspace\/[^/]+\//, '').replace(/^\.\//, '');

const pathsIn = (text: string): string[] =>
  [...text.matchAll(PATH_PATTERN)].map((m) => normalPath(m[0]));

const field = (value: unknown, name: string): unknown =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;

const numberField = (value: unknown, name: string): number => {
  const found = field(value, name);
  return typeof found === 'number' ? found : 0;
};

const stringField = (value: unknown, name: string): string => {
  const found = field(value, name);
  return typeof found === 'string' ? found : '';
};

/** The text of an event's content blocks; images and redacted blocks carry none. */
const textOf = (event: SessionEvent): string => {
  const content = event.content;
  return Array.isArray(content)
    ? content.map((block) => stringField(block, 'text')).join('\n')
    : '';
};

/** The files a tool call reads: `read`'s path, or the paths a reading shell command names. */
const pathsRead = (event: SessionEvent): string[] => {
  if (event.name === 'read') {
    const path = stringField(event.input, 'file_path');
    return path ? [normalPath(path)] : [];
  }
  if (event.name !== 'bash') return [];
  const command = stringField(event.input, 'command');
  return READING_COMMAND.test(command) ? pathsIn(command) : [];
};

const measureThread = ({ thread, events }: ThreadRecord): ThreadMeasure => {
  const prompts = events
    .filter((event) => event.type === 'span.model_request_end')
    .map(({ model_usage: usage }) =>
      ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce(
        (sum, name) => sum + numberField(usage, name),
        0
      )
    );
  return {
    agentName: thread.agentName,
    primary: thread.parentId === null,
    usage: thread.usage,
    requests: prompts.length,
    peakContext: Math.max(0, ...prompts)
  };
};

/**
 * The reads of the primary thread that come after an answer naming the same file. Some are
 * expected (a role reads every line it edits), so this is an upper bound on what the reader
 * failed to save it, not a count of mistakes.
 */
const rereadsOf = (events: readonly SessionEvent[]): Reread[] => {
  const resultChars = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'agent.tool_result') {
      resultChars.set(stringField(event, 'tool_use_id'), textOf(event).length);
    }
  }
  const named = new Set<string>();
  const rereads: Reread[] = [];
  for (const event of events) {
    if (event.type === 'agent.thread_message_received') {
      for (const path of pathsIn(textOf(event))) named.add(path);
      continue;
    }
    if (event.type !== 'agent.tool_use') continue;
    for (const path of new Set(pathsRead(event))) {
      if (!named.has(path)) continue;
      rereads.push({ path, tool: String(event.name), resultChars: resultChars.get(event.id) ?? 0 });
    }
  }
  return rereads;
};

/** What a session's threads spent and read, for comparing two ways of running the same work. */
export const measureSession = (records: readonly ThreadRecord[]): SessionMeasure => {
  const primary = records.find(({ thread }) => thread.parentId === null);
  const ordered = primary ? [primary, ...records.filter((record) => record !== primary)] : records;
  const primaryEvents = primary?.events ?? [];
  return {
    threads: ordered.map(measureThread),
    delegations: primaryEvents.filter((event) => event.type === 'agent.thread_message_sent').length,
    rereads: rereadsOf(primaryEvents)
  };
};

/** Every thread of a session with its events, read from the API once the session has stopped. */
export const readSession = async (
  port: ManagedAgentsPort,
  sessionId: string
): Promise<ThreadRecord[]> =>
  Promise.all(
    (await port.sessionThreads(sessionId)).map(async (thread) => {
      const events: SessionEvent[] = [];
      for await (const event of port.threadEvents(sessionId, thread.id)) events.push(event);
      return { thread, events };
    })
  );
