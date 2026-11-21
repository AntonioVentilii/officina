import type { Actor, ProposedSplit, SpecShape } from '@officina/core';
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

/** Records one entry in a task's audit log; every write to `task_events` goes through here. */
export const appendTaskEvent = async (
  db: Queryable,
  input: { taskId: string; actor: Actor; type: string; payload: unknown }
) => {
  await db.query(
    'insert into task_events (task_id, actor, type, payload) values ($1, $2, $3, $4)',
    [input.taskId, JSON.stringify(input.actor), input.type, JSON.stringify(input.payload)]
  );
};

/** Stores one version of a task's spec; every write to `spec_versions` goes through here. */
export const saveSpecVersion = async (
  db: Queryable,
  input: {
    taskId: string;
    version: number;
    body: string;
    createdBy: Actor;
    /** The paths the spec predicts the change touches, for the order of sub-tasks. */
    predictedPaths?: readonly string[];
    /** The sub-tasks it proposes instead of one change, when it is a proposed split. */
    split?: ProposedSplit;
  }
) => {
  await db.query(
    `insert into spec_versions (task_id, version, body, created_by, predicted_paths, split)
       values ($1, $2, $3, $4, $5, $6)`,
    [
      input.taskId,
      input.version,
      input.body,
      JSON.stringify(input.createdBy),
      input.predictedPaths ?? [],
      input.split ? JSON.stringify(input.split) : null
    ]
  );
};

/**
 * The shape the spec now due must take, or `null` when the spec agent judges it: one spec for a
 * sub-task, since links go one level deep, or for a split people kept whole; a split when people
 * picked the size check's Split. A decision counts until the next spec version is posted.
 */
export const specShapeFor = async (db: Queryable, taskId: string): Promise<SpecShape | null> => {
  const { rows } = await db.query<{ parent: string | null; type: string | null }>(
    `select t.parent_id as parent,
            (select e.type from task_events e
              where e.task_id = t.id and e.type in ('split_asked', 'kept_whole', 'spec_versioned')
              order by e.id desc limit 1) as type
       from tasks t where t.id = $1`,
    [taskId]
  );
  const row = rows[0];
  if (row?.parent || row?.type === 'kept_whole') return 'whole';
  return row?.type === 'split_asked' ? 'split' : null;
};
