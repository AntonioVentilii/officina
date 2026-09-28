import {
  decide,
  parseProjectConfig,
  type Actor,
  type Approval,
  type Command,
  type DecisionError,
  type DomainEvent,
  type Gate,
  type Member,
  type Task
} from '@officina/core';
import type { Pool, PoolClient } from 'pg';

export type StoreError = DecisionError | 'not_found' | 'conflict' | 'invalid_config';

export type StoredTask = { readonly task: Task; readonly version: number };

export type ApplyResult =
  | (StoredTask & { readonly ok: true; readonly events: readonly DomainEvent[] })
  | { readonly ok: false; readonly error: StoreError };

interface TaskRow {
  id: string;
  project_id: string;
  requester_id: string;
  stage: Task['stage'];
  lane: Task['lane'];
  spec_version: number;
  head_sha: string | null;
  user_visible: boolean;
  assignee: Task['assignee'];
  blocked: Task['blocked'];
  paused: boolean;
  fix_rounds: number;
  reviews: Task['reviews'];
  approval_plans: Task['approvalPlans'];
  version: number;
}

const toStored = (row: TaskRow): StoredTask => ({
  version: row.version,
  task: {
    id: row.id,
    requesterId: row.requester_id,
    stage: row.stage,
    lane: row.lane,
    specVersion: row.spec_version,
    headSha: row.head_sha,
    userVisible: row.user_visible,
    assignee: row.assignee,
    blocked: row.blocked,
    paused: row.paused,
    fixRounds: row.fix_rounds,
    reviews: row.reviews,
    approvalPlans: row.approval_plans
  }
});

const inTransaction = async <T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};

const json = (value: unknown): string | null => (value === null ? null : JSON.stringify(value));

const insertEvent = (client: PoolClient, taskId: string, actor: Actor, event: DomainEvent) => {
  const { type, ...payload } = event;
  return client.query(
    'insert into task_events (task_id, actor, type, payload) values ($1, $2, $3, $4)',
    [taskId, json(actor), type, json(payload)]
  );
};

export const createTask = (
  pool: Pool,
  input: { projectId: string; title: string; requesterId: string }
): Promise<StoredTask> =>
  inTransaction(pool, async (client) => {
    // Locking the project serializes task numbering per project.
    await client.query('select id from projects where id = $1 for update', [input.projectId]);
    const { rows } = await client.query<TaskRow>(
      `insert into tasks (project_id, number, title, requester_id, stage)
       select $1, coalesce(max(number), 0) + 1, $2, $3, 'request' from tasks where project_id = $1
       returning *`,
      [input.projectId, input.title, input.requesterId]
    );
    const row = rows[0]!;
    await client.query(
      'insert into task_events (task_id, actor, type, payload) values ($1, $2, $3, $4)',
      [
        row.id,
        json({ kind: 'member', memberId: input.requesterId }),
        'created',
        json({ title: input.title })
      ]
    );
    return toStored(row);
  });

export const loadTask = async (pool: Pool, taskId: string): Promise<StoredTask | null> => {
  const { rows } = await pool.query<TaskRow>('select * from tasks where id = $1', [taskId]);
  return rows[0] ? toStored(rows[0]) : null;
};

const subjectFor = (task: Task, gate: Gate): string =>
  gate === 'spec_review' ? `spec:${task.specVersion}` : `sha:${task.headSha}`;

/**
 * Applies one command atomically: the task row is locked, the decision is made on current state,
 * and the new state plus every event lands in the same transaction or not at all.
 * `expectedVersion` lets a client that acted on a stale view get `conflict` instead of a surprise.
 */
export interface ApplyInput {
  readonly taskId: string;
  readonly command: Command;
  readonly actor: Actor;
  readonly expectedVersion?: number;
  /**
   * Checked against the locked, current task. Agent results use it to require the state the agent
   * actually worked on (same stage, same head commit), so a stale result is never applied.
   */
  readonly guard?: (task: Task) => boolean;
  /** Runs inside the same transaction after the new state is written, e.g. to store a spec version. */
  readonly onApplied?: (client: PoolClient, task: Task) => Promise<void>;
}

export const applyCommand = (pool: Pool, input: ApplyInput): Promise<ApplyResult> =>
  inTransaction(pool, async (client) => {
    const { rows } = await client.query<TaskRow & { config: unknown }>(
      `select t.*, p.config from tasks t join projects p on p.id = t.project_id
       where t.id = $1 for update of t`,
      [input.taskId]
    );
    const row = rows[0];
    if (!row) return { ok: false, error: 'not_found' };
    if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
      return { ok: false, error: 'conflict' };
    }
    const parsedConfig = parseProjectConfig(row.config);
    if (!parsedConfig.ok) return { ok: false, error: 'invalid_config' };

    const members = (
      await client.query<Member>(
        'select member_id as id, role, domains from project_roles where project_id = $1',
        [row.project_id]
      )
    ).rows;
    const approvals = (
      await client.query<Approval>(
        `select member_id as "memberId", subject from approvals
         where task_id = $1 and decision = 'approve'`,
        [input.taskId]
      )
    ).rows;

    const before = toStored(row).task;
    if (input.guard && !input.guard(before)) return { ok: false, error: 'conflict' };
    const decision = decide(before, input.command, input.actor, {
      config: parsedConfig.config,
      members,
      approvals
    });
    if (!decision.ok) return decision;

    const task = decision.task;
    const updated = await client.query<{ version: number }>(
      `update tasks set stage = $2, lane = $3, spec_version = $4, head_sha = $5, user_visible = $6,
         assignee = $7, blocked = $8, paused = $9, fix_rounds = $10, reviews = $11, approval_plans = $12,
         version = version + 1, updated_at = now()
       where id = $1 returning version`,
      [
        task.id,
        task.stage,
        task.lane,
        task.specVersion,
        task.headSha,
        task.userVisible,
        json(task.assignee),
        json(task.blocked),
        task.paused,
        task.fixRounds,
        json(task.reviews),
        json(task.approvalPlans)
      ]
    );

    for (const event of decision.events) {
      await insertEvent(client, task.id, input.actor, event);
      if (event.type === 'approval_recorded') {
        await client.query(
          `insert into approvals (task_id, member_id, gate, subject, decision)
           values ($1, $2, $3, $4, 'approve')`,
          [task.id, event.memberId, event.gate, event.subject]
        );
      }
      if (
        event.type === 'changes_requested' &&
        input.actor.kind === 'member' &&
        (event.stage === 'spec_review' || event.stage === 'verifying')
      ) {
        await client.query(
          `insert into approvals (task_id, member_id, gate, subject, decision, note)
           values ($1, $2, $3, $4, 'changes', $5)`,
          [task.id, input.actor.memberId, event.stage, subjectFor(before, event.stage), event.note]
        );
      }
    }

    await input.onApplied?.(client, task);
    return { ok: true, task, version: updated.rows[0]!.version, events: decision.events };
  });
