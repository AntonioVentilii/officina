import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  createLoginLink,
  issueConnectorTokens,
  listMemberActivity,
  listUnreadNotifications,
  markNotificationRead,
  purgeExpiredCredentials,
  recordFirstSignIn,
  redeemLoginLink,
  registerConnectorClient
} from '../src';
import { resetAndSeed, type Seeded } from './seed';

const url = process.env.TEST_DATABASE_URL;
const HOUR_MS = 60 * 60 * 1000;

describe.skipIf(!url)('member activity', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const addMember = async (name: string, role: string, projectId = seeded.projectId) =>
    (
      await pool.query<{ id: string }>(
        `with m as (insert into members (workspace_id, display_name, email)
                    select workspace_id, $2, lower($2) || '@example.com' from projects where id = $1
                    returning id)
         insert into project_roles (project_id, member_id, role)
         select $1, id, $3 from m returning member_id as id`,
        [projectId, name, role]
      )
    ).rows[0]!.id;

  const byName = async () =>
    Object.fromEntries(
      (await listMemberActivity(pool, seeded.projectId)).map((member) => [member.name, member])
    );

  test('each member shows their latest link as pending, used or expired, and nothing secret', async () => {
    const tim = await addMember('Tim', 'contributor');
    const gio = await addMember('Gio', 'contributor');
    await addMember('Mia', 'maintainer');
    await createLoginLink(pool, tim, HOUR_MS);
    await createLoginLink(pool, gio, -HOUR_MS);
    const ownerLink = await createLoginLink(pool, seeded.ownerId, HOUR_MS);
    await redeemLoginLink(pool, ownerLink);

    const members = await listMemberActivity(pool, seeded.projectId);
    expect(members.map((member) => [member.name, member.role])).toEqual([
      ['Antonio', 'owner'],
      ['Mia', 'maintainer'],
      ['Gio', 'contributor'],
      ['Tim', 'contributor']
    ]);
    const { Antonio, Tim, Gio, Mia } = await byName();
    expect(Antonio!.link?.state).toBe('used');
    expect(Antonio!.firstSignedInAt).toBeInstanceOf(Date);
    expect(Antonio!.lastSeenAt).toBeInstanceOf(Date);
    expect(Tim!.link?.state).toBe('pending');
    expect(Tim!.firstSignedInAt).toBeNull();
    expect(Tim!.lastSeenAt).toBeNull();
    expect(Gio!.link?.state).toBe('expired');
    expect(Mia!.link).toBeNull();
    expect(Object.keys(Antonio!).sort()).toEqual([
      'claudeConnected',
      'firstSignedInAt',
      'id',
      'lastSeenAt',
      'link',
      'name',
      'role'
    ]);
    expect(Object.keys(Antonio!.link!).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'state',
      'usedAt'
    ]);
  });

  test('a member counts as connected to Claude while a refresh token of theirs is live', async () => {
    const tim = await addMember('Tim', 'contributor');
    expect((await byName()).Tim!.claudeConnected).toBe(false);
    const client = await registerConnectorClient(pool, {
      name: 'Claude',
      redirectUris: ['https://claude.ai/callback']
    });
    await issueConnectorTokens(pool, {
      clientId: client.id,
      memberId: tim,
      resource: 'https://officina.example/mcp',
      accessTtlMs: HOUR_MS,
      refreshTtlMs: HOUR_MS
    });
    expect((await byName()).Tim!.claudeConnected).toBe(true);
    await pool.query("update connector_tokens set expires_at = now() - interval '1 second'");
    expect((await byName()).Tim!.claudeConnected).toBe(false);
  });

  test('the first sign-in tells every owner of each project once, never the member', async () => {
    const tim = await addMember('Tim', 'contributor');
    const coOwner = await addMember('Carla', 'owner');
    const other = (
      await pool.query<{ id: string }>(
        `insert into projects (workspace_id, name, github_repo)
         select workspace_id, 'vici-dataroom', 'ViciApp/vici-dataroom' from projects where id = $1
         returning id`,
        [seeded.projectId]
      )
    ).rows[0]!.id;
    await pool.query(
      `insert into project_roles (project_id, member_id, role)
       values ($1, $2, 'owner'), ($1, $3, 'contributor')`,
      [other, seeded.ownerId, tim]
    );

    expect(await redeemLoginLink(pool, await createLoginLink(pool, tim, HOUR_MS))).not.toBeNull();
    const payloads = async (memberId: string, projectId: string) =>
      (await listUnreadNotifications(pool, memberId, projectId)).map((row) => [
        row.kind,
        row.payload
      ]);
    expect(await payloads(seeded.ownerId, seeded.projectId)).toEqual([
      ['invite_accepted', { memberName: 'Tim', projectName: 'vici-app' }]
    ]);
    expect(await payloads(coOwner, seeded.projectId)).toEqual([
      ['invite_accepted', { memberName: 'Tim', projectName: 'vici-app' }]
    ]);
    expect(await payloads(seeded.ownerId, other)).toEqual([
      ['invite_accepted', { memberName: 'Tim', projectName: 'vici-dataroom' }]
    ]);
    expect(await payloads(tim, seeded.projectId)).toEqual([]);

    const before = (await pool.query('select id from notifications')).rowCount;
    expect(await redeemLoginLink(pool, await createLoginLink(pool, tim, HOUR_MS))).not.toBeNull();
    expect(await recordFirstSignIn(pool, tim)).toBe(0);
    expect((await pool.query('select id from notifications')).rowCount).toBe(before);
  });

  test('an owner signing in for the first time notifies nobody when they are the only owner', async () => {
    await redeemLoginLink(pool, await createLoginLink(pool, seeded.ownerId, HOUR_MS));
    expect((await pool.query('select id from notifications')).rowCount).toBe(0);
  });

  test('a notification is marked read only by the member it is for', async () => {
    const tim = await addMember('Tim', 'contributor');
    await redeemLoginLink(pool, await createLoginLink(pool, tim, HOUR_MS));
    const [notification] = await listUnreadNotifications(pool, seeded.ownerId, seeded.projectId);
    expect(await markNotificationRead(pool, tim, notification!.id)).toBe(false);
    expect(await markNotificationRead(pool, seeded.ownerId, notification!.id)).toBe(true);
    expect(await markNotificationRead(pool, seeded.ownerId, notification!.id)).toBe(true);
    expect(await listUnreadNotifications(pool, seeded.ownerId, seeded.projectId)).toEqual([]);
  });

  test('the purge keeps each member their latest link, so a used or expired invite still shows', async () => {
    const tim = await addMember('Tim', 'contributor');
    const gio = await addMember('Gio', 'contributor');
    await createLoginLink(pool, tim, -HOUR_MS);
    await redeemLoginLink(pool, await createLoginLink(pool, tim, HOUR_MS));
    await createLoginLink(pool, gio, -HOUR_MS);

    expect((await purgeExpiredCredentials(pool)).loginLinks).toBe(1);
    expect((await purgeExpiredCredentials(pool)).loginLinks).toBe(0);
    const { Tim, Gio } = await byName();
    expect(Tim!.link?.state).toBe('used');
    expect(Gio!.link?.state).toBe('expired');
  });
});
