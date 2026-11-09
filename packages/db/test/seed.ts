import type { Actor, Command } from '@officina/core';
import type { Pool } from 'pg';
import { CONFIG_YAML } from '../../core/test/fixtures';
import { applyCommand, createTask, migrate } from '../src';

export interface Seeded {
  readonly projectId: string;
  readonly ownerId: string;
  readonly owner: Actor;
}

/** Recreates the schema and seeds one workspace, one owner and one project using the test config. */
export const resetAndSeed = async (pool: Pool): Promise<Seeded> => {
  await pool.query('drop schema public cascade; create schema public;');
  const client = await pool.connect();
  try {
    await migrate(client);
  } finally {
    client.release();
  }
  const { rows } = await pool.query<{ project_id: string; member_id: string }>(
    `with w as (insert into workspaces (name) values ('vici') returning id),
     m as (insert into members (workspace_id, display_name, email)
           select id, 'Antonio', 'antonio@example.com' from w returning id, workspace_id),
     p as (insert into projects (workspace_id, name, github_repo, config)
           select workspace_id, 'vici-app', 'ViciApp/vici-app', $1::jsonb from m returning id),
     r as (insert into project_roles (project_id, member_id, role)
           select p.id, m.id, 'owner' from p, m returning project_id, member_id)
     select project_id, member_id from r`,
    [JSON.stringify(Bun.YAML.parse(CONFIG_YAML))]
  );
  const ownerId = rows[0]!.member_id;
  return { projectId: rows[0]!.project_id, ownerId, owner: { kind: 'member', memberId: ownerId } };
};

/** A plain approval plan that adds nothing. */
export const PLAN = {
  depth: 'test' as const,
  rationale: 'Ordinary change.',
  extra: [],
  verifiers: []
};

export const applyOrThrow = async (pool: Pool, taskId: string, command: Command, actor: Actor) => {
  const result = await applyCommand(pool, { taskId, command, actor });
  if (!result.ok) throw new Error(`${command.type}: ${result.error}`);
  return result;
};

const agent = (
  role: 'spec' | 'builder' | 'reviewer_spec' | 'reviewer_correctness' | 'chooser'
): Actor => ({
  kind: 'agent',
  role,
  version: 1
});

/** Creates a copy-change task and takes it to `merging`, the stage where a merge or CI result lands. */
export const createTaskInMerging = async (pool: Pool, seeded: Seeded): Promise<string> => {
  const paths = ['src/lib/constants/messages/en.ts'];
  const { task } = await createTask(pool, {
    projectId: seeded.projectId,
    title: 'Fix copy',
    requesterId: seeded.ownerId
  });
  const id = task.id;
  const engine: Actor = { kind: 'engine' };
  await applyOrThrow(pool, id, { type: 'submit_request' }, seeded.owner);
  await applyOrThrow(pool, id, { type: 'accept' }, seeded.owner);
  await applyOrThrow(
    pool,
    id,
    { type: 'post_spec', predictedPaths: paths, userVisible: true },
    agent('spec')
  );
  await applyOrThrow(
    pool,
    id,
    { type: 'plan_approval', userVisible: true, plan: PLAN },
    agent('chooser')
  );
  await applyOrThrow(pool, id, { type: 'approve' }, seeded.owner);
  await applyOrThrow(
    pool,
    id,
    {
      type: 'dispatch',
      assignee: { kind: 'agent', role: 'builder' },
      openInLane: 0,
      onboardingOpen: false
    },
    engine
  );
  await applyOrThrow(
    pool,
    id,
    { type: 'push', headSha: 'abc', changedPaths: paths, diffLines: 4 },
    agent('builder')
  );
  await applyOrThrow(
    pool,
    id,
    { type: 'review', verdict: 'approve', notes: 'ok' },
    agent('reviewer_spec')
  );
  await applyOrThrow(
    pool,
    id,
    { type: 'review', verdict: 'approve', notes: 'ok' },
    agent('reviewer_correctness')
  );
  await applyOrThrow(pool, id, { type: 'choose', userVisible: true, plan: PLAN }, agent('chooser'));
  await applyOrThrow(pool, id, { type: 'approve' }, seeded.owner);
  return id;
};
