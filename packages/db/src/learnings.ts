import type { LearningTarget } from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { RUN_IS_ACTIVE } from './run-status';
import { startRun, type NewRun } from './runs';
import { inTransaction } from './store';

type Queryable = Pool | PoolClient;

export type LearningStatus = 'proposed' | 'accepted' | 'rejected' | 'applied';

/** Where the learner is with rewriting an edit that no longer applies; null when none was asked. */
export type LearningRewrite = 'requested' | 'failed';

export interface LearningRow {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly taskNumber: number | null;
  readonly taskTitle: string | null;
  readonly title: string;
  readonly lesson: string;
  readonly evidence: string;
  readonly target: LearningTarget;
  readonly file: string;
  readonly find: string | null;
  readonly text: string;
  readonly status: LearningStatus;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly rewrite: LearningRewrite | null;
  readonly rewrittenAt: Date | null;
  readonly createdAt: Date;
}

const COLUMNS = `
  l.id, l.project_id as "projectId", l.task_id as "taskId", t.number as "taskNumber",
  t.title as "taskTitle", l.title, l.text as lesson, l.evidence->>'text' as evidence, l.target,
  l.file, l.find, l.proposed_change as text, l.status, l.decided_by as "decidedBy",
  l.decided_at as "decidedAt", l.decision_note as "decisionNote", l.pr_number as "prNumber",
  l.pr_url as "prUrl", l.rewrite, l.rewritten_at as "rewrittenAt", l.created_at as "createdAt"`;

export interface NewLearning {
  readonly title: string;
  readonly lesson: string;
  readonly evidence: string;
  readonly target: LearningTarget;
  readonly edit: {
    readonly file: string;
    readonly find?: string | undefined;
    readonly text: string;
  };
}

export const insertLearnings = async (
  db: Queryable,
  input: { projectId: string; taskId: string; runId: string; learnings: readonly NewLearning[] }
) => {
  for (const learning of input.learnings) {
    await db.query(
      `insert into learnings (project_id, task_id, run_id, title, text, evidence, target, file, find, proposed_change)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.projectId,
        input.taskId,
        input.runId,
        learning.title,
        learning.lesson,
        JSON.stringify({ text: learning.evidence }),
        learning.target,
        learning.edit.file,
        learning.edit.find ?? null,
        learning.edit.text
      ]
    );
  }
};

export const listLearnings = async (db: Queryable, projectId: string): Promise<LearningRow[]> =>
  (
    await db.query<LearningRow>(
      `select ${COLUMNS} from learnings l left join tasks t on t.id = l.task_id
       where l.project_id = $1 order by l.created_at desc limit 200`,
      [projectId]
    )
  ).rows;

export const loadLearning = async (
  db: Queryable,
  projectId: string,
  id: string
): Promise<LearningRow | null> =>
  (
    await db.query<LearningRow>(
      `select ${COLUMNS} from learnings l left join tasks t on t.id = l.task_id
       where l.project_id = $1 and l.id = $2`,
      [projectId, id]
    )
  ).rows[0] ?? null;

/** Hands a proposed learning whose edit no longer applies back to the learner; asking twice is a no-op. */
export const requestLearningRewrite = async (db: Queryable, id: string) => {
  await db.query(
    `update learnings set rewrite = 'requested'
     where id = $1 and status = 'proposed' and rewrite is null`,
    [id]
  );
};

/** The oldest learning of a task waiting for the learner to rewrite its edit, if any. */
export const learningAwaitingRewrite = async (
  db: Queryable,
  taskId: string
): Promise<LearningRow | null> =>
  (
    await db.query<LearningRow>(
      `select ${COLUMNS} from learnings l left join tasks t on t.id = l.task_id
       where l.task_id = $1 and l.status = 'proposed' and l.rewrite = 'requested'
       order by l.created_at limit 1`,
      [taskId]
    )
  ).rows[0] ?? null;

/** Tasks with a learning waiting for the learner to rewrite its edit. */
export const listTasksAwaitingRewrite = async (
  db: Queryable,
  projectId: string
): Promise<string[]> =>
  (
    await db.query<{ id: string }>(
      `select distinct task_id as id from learnings
       where project_id = $1 and status = 'proposed' and rewrite = 'requested' and task_id is not null`,
      [projectId]
    )
  ).rows.map((row) => row.id);

/**
 * Locks a learning still waiting for its rewrite, then reads, after the lock, whether a learner run
 * holds its task and how many runs this request was given (those since its last rewrite). Whoever
 * claims or fails a rewrite holds this lock, so neither acts on what the other has just changed.
 */
const lockWaitingRewrite = async (db: PoolClient, id: string) => {
  const locked = await db.query(
    `select 1 from learnings where id = $1 and status = 'proposed' and rewrite = 'requested'
     for update`,
    [id]
  );
  if (!locked.rowCount) return null;
  const { rows } = await db.query<{ busy: boolean; runs: number }>(
    `select exists (
         select 1 from runs r
         where r.task_id = l.task_id and r.agent_role = 'learner' and r.status ${RUN_IS_ACTIVE}
       ) as busy,
       (select count(*)::int from runs r
        where r.learning_id = l.id and (l.rewritten_at is null or r.created_at > l.rewritten_at)
       ) as runs
     from learnings l where l.id = $1`,
    [id]
  );
  return rows[0]!;
};

const markRewriteFailed = (db: PoolClient, id: string) =>
  db.query("update learnings set rewrite = 'failed' where id = $1", [id]);

/**
 * Claims a run for a learning's rewrite. A rewrite settled meanwhile is `settled`; one that already
 * had `attempts` runs, all lost, is failed instead, so no further session is spent on it. The run
 * names its learning in the insert that claims it, so a run lost right after counts too.
 */
export const startLearningRewriteRun = (
  pool: Pool,
  run: Omit<NewRun, 'learningId'>,
  learningId: string,
  attempts: number
): Promise<{ ok: true; runId: string } | { ok: false; error: 'already_running' | 'settled' }> =>
  inTransaction(pool, async (db) => {
    const waiting = await lockWaitingRewrite(db, learningId);
    if (!waiting) return { ok: false, error: 'settled' };
    if (waiting.busy) return { ok: false, error: 'already_running' };
    if (waiting.runs >= attempts) {
      await markRewriteFailed(db, learningId);
      return { ok: false, error: 'settled' };
    }
    return startRun(db, { ...run, learningId });
  });

/**
 * Fails a rewrite the learner cannot run, unless a learner run is in progress on its task: that run
 * may still deliver. Says whether it failed it.
 */
export const failIdleLearningRewrite = (pool: Pool, id: string): Promise<boolean> =>
  inTransaction(pool, async (db) => {
    const waiting = await lockWaitingRewrite(db, id);
    if (!waiting || waiting.busy) return false;
    await markRewriteFailed(db, id);
    return true;
  });

/** Replaces the edit of a learning waiting for its rewrite; people decide it again from here. */
export const rewriteLearningEdit = async (db: Queryable, id: string, edit: NewLearning['edit']) => {
  await db.query(
    `update learnings set file = $2, find = $3, proposed_change = $4, rewrite = null,
       rewritten_at = now()
     where id = $1 and status = 'proposed' and rewrite = 'requested'`,
    [id, edit.file, edit.find ?? null, edit.text]
  );
};

/** The learner could not rewrite the edit, so the learning is left for people to reject. */
export const failLearningRewrite = async (db: Queryable, id: string) => {
  await db.query(
    `update learnings set rewrite = 'failed'
     where id = $1 and status = 'proposed' and rewrite = 'requested'`,
    [id]
  );
};

/** Locks a learning until the transaction ends, so two decisions on it run one after the other. */
export const lockLearning = async (db: Queryable, id: string) => {
  await db.query('select 1 from learnings where id = $1 for update', [id]);
};

/** Records a decision once: a learning that is no longer proposed cannot be decided again. */
export const decideLearning = async (
  db: Queryable,
  input: {
    id: string;
    status: 'accepted' | 'rejected';
    memberId: string;
    note: string | null;
    prNumber?: number;
    prUrl?: string;
  }
): Promise<boolean> =>
  ((
    await db.query(
      `update learnings set status = $2, decided_by = $3, decided_at = now(), decision_note = $4,
         pr_number = $5, pr_url = $6
       where id = $1 and status = 'proposed'`,
      [
        input.id,
        input.status,
        input.memberId,
        input.note,
        input.prNumber ?? null,
        input.prUrl ?? null
      ]
    )
  ).rowCount ?? 0) === 1;

/** A merged learning pull request makes its learning applied. */
export const markLearningsApplied = async (db: Queryable, repo: string, prNumber: number) =>
  (
    await db.query<{ id: string }>(
      `update learnings l set status = 'applied'
       from projects p
       where p.id = l.project_id and lower(p.github_repo) = lower($1) and l.pr_number = $2
         and l.status = 'accepted'
       returning l.id`,
      [repo, prNumber]
    )
  ).rows.map((row) => row.id);

/** Done tasks the learner has not looked at yet, recent ones only. */
export const listTasksAwaitingLearning = async (
  db: Queryable,
  projectId: string
): Promise<string[]> =>
  (
    await db.query<{ id: string }>(
      `select t.id from tasks t
       where t.project_id = $1 and t.stage = 'done' and t.updated_at > now() - interval '14 days'
         and not exists (select 1 from runs r where r.task_id = t.id and r.agent_role = 'learner')
       order by t.updated_at`,
      [projectId]
    )
  ).rows.map((row) => row.id);

/** Whether the learner already finished or failed a look at this task; it never looks twice. */
export const learnerHasLooked = async (db: Queryable, taskId: string): Promise<boolean> =>
  Boolean(
    (
      await db.query(
        `select 1 from runs where task_id = $1 and agent_role = 'learner'
           and not (status ${RUN_IS_ACTIVE})`,
        [taskId]
      )
    ).rowCount
  );

/** What the project has already learned or turned down, so the learner does not repeat it. */
export const listRecentLearningTitles = async (db: Queryable, projectId: string) =>
  (
    await db.query<{ title: string; status: LearningStatus; file: string }>(
      `select title, status, file from learnings where project_id = $1
       order by created_at desc limit 40`,
      [projectId]
    )
  ).rows;

/**
 * The learnings of this run's project that people decided on at or after `since`: accepting one
 * pushes its edit to its own branch with the App's identity, which the check after a build running
 * alongside must not take for the builder's push.
 */
export const learningsDecidedDuring = async (
  pool: Pool,
  runId: string,
  since: Date
): Promise<{ id: string; rewrittenAt: Date | null }[]> =>
  (
    await pool.query<{ id: string; rewrittenAt: Date | null }>(
      `select l.id, l.rewritten_at as "rewrittenAt" from runs r
       join tasks t on t.id = r.task_id
       join learnings l on l.project_id = t.project_id
       where r.id = $1 and l.decided_at >= $2`,
      [runId, since]
    )
  ).rows;
