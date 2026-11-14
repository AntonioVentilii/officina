import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client, Pool } from 'pg';
import {
  AGENT_ROLES,
  GUARDS,
  LANES,
  LEARNING_TARGETS,
  ROLES,
  STAGES,
  TASK_KINDS
} from '@officina/core';
import { migrate, upsertWorkspace } from '../src';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('migrations', () => {
  const client = new Client({ connectionString: url });
  let taskId: string;

  beforeAll(async () => {
    await client.connect();
    await client.query('drop schema public cascade; create schema public;');
  });

  afterAll(async () => {
    await client.end();
  });

  test('apply once and are idempotent', async () => {
    expect(await migrate(client)).toEqual([
      '0001_init.sql',
      '0002_webhook_deliveries.sql',
      '0003_runs_and_agents.sql',
      '0004_project_environments.sql',
      '0005_board.sql',
      '0006_approval_plans.sql',
      '0007_learnings.sql',
      '0008_github_accounts.sql',
      '0009_onboarding.sql',
      '0010_learning_docs.sql',
      '0011_connector.sql',
      '0012_webhook_handled.sql',
      '0013_member_activity.sql',
      '0014_task_guards.sql',
      '0015_learning_rewrite.sql',
      '0016_workspace_name_unique.sql',
      '0017_access_events.sql',
      '0018_connector_use_daily.sql',
      '0019_connector_revoke.sql',
      '0020_member_joined.sql',
      '0021_run_learning.sql',
      '0022_run_refs.sql',
      '0023_learning_branch_commit.sql',
      '0024_access_event_project.sql'
    ]);
    expect(await migrate(client)).toEqual([]);
  });

  test('check constraints list exactly the values the core package knows', async () => {
    const definition = async (name: string) =>
      (
        await client.query<{ def: string }>(
          'select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1',
          [name]
        )
      ).rows[0]?.def ?? '';
    const quoted = (def: string) =>
      [...def.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
    expect(quoted(await definition('tasks_stage_check'))).toEqual([...STAGES].sort());
    expect(quoted(await definition('tasks_lane_check'))).toEqual([...LANES].sort());
    expect(quoted(await definition('project_roles_role_check'))).toEqual([...ROLES].sort());
    expect(quoted(await definition('tasks_kind_check'))).toEqual([...TASK_KINDS].sort());
    expect(quoted(await definition('tasks_guards_check'))).toEqual([...GUARDS].sort());
    expect(quoted(await definition('runs_agent_role_check'))).toEqual([...AGENT_ROLES].sort());
    expect(quoted(await definition('agent_versions_role_check'))).toEqual([...AGENT_ROLES].sort());
    expect(quoted(await definition('learnings_target_check'))).toEqual(
      [...LEARNING_TARGETS].sort()
    );
  });

  test('task events are append-only', async () => {
    const { rows } = await client.query<{ task_id: string }>(`
      with w as (insert into workspaces (name) values ('vici') returning id),
      m as (insert into members (workspace_id, display_name, email)
            select id, 'Antonio', 'a@example.com' from w returning id, workspace_id),
      p as (insert into projects (workspace_id, name, github_repo)
            select workspace_id, 'vici-app', 'ViciApp/vici-app' from m returning id),
      t as (insert into tasks (project_id, number, title, requester_id, stage)
            select p.id, 1, 'Fix copy', m.id, 'request' from p, m returning id)
      select id as task_id from t`);
    taskId = rows[0]!.task_id;
    await client.query(
      `insert into task_events (task_id, actor, type, payload) values ($1, '{"kind":"engine"}', 'stage_changed', '{}')`,
      [taskId]
    );
    await expect(client.query('update task_events set type = $1', ['tampered'])).rejects.toThrow(
      'append-only'
    );
    await expect(client.query('delete from task_events')).rejects.toThrow('append-only');
    await expect(client.query('truncate task_events cascade')).rejects.toThrow('append-only');
  });

  test('unknown stages are rejected', async () => {
    await expect(
      client.query(`update tasks set stage = 'shipped' where id = $1`, [taskId])
    ).rejects.toThrow('tasks_stage_check');
  });

  test('a workspace name held twice before names were unique keeps both workspaces', async () => {
    await client.query(
      "delete from schema_migrations where name = '0016_workspace_name_unique.sql'"
    );
    await client.query('drop index workspaces_name');
    const { rows } = await client.query<{ id: string }>(
      `insert into workspaces (name, created_at)
       values ('twin', now() - interval '1 day'), ('twin', now()) returning id`
    );
    expect(await migrate(client)).toEqual(['0016_workspace_name_unique.sql']);
    const names = await client.query<{ id: string; name: string }>(
      "select id, name from workspaces where name like 'twin%' order by created_at"
    );
    expect(names.rows).toEqual([
      { id: rows[0]!.id, name: 'twin' },
      { id: rows[1]!.id, name: `twin (${rows[1]!.id})` }
    ]);
    await expect(client.query("insert into workspaces (name) values ('twin')")).rejects.toThrow(
      'workspaces_name'
    );
  });

  test('a disambiguated name already taken gets a counter, so the index still builds', async () => {
    await client.query(
      "delete from schema_migrations where name = '0016_workspace_name_unique.sql'"
    );
    await client.query('drop index workspaces_name');
    const older = await client.query<{ id: string }>(
      "insert into workspaces (name, created_at) values ('pair', now() - interval '1 day') returning id"
    );
    const newer = await client.query<{ id: string }>(
      "insert into workspaces (name) values ('pair') returning id"
    );
    const taken = `pair (${newer.rows[0]!.id})`;
    await client.query('insert into workspaces (name) values ($1)', [taken]);
    expect(await migrate(client)).toEqual(['0016_workspace_name_unique.sql']);
    const names = await client.query<{ id: string; name: string }>(
      'select id, name from workspaces where id = any($1) order by created_at',
      [[older.rows[0]!.id, newer.rows[0]!.id]]
    );
    expect(names.rows).toEqual([
      { id: older.rows[0]!.id, name: 'pair' },
      { id: newer.rows[0]!.id, name: `pair (${newer.rows[0]!.id} 2)` }
    ]);
  });

  test('two registrations of a new workspace name at once land on one workspace', async () => {
    const pool = new Pool({ connectionString: url });
    const [first, second] = [await pool.connect(), await pool.connect()];
    try {
      await first.query('begin');
      await second.query('begin');
      const created = await upsertWorkspace(first, 'atlas');
      const racing = upsertWorkspace(second, 'atlas');
      // The second registration is in flight, waiting on the first, when the first commits.
      await Bun.sleep(50);
      await first.query('commit');
      expect(await racing).toBe(created);
      await second.query('commit');
      const count = await client.query("select 1 from workspaces where name = 'atlas'");
      expect(count.rowCount).toBe(1);
    } finally {
      first.release();
      second.release();
      await pool.end();
    }
  });

  test('two processes migrating at once apply each migration once', async () => {
    await client.query('drop schema public cascade; create schema public;');
    const other = new Client({ connectionString: url });
    await other.connect();
    try {
      const [first, second] = await Promise.all([migrate(client), migrate(other)]);
      expect([...first, ...second].sort()).toEqual(
        (await client.query<{ name: string }>('select name from schema_migrations')).rows
          .map((row) => row.name)
          .sort()
      );
      expect(first.length === 0 || second.length === 0).toBe(true);
    } finally {
      await other.end();
    }
  });

  test('a failing migration is named, recorded nowhere, and leaves the lock free', async () => {
    await client.query('drop schema public cascade; create schema public;');
    // A table the first migration creates is already there, so the first migration fails.
    await client.query('create table workspaces (id int)');
    await expect(migrate(client)).rejects.toThrow('migration 0001_init.sql failed');
    const recorded = await client.query('select 1 from schema_migrations');
    expect(recorded.rowCount).toBe(0);

    // Another process gets the lock instead of waiting forever, and fails the same way.
    const other = new Client({ connectionString: url });
    await other.connect();
    try {
      await expect(migrate(other)).rejects.toThrow('migration 0001_init.sql failed');
    } finally {
      await other.end();
    }
  });
});
