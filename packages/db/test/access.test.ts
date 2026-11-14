import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { issueConnectorTokens, registerConnectorClient } from '../src';
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
});
