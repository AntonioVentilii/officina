import {
  TERMINAL_STAGES,
  buildWait,
  computeLane,
  gateSubject,
  isGate,
  decide,
  ENGINE,
  memberActor,
  parseProjectConfig,
  type Actor,
  type ConnectedApp,
  type Command,
  type DecisionError,
  type Blocked,
  type DomainEvent,
  type Guard,
  type ProjectConfig,
  type Task
} from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { markRunsPaused } from './run-recovery';
import { appendTaskEvent, saveSpecVersion } from './task-history';
import { buildLinksOf } from './task-links';
import { toStored, type StoredTask, type TaskRow } from './task-row';
import { addComment, listApprovedSubjects, listProjectMembers, proposalsFor } from './tasks';

export type StoreError = DecisionError | 'not_found' | 'conflict' | 'invalid_config';

export type { StoredTask } from './task-row';

export type ApplyResult =
  | (StoredTask & { readonly ok: true; readonly events: readonly DomainEvent[] })
  | { readonly ok: false; readonly error: StoreError };

/**
 * What `pg` says when a query outlived `query_timeout`. It does not cancel the query: the client
 * still waits on its answer, so anything sent after it, a rollback included, waits too.
 */
const QUERY_TIMED_OUT = 'Query read timeout';

const timedOut = (error: unknown): error is Error =>
  error instanceof Error && error.message === QUERY_TIMED_OUT;

/** Rolls back, or says why the connection is broken: it could not even do that. */
const rollBack = (client: PoolClient): Promise<Error | undefined> =>
  client.query('rollback').then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
  );

/**
 * Runs several writes as one: all of them land, or none. A connection whose query timed out, or
 * that cannot even roll back, is broken (dropped, or silent) and is discarded, not handed back to
 * the pool for the next caller to hang on. One that timed out is discarded without a rollback, which
 * would only wait behind the query; closing it rolls the transaction back on the server. The work's
 * own error is the one thrown.
 */
export const inTransaction = async <T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    broken = timedOut(error) ? error : await rollBack(client);
    throw error;
  } finally {
    client.release(broken);
  }
};

const json = (value: unknown): string | null => (value === null ? null : JSON.stringify(value));

const insertEvent = (client: PoolClient, taskId: string, actor: Actor, event: DomainEvent) => {
  const { type, ...payload } = event;
  return appendTaskEvent(client, { taskId, actor, type, payload });
};

/** The project's next task number; the caller holds the project's row lock, which serializes it. */
const nextTaskNumber = async (client: PoolClient, projectId: string): Promise<number> =>
  (
    await client.query<{ number: number }>(
      'select coalesce(max(number), 0) + 1 as number from tasks where project_id = $1',
      [projectId]
    )
  ).rows[0]!.number;

interface NewTask {
  readonly projectId: string;
  readonly title: string;
  readonly requesterId: string;
  /** The connected app the requester opened it through, absent from the board or the CLI. */
  readonly via?: ConnectedApp | undefined;
  /** The requester's own words, recorded as the thread's first comment with the task. */
  readonly request?: string;
  /** What the request's words touch that no agent may handle alone (`guardsInRequest`). */
  readonly guards?: readonly Guard[];
  /** A question the task is born held on, so nothing moves it before someone answers. */
  readonly hold?: Blocked;
}

/** Opens a task at `request` inside the caller's transaction, so what follows lands with it. */
export const insertTask = async (client: PoolClient, input: NewTask): Promise<StoredTask> => {
  // Locking the project serializes task numbering per project.
  await client.query('select id from projects where id = $1 for update', [input.projectId]);
  const { rows } = await client.query<TaskRow>(
    `insert into tasks (project_id, number, title, requester_id, stage, guards, blocked)
     values ($1, $2, $3, $4, 'request', $5, $6)
     returning *`,
    [
      input.projectId,
      await nextTaskNumber(client, input.projectId),
      input.title,
      input.requesterId,
      input.guards ?? [],
      json(input.hold ?? null)
    ]
  );
  const row = rows[0]!;
  const requester = memberActor(input.requesterId, input.via);
  await appendTaskEvent(client, {
    taskId: row.id,
    actor: requester,
    type: 'created',
    payload: { title: input.title }
  });
  if (input.hold) {
    await insertEvent(client, row.id, ENGINE, { type: 'blocked', blocked: input.hold });
  }
  if (input.request !== undefined) {
    await addComment(client, row.id, requester, input.request);
  }
  return toStored(row);
};

/** `insertTask` in a transaction of its own. */
export const createTask = (pool: Pool, input: NewTask): Promise<StoredTask> =>
  inTransaction(pool, (client) => insertTask(client, input));

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
       values ($1, $2, $3, $4, 'onboarding', 'spec_review', $5, 1)
       returning id, number`,
    [
      input.projectId,
      await nextTaskNumber(client, input.projectId),
      input.title,
      input.requesterId,
      lane
    ]
  );
  const row = rows[0]!;
  await appendTaskEvent(client, {
    taskId: row.id,
    actor: ENGINE,
    type: 'created',
    payload: { title: input.title, kind: 'onboarding' }
  });
  await saveSpecVersion(client, {
    taskId: row.id,
    version: 1,
    body: input.spec,
    createdBy: ENGINE
  });
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
   * Checked against the locked, current task, inside the transaction. Agent results use it to
   * require the state the agent actually worked on (same stage, same head commit, its own run still
   * in progress), so a stale result is never applied.
   */
  readonly guard?: (task: Task, client: PoolClient) => boolean | Promise<boolean>;
  /** Runs inside the same transaction after the new state is written, e.g. to store a spec version. */
  readonly onApplied?: (client: PoolClient, task: Task) => Promise<void>;
}

/** `applyCommand` inside the caller's transaction, so the command lands with the caller's writes. */
export const applyCommandIn = async (
  client: PoolClient,
  input: ApplyInput
): Promise<ApplyResult> => {
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
  const proposals = await proposalsFor(client, input.command, toStored(row).task, approvals);

  const before = toStored(row).task;
  if (input.guard && !(await input.guard(before, client))) return { ok: false, error: 'conflict' };
  // Only a dispatch reads the onboarding gate; the share lock waits for an onboarding task
  // being opened, so the gate it reads is the one in force when the build starts.
  let onboardingOpen = false;
  if (input.command.type === 'dispatch') {
    await client.query('select id from projects where id = $1 for share', [row.project_id]);
    onboardingOpen = (await openOnboardingTask(client, row.project_id)) !== null;
  }
  // A build starts only once the task waits for nothing. Siblings take their parent's row lock in
  // turn, so two never both pass the check of shared files; locks go task, project, then parent.
  const startsBuild =
    (input.command.type === 'dispatch' || input.command.type === 'claim') &&
    before.stage === 'ready';
  if (startsBuild && row.parent_id)
    await client.query('select id from tasks where id = $1 for update', [row.parent_id]);
  const decision = decide(before, input.command, input.actor, {
    config: parsedConfig.config,
    members,
    approvals,
    onboardingOpen,
    proposals,
    ...(startsBuild ? { buildWait: buildWait(await buildLinksOf(client, input.taskId)) } : {})
  });
  if (!decision.ok) return decision;

  const task = decision.task;
  const updated = await client.query<{ version: number }>(
    `update tasks set stage = $2, lane = $3, spec_version = $4, head_sha = $5, user_visible = $6,
         assignee = $7, blocked = $8, paused = $9, fix_rounds = $10, reviews = $11, approval_plans = $12,
         guards = $13, diff_allowance = $14, split_proposed = $15, version = version + 1,
         updated_at = now()
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
      task.guards,
      json(task.diffAllowance),
      task.splitProposed
    ]
  );

  for (const event of decision.events) {
    await insertEvent(client, task.id, input.actor, event);
    if (event.type === 'paused') await markRunsPaused(client, task.id);
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
      isGate(event.stage)
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
};

export const applyCommand = (pool: Pool, input: ApplyInput): Promise<ApplyResult> =>
  inTransaction(pool, (client) => applyCommandIn(client, input));
