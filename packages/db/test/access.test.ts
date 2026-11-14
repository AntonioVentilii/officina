import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  issueConnectorTokens,
  lockConnectorGrant,
  recordConnectorUse,
  registerConnectorClient,
  revokeConnectorGrant
} from '../src';
import { resetAndSeed, type Seeded } from './seed';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('access log', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const use = (clientId: string) =>
    issueConnectorTokens(pool, {
      clientId,
      memberId: seeded.ownerId,
      resource: 'https://officina.example/mcp',
      accessTtlMs: 60_000,
      refreshTtlMs: 60_000
    });

  const uses = async () =>
    (
      await pool.query<{ detail: Record<string, string> }>(
        `select detail from access_events where type = 'connector_used' order by id`
      )
    ).rows.map((row) => row.detail);

  test('two apps with the same name are each logged once a day, by their client id', async () => {
    const redirectUris = ['https://claude.ai/api/mcp/auth_callback'];
    const first = await registerConnectorClient(pool, { name: 'Claude', redirectUris });
    const second = await registerConnectorClient(pool, { name: 'Claude', redirectUris });
    await use(first.id);
    await use(first.id);
    await use(second.id);
    expect(await uses()).toEqual([
      { clientId: first.id, client: 'Claude' },
      { clientId: second.id, client: 'Claude' }
    ]);
  });

  const waitsOnALock = async (pid: number) =>
    (
      await pool.query<{ wait: string | null }>(
        'select wait_event_type as wait from pg_stat_activity where pid = $1',
        [pid]
      )
    ).rows[0]?.wait === 'Lock';

  test('two refreshes at the same moment still log one use for the day', async () => {
    const app = await registerConnectorClient(pool, { name: 'Claude', redirectUris: [] });
    const used = { memberId: seeded.ownerId, clientId: app.id, clientName: app.name };
    const one = await pool.connect();
    const other = await pool.connect();
    try {
      await one.query('begin');
      await other.query('begin');
      await recordConnectorUse(one, used);
      // The second starts before the first commits, as two refreshes racing would: it either
      // finishes without seeing the first one's row, or waits for it.
      const otherPid = (await other.query<{ pid: number }>('select pg_backend_pid() as pid'))
        .rows[0]!.pid;
      let finished = false;
      const second = recordConnectorUse(other, used).then(() => (finished = true));
      while (!finished && !(await waitsOnALock(otherPid))) await Bun.sleep(5);
      await one.query('commit');
      await second;
      await other.query('commit');
    } finally {
      one.release();
      other.release();
    }
    expect(await uses()).toHaveLength(1);
  });

  test('a revoke waits for a rotation in flight and deletes the tokens it issued too', async () => {
    const app = await registerConnectorClient(pool, { name: 'Claude', redirectUris: [] });
    await use(app.id);
    const grantId = (
      await pool.query<{ grant_id: string }>('select grant_id from connector_tokens limit 1')
    ).rows[0]!.grant_id;
    // A rotation holds the grant and its refresh row while it issues the next tokens.
    const rotation = await pool.connect();
    await rotation.query('begin');
    await lockConnectorGrant(rotation, grantId);
    await rotation.query(
      "select 1 from connector_tokens where grant_id = $1 and kind = 'refresh' for update",
      [grantId]
    );
    const revoked = revokeConnectorGrant(pool, seeded.ownerId, grantId);
    await Bun.sleep(50);
    await issueConnectorTokens(rotation, {
      clientId: app.id,
      memberId: seeded.ownerId,
      resource: 'https://officina.example/mcp',
      grantId,
      accessTtlMs: 60_000,
      refreshTtlMs: 60_000
    });
    await rotation.query('commit');
    rotation.release();
    expect(await revoked).toBe(true);
    expect(
      (await pool.query('select 1 from connector_tokens where grant_id = $1', [grantId])).rowCount
    ).toBe(0);
  });
});
