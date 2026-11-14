import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  createLoginLink,
  createTask,
  linkGitHubAccount,
  loadGitHubAccount,
  redeemLoginLink,
  saveGitHubAccount,
  unlinkGitHubAccount
} from '../src';
import { resetAndSeed, type Seeded } from './seed';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('writes in several steps', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Makes every insert into `table` fail, as a crash or a lost connection at that step would. */
  const failInsertsInto = async (table: string) => {
    await pool.query(
      `create function fail_insert() returns trigger language plpgsql as
         $$ begin raise exception 'insert into % failed', tg_table_name; end $$`
    );
    await pool.query(
      `create trigger fail_insert before insert on ${table} for each row execute function fail_insert()`
    );
  };
  const healInsertsInto = async (table: string) => {
    await pool.query(`drop trigger fail_insert on ${table}`);
    await pool.query('drop function fail_insert()');
  };
  const count = async (table: string) =>
    Number((await pool.query<{ n: string }>(`select count(*) as n from ${table}`)).rows[0]!.n);

  test('a sign-in link whose session could not be opened is not spent', async () => {
    const link = await createLoginLink(pool, seeded.ownerId, 60_000);
    await failInsertsInto('sessions');
    await expect(redeemLoginLink(pool, link)).rejects.toThrow('insert into sessions failed');
    await healInsertsInto('sessions');
    expect(await redeemLoginLink(pool, link)).toMatchObject({ memberId: seeded.ownerId });
  });

  test('a GitHub account whose sign-in could not be removed stays linked', async () => {
    await saveGitHubAccount(pool, {
      memberId: seeded.ownerId,
      githubUserId: 42,
      login: 'antonio',
      accessTokenEnc: 'sealed',
      accessExpiresAt: null,
      refreshTokenEnc: null,
      refreshExpiresAt: null
    });
    await pool.query(
      `create function fail_delete() returns trigger language plpgsql as
         $$ begin raise exception 'delete from % failed', tg_table_name; end $$`
    );
    await pool.query(
      'create trigger fail_delete before delete on identities for each row execute function fail_delete()'
    );
    await expect(unlinkGitHubAccount(pool, seeded.ownerId)).rejects.toThrow(
      'delete from identities failed'
    );
    expect(await count('github_accounts')).toBe(1);
  });

  test('a GitHub account whose identity could not be stored is not linked at all', async () => {
    const account = {
      memberId: seeded.ownerId,
      githubUserId: 42,
      login: 'antonio',
      accessTokenEnc: 'sealed',
      accessExpiresAt: null,
      refreshTokenEnc: null,
      refreshExpiresAt: null
    };
    await failInsertsInto('identities');
    await expect(saveGitHubAccount(pool, account)).rejects.toThrow('insert into identities failed');
    expect(await count('github_accounts')).toBe(0);
    await healInsertsInto('identities');
    await saveGitHubAccount(pool, account);
    expect(await count('github_accounts')).toBe(1);
  });

  test('a GitHub account whose move could not be logged stays with the member who had it', async () => {
    const account = {
      memberId: seeded.ownerId,
      githubUserId: 42,
      login: 'antonio',
      accessTokenEnc: 'sealed',
      accessExpiresAt: null,
      refreshTokenEnc: null,
      refreshExpiresAt: null
    };
    await linkGitHubAccount(pool, account);
    const { rows } = await pool.query<{ id: string }>(
      `insert into members (workspace_id, email, display_name)
       select workspace_id, 'gio@example.com', 'Gio' from members where id = $1 returning id`,
      [seeded.ownerId]
    );
    await failInsertsInto('access_events');
    await expect(linkGitHubAccount(pool, { ...account, memberId: rows[0]!.id })).rejects.toThrow(
      'insert into access_events failed'
    );
    expect(await loadGitHubAccount(pool, seeded.ownerId)).toMatchObject({ githubUserId: 42 });
    expect(await count('github_accounts')).toBe(1);
  });

  test('a request whose text could not be stored leaves no task behind', async () => {
    const before = await count('tasks');
    const request = {
      projectId: seeded.projectId,
      title: 'Rename the settings title',
      requesterId: seeded.ownerId,
      request: 'Please call it Preferences.'
    };
    await failInsertsInto('comments');
    await expect(createTask(pool, request)).rejects.toThrow('insert into comments failed');
    expect(await count('tasks')).toBe(before);
    await healInsertsInto('comments');
    const { task } = await createTask(pool, request);
    const comments = await pool.query<{ body: string }>(
      'select body from comments where task_id = $1',
      [task.id]
    );
    expect(comments.rows).toEqual([{ body: 'Please call it Preferences.' }]);
  });
});
