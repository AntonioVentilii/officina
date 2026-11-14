import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { issueConnectorTokens, registerConnectorClient } from '@officina/db';
import { Pool } from 'pg';
import { resetAndSeed, type Seeded } from '../../../packages/db/test/seed';
import { accessLogView, invite, inviteAgain, loginLink, membersText } from '../src/people';

const url = process.env.TEST_DATABASE_URL;
const PUBLIC_URL = 'https://officina.example';

describe.skipIf(!url)('members command', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const inviteAs = (name: string, role: string) =>
    invite(pool, {
      publicUrl: PUBLIC_URL,
      email: `${name.toLowerCase()}@example.com`,
      name,
      role,
      domains: []
    });

  const memberId = async (name: string) =>
    (await pool.query<{ id: string }>('select id from members where display_name = $1', [name]))
      .rows[0]!.id;

  /** Pins a member's latest link and sign-in times, so the table reads the same on every run. */
  const pin = async (
    name: string,
    times: { created: string; expires: string; used?: string; seen?: string }
  ) => {
    const id = await memberId(name);
    await pool.query(
      'update login_links set created_at = $2, expires_at = $3, used_at = $4 where member_id = $1',
      [id, times.created, times.expires, times.used ?? null]
    );
    await pool.query('update members set first_signed_in_at = $2 where id = $1', [
      id,
      times.used ?? null
    ]);
    if (times.seen)
      await pool.query(
        'insert into sessions (token_hash, member_id, expires_at, last_seen_at) values ($1, $2, $3, $3)',
        [`hash-${name}`, id, times.seen]
      );
  };

  test('lists each member with when they joined, their latest link, last visit and Claude', async () => {
    await loginLink(pool, { publicUrl: PUBLIC_URL });
    await pin('Antonio', {
      created: '2026-11-12T21:04:00Z',
      expires: '2026-11-12T21:34:00Z',
      used: '2026-11-12T21:10:00Z',
      seen: '2099-01-01T06:58:00Z'
    });
    await inviteAs('Tim', 'contributor');
    await pin('Tim', { created: '2026-11-12T22:15:00Z', expires: '2099-01-01T22:15:00Z' });
    await inviteAs('Gio', 'contributor');
    await pin('Gio', { created: '2026-11-05T22:15:00Z', expires: '2026-11-12T22:15:00Z' });
    await inviteAs('Mia', 'maintainer');
    await pool.query('delete from login_links where member_id = $1', [await memberId('Mia')]);
    const client = await registerConnectorClient(pool, {
      name: 'Claude',
      redirectUris: ['https://claude.ai/callback']
    });
    await issueConnectorTokens(pool, {
      clientId: client.id,
      memberId: seeded.ownerId,
      resource: `${PUBLIC_URL}/mcp`,
      accessTtlMs: 60_000,
      refreshTtlMs: 60_000
    });

    expect(await membersText(pool, { repo: 'ViciApp/vici-app' })).toBe(
      [
        'NAME     ROLE         JOINED                LINK SENT             LINK USED                                   LAST SEEN             CLAUDE',
        'Antonio  owner        2026-11-12 21:10 UTC  2026-11-12 21:04 UTC  2026-11-12 21:10 UTC                        2099-01-01 06:58 UTC  connected',
        'Mia      maintainer   not yet               -                     -                                           -                     no',
        'Gio      contributor  not yet               2026-11-05 22:15 UTC  expired 2026-11-12 22:15 UTC                -                     no',
        'Tim      contributor  not yet               2026-11-12 22:15 UTC  not yet (valid until 2099-01-01 22:15 UTC)  -                     no'
      ].join('\n')
    );
  });

  test("a project's access log leaves out the invites and links of the member's other projects", async () => {
    await pool.query(
      `insert into projects (workspace_id, name, github_repo)
       select workspace_id, 'secret', 'ViciApp/secret' from projects where id = $1`,
      [seeded.projectId]
    );
    const other = (
      await pool.query<{ id: string }>(
        "select id from projects where github_repo = 'ViciApp/secret'"
      )
    ).rows[0]!.id;
    const inviteBea = (repo: string, role: string) =>
      invite(pool, {
        publicUrl: PUBLIC_URL,
        email: 'bea@example.com',
        name: 'Bea',
        role,
        domains: [],
        repo
      });
    await inviteBea('ViciApp/vici-app', 'contributor');
    await inviteBea('ViciApp/secret', 'maintainer');
    await loginLink(pool, { publicUrl: PUBLIC_URL, email: 'bea@example.com' });
    await pool.query(
      "insert into project_roles (project_id, member_id, role) values ($1, $2, 'owner')",
      [other, seeded.ownerId]
    );
    await inviteAgain(pool, {
      publicUrl: PUBLIC_URL,
      projectId: other,
      viewerRole: 'owner',
      viewerId: seeded.ownerId,
      memberId: await memberId('Bea')
    });

    const texts = async (projectId: string) =>
      (await accessLogView(pool, projectId))
        .filter((event) => event.member === 'Bea')
        .map((event) => event.text);
    expect(await texts(seeded.projectId)).toEqual([
      'was sent a sign-in link from the server CLI',
      'was invited to ViciApp/vici-app as contributor from the server CLI'
    ]);
    expect(await texts(other)).toEqual([
      'was sent a sign-in link by Antonio',
      'was sent a sign-in link from the server CLI',
      'was invited to ViciApp/secret as maintainer from the server CLI'
    ]);
  });

  test('an unknown repository is named in the error', async () => {
    await expect(membersText(pool, { repo: 'ViciApp/nope' })).rejects.toThrow(
      'no project for ViciApp/nope'
    );
  });
});
