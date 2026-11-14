import { listenForChanges, locateRun, locateTask, pingConnection } from '@officina/db';
import { Client, type Pool } from 'pg';

export type BoardEvent =
  | { readonly kind: 'task'; readonly projectId: string; readonly number: number }
  | {
      readonly kind: 'run';
      readonly projectId: string;
      readonly number: number;
      readonly runId: string;
    };

export interface RealtimeHub {
  subscribe(listener: (event: BoardEvent) => void): () => void;
  close(): Promise<void>;
}

type Notification = { kind: 'task'; taskId: string } | { kind: 'run'; runId: string };

const RECONNECT_MS = 2_000;
// Something between the API and Fly Postgres drops a connection idle for 30 minutes, and a client
// that only listens looks idle. A trivial query every few minutes keeps it open.
const KEEPALIVE_MS = 5 * 60_000;

/**
 * Listens to the database's change channel and fans each change out to open boards. A task or run
 * never moves between projects, so where it belongs is looked up once and cached.
 */
export const startRealtime = async (input: {
  connectionString: string;
  pool: Pool;
  log: (message: string, details?: Record<string, unknown>) => void;
  keepaliveMs?: number;
}): Promise<RealtimeHub> => {
  const listeners = new Set<(event: BoardEvent) => void>();
  const taskPlaces = new Map<string, { projectId: string; number: number } | null>();
  const runPlaces = new Map<string, { projectId: string; number: number } | null>();
  let client: Client | null = null;
  let closed = false;

  const place = async (notification: Notification) => {
    if (notification.kind === 'task') {
      if (!taskPlaces.has(notification.taskId))
        taskPlaces.set(notification.taskId, await locateTask(input.pool, notification.taskId));
      return taskPlaces.get(notification.taskId) ?? null;
    }
    if (!runPlaces.has(notification.runId))
      runPlaces.set(notification.runId, await locateRun(input.pool, notification.runId));
    return runPlaces.get(notification.runId) ?? null;
  };

  const emit = async (raw: string | undefined) => {
    if (!raw || listeners.size === 0) return;
    const notification = JSON.parse(raw) as Notification;
    const found = await place(notification);
    if (!found) return;
    const event: BoardEvent =
      notification.kind === 'run'
        ? { kind: 'run', ...found, runId: notification.runId }
        : { kind: 'task', ...found };
    for (const listener of listeners) listener(event);
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    const next = new Client({
      connectionString: input.connectionString,
      application_name: 'officina-realtime'
    });
    next.on('notification', (message) => {
      emit(message.payload).catch((error: unknown) =>
        input.log('realtime event dropped', { error: (error as Error).message })
      );
    });
    next.on('error', (error) => {
      input.log('realtime connection lost', { error: error.message });
      next.end().catch(() => {});
      if (client === next) client = null;
      setTimeout(() => void connect().catch(() => {}), RECONNECT_MS);
    });
    try {
      await next.connect();
      await listenForChanges(next);
      client = next;
    } catch (error) {
      input.log('realtime connect failed', { error: (error as Error).message });
      await next.end().catch(() => {});
      setTimeout(() => void connect().catch(() => {}), RECONNECT_MS);
    }
  };

  await connect();
  // A failed ping needs no handling here: a dead connection also emits 'error', which reconnects.
  const keepalive = setInterval(
    () => void (client && pingConnection(client).catch(() => {})),
    input.keepaliveMs ?? KEEPALIVE_MS
  );

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => {
      closed = true;
      clearInterval(keepalive);
      await client?.end().catch(() => {});
    }
  };
};
