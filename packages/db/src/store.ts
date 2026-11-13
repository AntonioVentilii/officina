import {
  TERMINAL_STAGES,
  computeLane,
  gateSubject,
  decide,
  ENGINE,
  parseProjectConfig,
  type Actor,
  type Command,
  type DecisionError,
  type DomainEvent,
  type Guard,
  type ProjectConfig,
  type Task
} from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { addComment, listApprovedSubjects, listProjectMembers } from './tasks';

export type StoreError = DecisionError | 'not_found' | 'conflict' | 'invalid_config';

export type StoredTask = { readonly task: Task; readonly version: number };

export type ApplyResult =
  | (StoredTask & { readonly ok: true; readonly events: readonly DomainEvent[] })
  | { readonly ok: false; readonly error: StoreError };

interface TaskRow {
  id: string;
  kind: Task['kind'];
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
  guards: Task['guards'];
  version: number;
}

const toStored = (row: TaskRow): StoredTask => ({
  version: row.version,
  task: {
    id: row.id,
    kind: row.kind,
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
    approvalPlans: row.approval_plans,
    guards: row.guards
  }
});

/** Runs several writes as one: all of them land, or none. */
export const inTransaction = async <T>(
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
  input: {
    projectId: string;
    title: string;
    requesterId: string;
    /** The requester's own words, recorded as the thread's first comment with the task. */
    request?: string;
    /** What the request's words touch that no agent may handle alone (`guardsInRequest`). */
    guards?: readonly Guard[];
  }
): Promise<StoredTask> =>
  inTransaction(pool, async (client) => {
    // Locking the project serializes task numbering per project.
    await client.query('select id from projects where id = $1 for update', [input.projectId]);
    const { rows } = await client.query<TaskRow>(
      `insert into tasks (project_id, number, title, requester_id, stage, guards)
       select $1, coalesce(max(number), 0) + 1, $2, $3, 'request', $4 from tasks where project_id = $1
       returning *`,
      [input.projectId, input.title, input.requesterId, input.guards ?? []]
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
    if (input.request !== undefined) {
      await addComment(
        client,
        row.id,
        { kind: 'member', memberId: input.requesterId },
        input.request
      );
    }
    return toStored(row);
  });

/** The project's onboarding task while it is open: no other build is dispatched until it is done. */
export const openOnboardingTask = async (
  db: Pool | PoolClient,
  projectId: string
): Promise<{ id: string; number: number } | null> =>
  (
    await db.query<{ id: string; number: number }>(
      `select id, number from tasks
       where project_id = $1 and kind = 'onboarding' and stage <> all($2)
       order by number limit 1`,
      [projectId, [...TERMINAL_STAGES]]
    )
  ).rows[0] ?? null;

export interface NewOnboardingTask {
  readonly projectId: string;
  readonly requesterId: string;
  readonly title: string;
  readonly spec: string;
  readonly paths: readonly string[];
  readonly config: ProjectConfig;
}

/**
 * Opens the task that writes a project's agent docs, unless one is already open, inside the
 * caller's transaction, so registering a project and gating it are one change. People approve its
 * spec like any other, so it starts at spec review with the engine's spec as version 1.
 */
export const insertOnboardingTask = async (
  client: PoolClient,
  input: NewOnboardingTask
): Promise<{ created: boolean; id: string; number: number }> => {
  // Locking the project serializes task numbering, keeps a single open onboarding task, and
  // waits for any dispatch reading the gate under its share lock.
  await client.query('select id from projects where id = $1 for update', [input.projectId]);
  const open = await openOnboardingTask(client, input.projectId);
  if (open) return { created: false, ...open };
  const lane = computeLane(input.paths, input.config.laneMatcher);
  const { rows } = await client.query<{ id: string; number: number }>(
    `insert into tasks (project_id, number, title, requester_id, kind, stage, lane, spec_version)
       select $1, coalesce(max(number), 0) + 1, $2, $3, 'onboarding', 'spec_review', $4, 1
       from tasks where project_id = $1
       returning id, number`,
    [input.projectId, input.title, input.requesterId, lane]
  );
  const row = rows[0]!;
  await client.query(
    'insert into task_events (task_id, actor, type, payload) values ($1, $2, $3, $4)',
    [row.id, json(ENGINE), 'created', json({ title: input.title, kind: 'onboarding' })]
  );
  await client.query(
    'insert into spec_versions (task_id, version, body, created_by) values ($1, 1, $2, $3)',
    [row.id, input.spec, json(ENGINE)]
  );
  const events: DomainEvent[] = [
    { type: 'spec_versioned', version: 1 },
    { type: 'lane_changed', from: null, to: lane },
    { type: 'stage_changed', from: 'request', to: 'spec_review' }
  ];
  for (const event of events) await insertEvent(client, row.id, ENGINE, event);
  return { created: true, id: row.id, number: row.number };
};

/** `insertOnboardingTask` in a transaction of its own. */
export const createOnboardingTask = (
  pool: Pool,
  input: NewOnboardingTask
): Promise<{ created: boolean; id: string; number: number }> =>
  inTransaction(pool, (client) => insertOnboardingTask(client, input));

/** Renames a task; the interviewer names it when the request is complete. */
export const setTaskTitle = async (client: PoolClient, taskId: string, title: string) => {
  await client.query('update tasks set title = $2 where id = $1', [taskId, title]);
};

export const loadTask = async (pool: Pool, taskId: string): Promise<StoredTask | null> => {
  const { rows } = await pool.query<TaskRow>('select * from tasks where id = $1', [taskId]);
  return rows[0] ? toStored(rows[0]) : null;
};

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

    const members = await listProjectMembers(client, row.project_id);
    const approvals = await listApprovedSubjects(client, input.taskId);

    const before = toStored(row).task;
    if (input.guard && !input.guard(before)) return { ok: false, error: 'conflict' };
    // Only a dispatch reads the onboarding gate; the share lock waits for an onboarding task
    // being opened, so the gate it reads is the one in force when the build starts.
    let onboardingOpen = false;
    if (input.command.type === 'dispatch') {
      await client.query('select id from projects where id = $1 for share', [row.project_id]);
      onboardingOpen = (await openOnboardingTask(client, row.project_id)) !== null;
    }
    const decision = decide(before, input.command, input.actor, {
      config: parsedConfig.config,
      members,
      approvals,
      onboardingOpen
    });
    if (!decision.ok) return decision;

    const task = decision.task;
    const updated = await client.query<{ version: number }>(
      `update tasks set stage = $2, lane = $3, spec_version = $4, head_sha = $5, user_visible = $6,
         assignee = $7, blocked = $8, paused = $9, fix_rounds = $10, reviews = $11, approval_plans = $12,
         guards = $13, version = version + 1, updated_at = now()
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
        json(task.approvalPlans),
        task.guards
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
          [task.id, input.actor.memberId, event.stage, gateSubject(before, event.stage), event.note]
        );
      }
    }

    await input.onApplied?.(client, task);
    return { ok: true, task, version: updated.rows[0]!.version, events: decision.events };
  });
