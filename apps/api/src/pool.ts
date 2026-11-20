import { Pool } from 'pg';

/**
 * The API's pool. A connection that drops, idle or checked out, is logged and dropped from the pool,
 * which opens a new one on its next use, so a database outage never ends the process.
 */
export const createPool = (input: {
  connectionString: string;
  log: (message: string, details?: Record<string, unknown>) => void;
}): Pool => {
  const pool = new Pool({ connectionString: input.connectionString });
  pool.on('connect', (client) =>
    client.on('error', (error) => input.log('database connection lost', { error: error.message }))
  );
  // An idle client's error reaches the pool too, once the listener above has logged it; with no
  // listener here the pool would rethrow it and end the process.
  pool.on('error', () => {});
  return pool;
};
