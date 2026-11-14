import type { Actor } from '@officina/core';
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
  input: { taskId: string; version: number; body: string; createdBy: Actor }
) => {
  await db.query(
    'insert into spec_versions (task_id, version, body, created_by) values ($1, $2, $3, $4)',
    [input.taskId, input.version, input.body, JSON.stringify(input.createdBy)]
  );
};
