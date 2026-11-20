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
import { appendTaskEvent } from './task-history';

type Queryable = Pool | PoolClient;

/** The paths the spec version a task is at predicted, on the task row `t`. */
const PREDICTED_PATHS = `coalesce(
  (select v.predicted_paths from spec_versions v where v.task_id = t.id and v.version = t.spec_version),
  '{}')`;

const linkedTasks = async (db: Queryable, sql: string, taskId: string): Promise<LinkedTask[]> =>
  (await db.query<LinkedTask>(sql, [taskId])).rows;

/**
 * What decides whether a task may be built now: its sub-tasks, the tasks it waits for, its
 * siblings with their files, and its own files. A sibling in flight also counts the paths its
 * latest push changed, which the spec may not have predicted.
 */
export const buildLinksOf = async (db: Queryable, taskId: string): Promise<BuildLinks> => {
  const subtasks = await linkedTasks(
    db,
    'select number, stage from tasks where parent_id = $1 order by number',
    taskId
  );
  const after = await linkedTasks(
    db,
    `select t.number, t.stage from task_dependencies d join tasks t on t.id = d.depends_on
       where d.task_id = $1 order by t.number`,
    taskId
  );
  const siblings = (
    await db.query<PathsOf>(
      `select t.number, t.stage,
              array(
                select distinct path from unnest(
                  ${PREDICTED_PATHS} || array(select jsonb_array_elements_text(pushed.changed))
                ) path order by path
              ) as paths
         from tasks me
         join tasks t on t.parent_id = me.parent_id and t.id <> me.id
         left join lateral (
           select e.payload->'changedPaths' as changed from task_events e
            where e.task_id = t.id and e.type = 'pushed' order by e.id desc limit 1
         ) pushed on t.stage = any($2::text[])
        where me.id = $1
        order by t.number`,
      [taskId, [...WITH_PULL_REQUEST]]
    )
  ).rows;
  const own = await db.query<{ paths: string[] }>(
    `select ${PREDICTED_PATHS} as paths from tasks t where t.id = $1`,
    [taskId]
  );
  return { subtasks, after, siblings, paths: own.rows[0]?.paths ?? [] };
};

interface LinkInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly parentId: string | null;
  /** The tasks it waits for. */
  readonly after: readonly string[];
  readonly actor: Actor;
}

interface LinkRow {
  readonly id: string;
  readonly number: number;
  readonly stage: Stage;
  readonly parentId: string | null;
}

const LINK_COLUMNS = 'id, number, stage, parent_id as "parentId"';

const lockLinkRow = async (client: PoolClient, id: string): Promise<LinkRow> =>
  (await client.query<LinkRow>(`select ${LINK_COLUMNS} from tasks where id = $1 for update`, [id]))
    .rows[0]!;

const ascending = (numbers: readonly number[]): number[] => [...numbers].sort((a, b) => a - b);

/**
 * Sets a task's parent and the tasks it waits for to exactly what is given, inside the caller's
 * transaction, or says why it may not (`linkProblem`) and writes nothing. Links are serialized per
 * project, so two at once never close a cycle; a lock on the project row would deadlock with a
 * dispatch, which takes it after the task row. The same links set again change nothing.
 */
export const setTaskLinks = async (
  client: PoolClient,
  input: LinkInput
): Promise<{ changed: boolean; problem: LinkProblem | null }> => {
  await client.query("select pg_advisory_xact_lock(hashtextextended('task_links:' || $1, 0))", [
    input.projectId
  ]);
  const task = await lockLinkRow(client, input.taskId);
  const parent = input.parentId === null ? null : await lockLinkRow(client, input.parentId);
  const afterIds = [...new Set(input.after)];
  const after = (
    await client.query<LinkRow>(`select ${LINK_COLUMNS} from tasks where id = any($1)`, [afterIds])
  ).rows;
  const hasSubtasks = Boolean(
    (await client.query('select 1 from tasks where parent_id = $1 limit 1', [task.id])).rowCount
  );
  const edges = (
    await client.query<{ task: number; waited: number }>(
      `select t.number as task, w.number as waited from task_dependencies d
         join tasks t on t.id = d.task_id join tasks w on w.id = d.depends_on
        where t.project_id = $1 and d.task_id <> $2`,
      [input.projectId, task.id]
    )
  ).rows.map((edge) => [edge.task, edge.waited] as const);
  const problem = linkProblem({
    task: { number: task.number, stage: task.stage, hasSubtasks },
    parent: parent && {
      number: parent.number,
      stage: parent.stage,
      hasParent: parent.parentId !== null
    },
    after,
    edges
  });
  if (problem) return { changed: false, problem };

  const before = (
    await client.query<{ dependsOn: string }>(
      'select depends_on as "dependsOn" from task_dependencies where task_id = $1',
      [task.id]
    )
  ).rows.map((row) => row.dependsOn);
  const sameAfter =
    before.length === afterIds.length && afterIds.every((id) => before.includes(id));
  if (task.parentId === input.parentId && sameAfter) return { changed: false, problem: null };

  await client.query('update tasks set parent_id = $2, updated_at = now() where id = $1', [
    task.id,
    input.parentId
  ]);
  await client.query('delete from task_dependencies where task_id = $1', [task.id]);
  await client.query(
    'insert into task_dependencies (task_id, depends_on) select $1, unnest($2::uuid[])',
    [task.id, afterIds]
  );
  await appendTaskEvent(client, {
    taskId: task.id,
    actor: input.actor,
    type: 'links_changed',
    payload: {
      parent: parent?.number ?? null,
      after: ascending(after.map((other) => other.number))
    }
  });
  return { changed: true, problem: null };
};

/** The project's open tasks that have sub-tasks, each with its sub-tasks, for closing parents. */
export const listOpenParents = async (
  db: Queryable,
  projectId: string
): Promise<{ id: string; subtasks: LinkedTask[] }[]> => {
  const { rows } = await db.query<LinkedTask & { parentId: string }>(
    `select p.id as "parentId", t.number, t.stage
       from tasks p join tasks t on t.parent_id = p.id
      where p.project_id = $1 and p.stage <> all($2)
      order by p.number, t.number`,
    [projectId, [...TERMINAL_STAGES]]
  );
  const parents = new Map<string, LinkedTask[]>();
  for (const { parentId, number, stage } of rows)
    parents.set(parentId, [...(parents.get(parentId) ?? []), { number, stage }]);
  return [...parents].map(([id, subtasks]) => ({ id, subtasks }));
};
