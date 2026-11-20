import {
  TERMINAL_STAGES,
  WITH_PULL_REQUEST,
  linkProblem,
  type Actor,
  type BuildLinks,
  type LinkedTask,
  type LinkProblem,
  type PathsOf,
  type Stage
} from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { latestPushedPaths } from './board';
import { appendTaskEvent } from './task-history';

type Queryable = Pool | PoolClient;

/** The paths a task's current spec version predicted; none for a task specced before they were kept. */
const PREDICTED_PATHS = `coalesce((select v.predicted_paths from spec_versions v
  where v.task_id = t.id and v.version = t.spec_version), '{}')`;

/** A sibling's files: once in flight, what it pushed as well as what its spec predicted. */
const withPushedPaths = async (db: Queryable, id: string, sibling: PathsOf): Promise<PathsOf> =>
  WITH_PULL_REQUEST.has(sibling.stage)
    ? { ...sibling, paths: [...sibling.paths, ...(await latestPushedPaths(db, id))] }
    : sibling;

/**
 * Everything a task's build waits on: its sub-tasks, the tasks it waits for, the other sub-tasks of
 * its parent with their files (what their spec predicted and, once in flight, what they pushed), and
 * its own files.
 */
export const buildLinksOf = async (db: Queryable, taskId: string): Promise<BuildLinks> => {
  // One query at a time: inside a transaction they share one client.
  const subtasks = await db.query<LinkedTask>(
    'select number, stage from tasks where parent_id = $1 order by number',
    [taskId]
  );
  const after = await db.query<LinkedTask>(
    `select t.number, t.stage from task_dependencies d join tasks t on t.id = d.depends_on
       where d.task_id = $1 order by t.number`,
    [taskId]
  );
  const siblings = await db.query<PathsOf & { id: string }>(
    `select t.id, t.number, t.stage, ${PREDICTED_PATHS} as paths
       from tasks me join tasks t on t.parent_id = me.parent_id and t.id <> me.id
       where me.id = $1 order by t.number`,
    [taskId]
  );
  const own = await db.query<{ paths: string[] }>(
    `select ${PREDICTED_PATHS} as paths from tasks t where t.id = $1`,
    [taskId]
  );
  const withPaths: PathsOf[] = [];
  for (const { id, ...sibling } of siblings.rows)
    withPaths.push(await withPushedPaths(db, id, sibling));
  return {
    subtasks: subtasks.rows,
    after: after.rows,
    siblings: withPaths,
    paths: own.rows[0]?.paths ?? []
  };
};

export interface TaskLinks {
  readonly projectId: string;
  readonly taskId: string;
  readonly parentId: string | null;
  /** The tasks it waits for. */
  readonly after: readonly string[];
  readonly actor: Actor;
}

/** A task's links by number, as `links_changed` records them. */
interface LinkNumbers {
  readonly parent: number | null;
  readonly after: number[];
}

const sameLinks = (a: LinkNumbers, b: LinkNumbers) =>
  a.parent === b.parent && a.after.join() === b.after.join();

const linkedRow = async (client: PoolClient, id: string) =>
  (
    await client.query<{ number: number; stage: Stage; parent_id: string | null }>(
      'select number, stage, parent_id from tasks where id = $1 for update',
      [id]
    )
  ).rows[0]!;

/**
 * Sets a task's parent and the tasks it waits for to exactly what is given, inside the caller's
 * transaction, unless `linkProblem` says why not. Links of one project are set one at a time, so
 * two at once never close a loop; only a change is recorded, so setting the same links twice records
 * them once.
 */
export const setTaskLinks = async (
  client: PoolClient,
  input: TaskLinks
): Promise<{ changed: boolean; problem: LinkProblem | null }> => {
  await client.query("select pg_advisory_xact_lock(hashtextextended('task_links:' || $1, 0))", [
    input.projectId
  ]);
  const task = await linkedRow(client, input.taskId);
  const parent = input.parentId === null ? null : await linkedRow(client, input.parentId);
  const after = [...new Set(input.after)];
  const hasSubtasks = await client.query('select 1 from tasks where parent_id = $1 limit 1', [
    input.taskId
  ]);
  const waited = await client.query<LinkedTask>(
    'select number, stage from tasks where id = any($1) order by number',
    [after]
  );
  const edges = await client.query<{ task: number; waited: number }>(
    `select t.number as task, w.number as waited from task_dependencies d
       join tasks t on t.id = d.task_id join tasks w on w.id = d.depends_on
       where t.project_id = $1 and d.task_id <> $2`,
    [input.projectId, input.taskId]
  );
  const current = await client.query<{ number: number }>(
    `select t.number from task_dependencies d join tasks t on t.id = d.depends_on
     where d.task_id = $1 order by t.number`,
    [input.taskId]
  );
  const problem = linkProblem({
    task: { number: task.number, stage: task.stage, hasSubtasks: (hasSubtasks.rowCount ?? 0) > 0 },
    parent: parent && {
      number: parent.number,
      stage: parent.stage,
      hasParent: parent.parent_id !== null
    },
    after: waited.rows,
    edges: edges.rows.map((edge) => [edge.task, edge.waited] as const)
  });
  if (problem) return { changed: false, problem };

  const formerParent = task.parent_id
    ? (
        await client.query<{ number: number }>('select number from tasks where id = $1', [
          task.parent_id
        ])
      ).rows[0]!.number
    : null;
  const before: LinkNumbers = {
    parent: formerParent,
    after: current.rows.map((row) => row.number)
  };
  const links: LinkNumbers = {
    parent: parent?.number ?? null,
    after: waited.rows.map((row) => row.number)
  };
  if (sameLinks(before, links)) return { changed: false, problem: null };

  await client.query('update tasks set parent_id = $2, updated_at = now() where id = $1', [
    input.taskId,
    input.parentId
  ]);
  await client.query('delete from task_dependencies where task_id = $1 and depends_on <> all($2)', [
    input.taskId,
    after
  ]);
  await client.query(
    `insert into task_dependencies (task_id, depends_on) select $1, unnest($2::uuid[])
     on conflict do nothing`,
    [input.taskId, after]
  );
  await appendTaskEvent(client, {
    taskId: input.taskId,
    actor: input.actor,
    type: 'links_changed',
    payload: links
  });
  return { changed: true, problem: null };
};

/** The project's open tasks that have sub-tasks, each with them, for the engine to close. */
export const listOpenParents = async (
  db: Queryable,
  projectId: string
): Promise<{ id: string; subtasks: LinkedTask[] }[]> =>
  (
    await db.query<{ id: string; subtasks: LinkedTask[] }>(
      `select p.id, json_agg(json_build_object('number', s.number, 'stage', s.stage)
         order by s.number) as subtasks
       from tasks p join tasks s on s.parent_id = p.id
       where p.project_id = $1 and p.stage <> all($2)
       group by p.id, p.number order by p.number`,
      [projectId, [...TERMINAL_STAGES]]
    )
  ).rows;
