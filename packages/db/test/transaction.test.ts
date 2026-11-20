import { afterAll, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { inTransaction } from '../src';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('a transaction whose connection goes silent', () => {
  // One connection, so the query after the transaction can only get a healthy one if the silent
  // one was discarded. The timeout stands in for the API pool's, short enough for a test.
  const timeoutMs = 1_000;
  const pool = new Pool({ connectionString: url, max: 1, query_timeout: timeoutMs });
  pool.on('connect', (client) => client.on('error', () => {}));
  pool.on('error', () => {});

  afterAll(async () => {
    await pool.end();
  });

  test("throws the work's error and discards the connection, so the next query does not wait on it", async () => {
    // A query that outlives the timeout looks, from the client, like a peer that stopped answering.
    const started = Date.now();
    const work = inTransaction(pool, (client) => client.query('select pg_sleep(30)'));
    await expect(work).rejects.toThrow('Query read timeout');
    // A rollback sent behind the silent query would wait out a second timeout before giving up.
    expect(Date.now() - started).toBeLessThan(timeoutMs * 1.8);

    const after = (await pool.query<{ one: number }>('select 1 as one')).rows[0]!;
    expect(after.one).toBe(1);
  }, 5_000);
});
