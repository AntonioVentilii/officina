import {
  ENGINE,
  splitMarkdown,
  splitPaths,
  type Actor,
  type Command,
  type ProposedSplit
} from '@officina/core';
import type { Pool } from 'pg';
import { CONFIG_YAML } from '../../core/test/fixtures';
import { applyCommand, createTask, insertLearnings, migrate, saveSpecVersion } from '../src';

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

/**
 * Creates a task and takes it to `ready`, its spec predicting `paths` and stored as the spec agent's
 * spec is, so the order of sub-tasks reads them.
 */
export const createReadyTask = async (
  pool: Pool,
  seeded: Seeded,
  title: string,
  paths: readonly string[]
): Promise<{ id: string; number: number }> => {
  const { task } = await createTask(pool, {
    projectId: seeded.projectId,
    title,
    requesterId: seeded.ownerId
  });
  await applyOrThrow(pool, task.id, { type: 'submit_request' }, seeded.owner);
  await applyOrThrow(pool, task.id, { type: 'accept' }, seeded.owner);
  const specced = await applyCommand(pool, {
    taskId: task.id,
    command: { type: 'post_spec', predictedPaths: paths, userVisible: false },
    actor: agent('spec'),
    onApplied: (client, after) =>
      saveSpecVersion(client, {
        taskId: task.id,
        version: after.specVersion,
        body: `# ${title}`,
        createdBy: agent('spec'),
        predictedPaths: paths
      })
  });
  if (!specced.ok) throw new Error(`post_spec: ${specced.error}`);
  await applyOrThrow(
    pool,
    task.id,
    { type: 'plan_approval', userVisible: false, plan: PLAN },
    agent('chooser')
  );
  await applyOrThrow(pool, task.id, { type: 'approve' }, seeded.owner);
  const { rows } = await pool.query<{ number: number }>('select number from tasks where id = $1', [
    task.id
  ]);
  return { id: task.id, number: rows[0]!.number };
};

/** A split the spec agent could propose: the copy first, then the page that shows it. */
export const SPLIT: ProposedSplit = {
  why: 'Two purposes: the settings copy and a new settings page.',
  subtasks: [
    { title: 'Rename the settings title', scope: 'The copy only.', paths: ['src/a.ts'], after: [] },
    { title: 'Add the settings page', scope: 'The page.', paths: ['src/b.svelte'], after: [1] }
  ]
};

/** Creates a task and takes it to spec review with `split` proposed, as the spec agent stores it. */
export const createTaskWithSplit = async (
  pool: Pool,
  seeded: Seeded,
  split: ProposedSplit = SPLIT
): Promise<string> => {
  const { task } = await createTask(pool, {
    projectId: seeded.projectId,
    title: 'Settings',
    requesterId: seeded.ownerId
  });
  await applyOrThrow(pool, task.id, { type: 'submit_request' }, seeded.owner);
  await applyOrThrow(pool, task.id, { type: 'accept' }, seeded.owner);
  const proposed = await applyCommand(pool, {
    taskId: task.id,
    command: {
      type: 'post_spec',
      predictedPaths: splitPaths(split),
      userVisible: false,
      split: true
    },
    actor: agent('spec'),
    onApplied: (client, after) =>
      saveSpecVersion(client, {
        taskId: task.id,
        version: after.specVersion,
        body: splitMarkdown(split),
        createdBy: agent('spec'),
        predictedPaths: splitPaths(split),
        split
      })
  });
  if (!proposed.ok) throw new Error(`post_spec: ${proposed.error}`);
  return task.id;
};

/** Creates a copy-change task and takes it to `choosing`, built at `abc` and reviewed. */
export const createTaskInChoosing = async (pool: Pool, seeded: Seeded): Promise<string> => {
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
      openInLane: 0
    },
    engine
  );
  await applyOrThrow(
    pool,
    id,
    {
      type: 'push',
      headSha: 'abc',
      changedPaths: paths,
      addedPaths: [],
      catalogPages: {},
      diffLines: 4
    },
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
  return id;
};

/** Creates a copy-change task and takes it to `verifying`, built at `abc` and planned. */
export const createTaskInVerifying = async (pool: Pool, seeded: Seeded): Promise<string> => {
  const id = await createTaskInChoosing(pool, seeded);
  await applyOrThrow(pool, id, { type: 'choose', userVisible: true, plan: PLAN }, agent('chooser'));
  return id;
};

/**
 * Lets the copy lane skip people's check (`auto_verify`, and a merge that does not deploy to
 * production), then takes a copy-change task through a glance plan straight to `merging`.
 */
export const createAutoVerifiedTask = async (pool: Pool, seeded: Seeded): Promise<string> => {
  const config = CONFIG_YAML.replace(
    'version: 1',
    'version: 1\nrelease: { on_merge: staging }'
  ).replace('  green:\n', '  green:\n    auto_verify: true\n');
  await pool.query('update projects set config = $2 where id = $1', [
    seeded.projectId,
    JSON.stringify(Bun.YAML.parse(config))
  ]);
  const id = await createTaskInChoosing(pool, seeded);
  const plan = { ...PLAN, depth: 'glance' as const };
  await applyOrThrow(pool, id, { type: 'choose', userVisible: true, plan }, agent('chooser'));
  return id;
};

/** Creates a copy-change task and takes it to `merging`, the stage where a merge or CI result lands. */
export const createTaskInMerging = async (pool: Pool, seeded: Seeded): Promise<string> => {
  const id = await createTaskInVerifying(pool, seeded);
  await applyOrThrow(pool, id, { type: 'approve' }, seeded.owner);
  return id;
};

/** Records a chooser run whose result holds this verification checklist. */
export const recordChooserChecklist = async (
  pool: Pool,
  taskId: string,
  checklist: readonly string[]
) => {
  await pool.query(
    `insert into runs (task_id, stage, runner, agent_role, agent_version, status, result)
     values ($1, 'choosing', 'managed_agents', 'chooser', 1, 'succeeded', $2)`,
    [taskId, JSON.stringify({ userVisible: true, checklist, beforeAfter: [] })]
  );
};

/**
 * Creates a task, merges its own pull request so it is done, and records a learning from it that
 * people accepted, whose pull request `prNumber` Officina opened and nobody merged yet.
 */
export const createDoneTaskWithLearningPullRequest = async (
  pool: Pool,
  seeded: Seeded,
  prNumber: number
): Promise<string> => {
  const taskId = await createTaskInMerging(pool, seeded);
  await applyOrThrow(pool, taskId, { type: 'merged' }, ENGINE);
  const run = await pool.query<{ id: string }>(
    `insert into runs (task_id, stage, runner, agent_role, agent_version, status)
     values ($1, 'done', 'managed_agents', 'learner', 1, 'succeeded') returning id`,
    [taskId]
  );
  await insertLearnings(pool, {
    projectId: seeded.projectId,
    taskId,
    runId: run.rows[0]!.id,
    learnings: [
      {
        title: 'Update every live locale',
        lesson: 'Copy changes cover every live locale.',
        evidence: 'Italian was missing in round one.',
        target: 'docs',
        edit: { file: 'AGENTS.md', text: 'Update every live locale.' }
      }
    ]
  });
  await pool.query(
    `update learnings set status = 'accepted', decided_by = $2, decided_at = now(), pr_number = $3,
       pr_url = $4
     where task_id = $1`,
    [taskId, seeded.ownerId, prNumber, `https://github.com/ViciApp/vici-app/pull/${prNumber}`]
  );
  return taskId;
};
