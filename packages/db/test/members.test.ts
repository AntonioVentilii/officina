import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  createInviteLink,
  createLoginLink,
  issueConnectorTokens,
  listMemberActivity,
  listUnreadNotifications,
  markNotificationRead,
  purgeExpiredCredentials,
  inTransaction,
  recordFirstSignIn,
  redeemLoginLink,
  registerConnectorClient
} from '../src';
import { backendPid, untilWaitingOn } from './locks';
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
      'domains',
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
    expect(await inTransaction(pool, (client) => recordFirstSignIn(client, tim))).toBe(0);
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
  test('a fresh invite link waits for a first sign-in in flight and is refused once it lands', async () => {
    const tim = await addMember('Tim', 'contributor');
    const mint = (memberId: string) =>
      createInviteLink(pool, {
        projectId: seeded.projectId,
        memberId,
        viewerId: seeded.ownerId,
        ttlMs: HOUR_MS
      });
    const signing = await pool.connect();
    try {
      await signing.query('begin');
      await recordFirstSignIn(signing, tim);
      const minting = mint(tim);
      await untilWaitingOn(pool, await backendPid(signing));
      await signing.query('commit');
      expect(await minting).toEqual({ ok: false, error: 'signed_in', name: 'Tim' });
    } finally {
      signing.release();
    }
    expect(
      (await pool.query('select 1 from login_links where member_id = $1', [tim])).rowCount
    ).toBe(0);
    expect(await mint(await addMember('Gio', 'contributor'))).toMatchObject({ ok: true });
    expect(await mint(crypto.randomUUID())).toEqual({
      ok: false,
      error: 'not_member'
    });
  });

  test('a fresh invite link needs every project the member is in, and replaces a pending one', async () => {
    const tim = await addMember('Tim', 'contributor');
    const other = (
      await pool.query<{ id: string }>(
        `insert into projects (workspace_id, name, github_repo)
         select workspace_id, 'vici-dataroom', 'ViciApp/vici-dataroom' from projects where id = $1
         returning id`,
        [seeded.projectId]
      )
    ).rows[0]!.id;
    await pool.query(
      "insert into project_roles (project_id, member_id, role) values ($1, $2, 'owner')",
      [other, tim]
    );
    const mint = () =>
      createInviteLink(pool, {
        projectId: seeded.projectId,
        memberId: tim,
        viewerId: seeded.ownerId,
        ttlMs: HOUR_MS
      });
    // The link would sign in as Tim where he owns a project the viewer has no part in.
    expect(await mint()).toEqual({ ok: false, error: 'other_projects', name: 'Tim' });
    await pool.query(
      "insert into project_roles (project_id, member_id, role) values ($1, $2, 'maintainer')",
      [other, seeded.ownerId]
    );
    expect(await mint()).toEqual({ ok: false, error: 'other_projects', name: 'Tim' });
    await pool.query(
      "update project_roles set role = 'owner' where project_id = $1 and member_id = $2",
      [other, seeded.ownerId]
    );

    const pending = await createLoginLink(pool, tim, HOUR_MS);
    const fresh = await mint();
    if (!fresh.ok) throw new Error('expected a link');
    expect(await redeemLoginLink(pool, pending)).toBeNull();
    expect(await redeemLoginLink(pool, fresh.token)).toMatchObject({ memberId: tim });
  });

  test('members with a session, GitHub or Claude count as joined, and their pending links end', async () => {
    const tim = await addMember('Tim', 'contributor');
    const gio = await addMember('Gio', 'contributor');
    const ada = await addMember('Ada', 'contributor');
    // As a member whose first link was purged before sign-ins were recorded would be.
    await pool.query(
      'insert into sessions (token_hash, member_id, expires_at) values ($1, $2, now())',
      ['old-session', tim]
    );
    const client = await registerConnectorClient(pool, {
      name: 'Claude',
      redirectUris: ['https://claude.ai/cb']
    });
    await issueConnectorTokens(pool, {
      clientId: client.id,
      memberId: gio,
      resource: 'https://officina.example/mcp',
      accessTtlMs: HOUR_MS,
      refreshTtlMs: HOUR_MS
    });
    const timLink = await createLoginLink(pool, tim, HOUR_MS);
    const adaLink = await createLoginLink(pool, ada, HOUR_MS);

    const sql = await Bun.file(
      new URL('../migrations/0020_member_joined.sql', import.meta.url)
    ).text();
    await pool.query(sql);
    await pool.query(sql);

    const members = await byName();
    expect(members.Tim!.firstSignedInAt).not.toBeNull();
    expect(members.Gio!.firstSignedInAt).not.toBeNull();
    expect(members.Ada!.firstSignedInAt).toBeNull();
    expect(await redeemLoginLink(pool, timLink)).toBeNull();
    expect(await redeemLoginLink(pool, adaLink)).toMatchObject({ memberId: ada });
  });
});
