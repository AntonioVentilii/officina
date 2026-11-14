import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  issueConnectorTokens,
  listAccessEvents,
  lockConnectorGrant,
  recordConnectorUse,
  registerConnectorClient,
  revokeConnectorGrant
} from '../src';
import { backendPid, untilWaitingOn } from './locks';
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
      let finished = false;
      const second = recordConnectorUse(other, used).then(() => (finished = true));
      await untilWaitingOn(pool, await backendPid(one), () => finished);
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
    await untilWaitingOn(pool, await backendPid(rotation));
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

  test('the migration gives past project events their project and hides those it cannot place', async () => {
    const { rows } = await pool.query<{ id: string; member: string }>(
      `with p as (insert into projects (workspace_id, name, github_repo)
                  select workspace_id, 'secret', 'ViciApp/secret' from projects where id = $1
                  returning id, workspace_id),
            m as (insert into members (workspace_id, display_name, email)
                  select workspace_id, 'Bea', 'bea@example.com' from p returning id),
            r as (insert into project_roles (project_id, member_id, role)
                  select p.id, m.id, 'contributor' from p, m
                  union all select $1, m.id, 'contributor' from m
                  union all select p.id, $2, 'owner' from p
                  returning project_id)
       select p.id, m.id as member from p, m limit 1`,
      [seeded.projectId, seeded.ownerId]
    );
    const [{ id: other, member: bea }] = rows as [{ id: string; member: string }];
    const legacy = async (type: string, detail: object, actor: string | null = null) =>
      (
        await pool.query<{ id: string }>(
          `insert into access_events (member_id, actor_member_id, type, detail)
           values ($1, $2, $3, $4) returning id::text`,
          [bea, actor, type, JSON.stringify(detail)]
        )
      ).rows[0]!.id;
    const here = await legacy('invited', {
      project: 'ViciApp/vici-app',
      role: 'contributor',
      via: 'cli'
    });
    const there = await legacy('invited', {
      project: 'ViciApp/secret',
      role: 'contributor',
      via: 'cli'
    });
    const gone = await legacy('invited', { project: 'ViciApp/gone', role: 'owner', via: 'cli' });
    const sent = await legacy('sign_in_link_created', {}, seeded.ownerId);
    // Sent from the board by someone who no longer shares a project with Bea.
    const stranger = (
      await pool.query<{ id: string }>(
        `insert into members (workspace_id, display_name, email)
         select workspace_id, 'Cy', 'cy@example.com' from projects where id = $1 returning id`,
        [seeded.projectId]
      )
    ).rows[0]!.id;
    const stranded = await legacy('sign_in_link_created', {}, stranger);
    const cli = await legacy('sign_in_link_created', { via: 'cli' });
    const signedIn = await legacy('signed_in', { method: 'link' });

    const sql = await Bun.file(
      join(import.meta.dir, '..', 'migrations', '0024_access_event_project.sql')
    ).text();
    await pool.query(sql.slice(sql.indexOf('update access_events')));

    const { rows: events } = await pool.query<{
      id: string;
      project_id: string | null;
      hidden: boolean;
    }>('select id::text, project_id, hidden from access_events where member_id = $1', [bea]);
    const placed = new Map(events.map((row) => [row.id, row.project_id]));
    expect(placed.get(here)).toBe(seeded.projectId);
    expect(placed.get(there)).toBe(other);
    expect([seeded.projectId, other]).toContain(placed.get(sent)!);
    expect(placed.get(cli)).toBeNull();
    expect(placed.get(signedIn)).toBeNull();
    // What cannot be placed is kept, hidden, and in no project's log.
    expect(events.filter((row) => row.hidden).map((row) => row.id)).toEqual(
      expect.arrayContaining([gone, stranded])
    );
    expect(events.filter((row) => row.hidden)).toHaveLength(2);
    const shown = [
      ...(await listAccessEvents(pool, seeded.projectId, 100)),
      ...(await listAccessEvents(pool, other, 100))
    ].map((event) => event.id);
    expect(shown).toEqual(expect.arrayContaining([here, there, sent, cli, signedIn]));
    expect(shown).not.toContain(gone);
    expect(shown).not.toContain(stranded);
  });
});
