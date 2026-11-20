import { Pool } from 'pg';

/**
 * How long a query may wait for its answer. A connection whose peer vanished without closing it
 * never answers, and without this limit the step awaiting it, and the run it holds, wait forever.
 */
export const QUERY_TIMEOUT_MS = 60_000;

/** How long opening a connection, or waiting for a free one in the pool, may take. */
export const CONNECTION_TIMEOUT_MS = 30_000;

/** How soon an idle connection starts sending TCP keepalives, so a dead peer is found and dropped. */
const KEEPALIVE_DELAY_MS = 10_000;

/**
 * The API's pool. A connection that drops, idle or checked out, is logged and dropped from the pool,
 * which opens a new one on its next use, so a database outage never ends the process. A connection
 * that goes silent instead fails its query after `QUERY_TIMEOUT_MS` and is dropped the same way.
 */
export const createPool = (input: {
  connectionString: string;
  log: (message: string, details?: Record<string, unknown>) => void;
}): Pool => {
  const pool = new Pool({
    connectionString: input.connectionString,
    query_timeout: QUERY_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS
  });
  pool.on('connect', (client) =>
    client.on('error', (error) => input.log('database connection lost', { error: error.message }))
  );
  // An idle client's error reaches the pool too, once the listener above has logged it; with no
  // listener here the pool would rethrow it and end the process.
  pool.on('error', () => {});
  return pool;
};
