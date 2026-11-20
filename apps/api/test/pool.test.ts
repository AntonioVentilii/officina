import { afterAll, describe, expect, test } from 'bun:test';
import { Client, Pool } from 'pg';
import { CONNECTION_TIMEOUT_MS, createPool, QUERY_TIMEOUT_MS } from '../src/pool';

const url = process.env.TEST_DATABASE_URL;
const LOST = 'database connection lost';

/** A fake log that records every entry and resolves `lost` on the first lost connection. */
const recordingLog = () => {
  const entries: [string, Record<string, unknown> | undefined][] = [];
  let markLost: () => void = () => {};
  const lost = new Promise<void>((resolve) => {
    markLost = resolve;
  });
  const log = (message: string, details?: Record<string, unknown>) => {
    entries.push([message, details]);
    if (message === LOST) markLost();
  };
  return { entries, lost, log };
};

const expectLostLogged = (entries: [string, Record<string, unknown> | undefined][]) => {
  const lost = entries.filter(([message]) => message === LOST);
  expect(lost.length).toBeGreaterThan(0);
  for (const [, details] of lost) {
    expect(typeof details?.error).toBe('string');
    expect(String(details?.error)).not.toBe('');
  }
};

describe('database pool', () => {
  test('a dropped connection is logged and does not throw', async () => {
    const { entries, log } = recordingLog();
    const pool = createPool({ connectionString: 'postgres://localhost:1/none', log });
    const client = new Client();
    expect(() => pool.emit('connect', client)).not.toThrow();
    expect(() =>
      client.emit('error', new Error('Connection terminated unexpectedly'))
    ).not.toThrow();
    expect(() =>
      pool.emit('error', new Error('Connection terminated unexpectedly'), client)
    ).not.toThrow();
    expect(entries).toContainEqual([LOST, { error: 'Connection terminated unexpectedly' }]);
    await pool.end();
  });

  test('the pool limits how long a query and a checkout may wait, and keeps idle connections alive', async () => {
    const { log } = recordingLog();
    const pool = createPool({ connectionString: 'postgres://localhost:1/none', log });
    expect(pool.options.query_timeout).toBe(QUERY_TIMEOUT_MS);
    expect(pool.options.connectionTimeoutMillis).toBe(CONNECTION_TIMEOUT_MS);
    expect(pool.options.keepAlive).toBe(true);
    await pool.end();
  });
});

describe.skipIf(!url)('database pool against Postgres', () => {
  const admin = new Pool({ connectionString: url });

  afterAll(async () => {
    await admin.end();
  });

  const terminate = async (pid: number) => {
    await admin.query('select pg_terminate_backend($1, 5000)', [pid]);
  };

  test('an idle connection that drops is logged and replaced, and the pool keeps working', async () => {
    const { entries, lost, log } = recordingLog();
    const pool = createPool({ connectionString: url!, log });
    try {
      const { pid } = (await pool.query<{ pid: number }>('select pg_backend_pid() as pid'))
        .rows[0]!;
      await terminate(pid);
      await lost;

      const after = (
        await pool.query<{ one: number; pid: number }>('select 1 as one, pg_backend_pid() as pid')
      ).rows[0]!;
      expect(after.one).toBe(1);
      expect(after.pid).not.toBe(pid);
      expectLostLogged(entries);
    } finally {
      await pool.end();
    }
  });

  test('a checked-out connection that drops is logged, and the pool keeps working after it is released', async () => {
    const { entries, lost, log } = recordingLog();
    const pool = createPool({ connectionString: url!, log });
    try {
      const client = await pool.connect();
      const { pid } = (await client.query<{ pid: number }>('select pg_backend_pid() as pid'))
        .rows[0]!;
      await terminate(pid);
      await lost;

      await expect(client.query('select 1')).rejects.toThrow();
      client.release();

      const after = (await pool.query<{ one: number }>('select 1 as one')).rows[0]!;
      expect(after.one).toBe(1);
      expectLostLogged(entries);
    } finally {
      await pool.end();
    }
  });
});
