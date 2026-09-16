import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from 'pg';
import { LANES, ROLES, STAGES } from '@officina/core';
import { migrate } from '../src';

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
      '0003_runs_and_agents.sql'
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
});
