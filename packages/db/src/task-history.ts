import type { Actor, ProposedSplit } from '@officina/core';
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
 * Whether people picked the size check's Split since the task's latest spec version, so the spec
 * now due must be a proposed split.
 */
export const splitAskedSinceSpec = async (db: Queryable, taskId: string): Promise<boolean> =>
  (
    await db.query<{ type: string }>(
      `select type from task_events where task_id = $1 and type in ('split_asked', 'spec_versioned')
        order by id desc limit 1`,
      [taskId]
    )
  ).rows[0]?.type === 'split_asked';
