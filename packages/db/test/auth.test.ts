import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import {
  createLoginLink,
  createOAuthState,
  createSession,
  memberForSession,
  purgeExpiredCredentials,
  redeemLoginLink,
  spendOAuthState
} from '../src';
import { resetAndSeed, type Seeded } from './seed';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('credentials', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const count = async (table: string) =>
    Number((await pool.query<{ n: string }>(`select count(*) as n from ${table}`)).rows[0]!.n);

  test('the purge removes only links, sessions and states that can no longer be used', async () => {
    const live = await createSession(pool, seeded.ownerId);
    const old = await createSession(pool, seeded.ownerId);
    await pool.query(
      "update sessions set expires_at = now() - interval '1 second' where token_hash = $1",
      [createHash('sha256').update(old).digest('hex')]
    );
    const used = await createLoginLink(pool, seeded.ownerId, 60_000);
    await redeemLoginLink(pool, used);
    await createLoginLink(pool, seeded.ownerId, -1_000);
    const unused = await createLoginLink(pool, seeded.ownerId, 60_000);
    await createOAuthState(pool, 'old', seeded.ownerId, -1_000);
    await createOAuthState(pool, 'new', seeded.ownerId, 60_000);

    const sessionsBefore = await count('sessions');
    const purged = await purgeExpiredCredentials(pool);
    expect(purged).toEqual({ loginLinks: 2, sessions: 1, oauthStates: 1 });
    expect(await count('sessions')).toBe(sessionsBefore - 1);
    expect(await count('login_links')).toBe(1);
    expect(await count('oauth_states')).toBe(1);
    expect(await redeemLoginLink(pool, unused)).not.toBeNull();
    expect(await memberForSession(pool, live)).not.toBeNull();
  });

  test('a state that was never stored can be spent once', async () => {
    const expires = new Date(Date.now() + 60_000);
    expect(await spendOAuthState(pool, 's.1.abc', expires)).toBe(true);
    expect(await spendOAuthState(pool, 's.1.abc', expires)).toBe(false);
  });
});
