import {
  can,
  CHECK_OUTCOMES,
  checklistHead,
  evidenceSchema,
  readsTask,
  type CheckChannel,
  type CheckOutcome
} from '@officina/core';
import {
  findTaskIdByNumber,
  latestChooserResult,
  loadProjectMember,
  loadTask,
  recordCheck
} from '@officina/db';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { ProjectActor } from './tasks';
import { TaskCommandError } from './tasks';

/** One check as the board and the connector send it: the item by its number, from 1. */
export const checklistCheckSchema = z.object({
  item: z.number().int().min(1),
  outcome: z.enum(CHECK_OUTCOMES),
  evidence: evidenceSchema
});

export type CheckRequest = {
  readonly item: number;
  readonly outcome: CheckOutcome;
  readonly evidence: string;
};

/** The task a member asks about, if they may read it. */
const readableTask = async (pool: Pool, input: ProjectActor & { readonly number: number }) => {
  const member = await loadProjectMember(pool, input.projectId, input.memberId);
  const taskId = await findTaskIdByNumber(pool, input.projectId, input.number);
  const stored = taskId ? await loadTask(pool, taskId) : null;
  if (!member || !taskId || !stored || !readsTask(member, stored.task))
    throw new TaskCommandError(`task #${input.number} not found`, 404);
  return { member, taskId, task: stored.task };
};

/** The task a member asks to check, with the head and the number of items they may check. */
const checkableTask = async (pool: Pool, input: ProjectActor & { readonly number: number }) => {
  const { member, taskId, task } = await readableTask(pool, input);
  if (!can(member, 'verify_result'))
    throw new TaskCommandError('you do not have the role needed to check results', 403);
  const headSha = checklistHead(task);
  if (task.stage !== 'verifying' || !headSha || headSha !== task.headSha)
    throw new TaskCommandError('the task is not waiting for its result to be checked');
  const chosen = (await latestChooserResult(pool, taskId)) as { checklist?: string[] } | null;
  return { taskId, headSha, items: chosen?.checklist?.length ?? 0 };
};

/**
 * Records what a person found for one item of the checklist under verification, as themselves,
 * from the board or through Claude. Only while the task waits for that verification, and only by
 * someone who may check results: the head checked is the one the checklist was written for.
 */
export const recordCheckAs = async (
  pool: Pool,
  input: ProjectActor & CheckRequest & { readonly number: number; readonly channel: CheckChannel }
): Promise<{ recorded: boolean }> => {
  const { taskId, headSha, items } = await checkableTask(pool, input);
  if (input.item > items)
    throw new TaskCommandError(`the checklist has ${items} items; there is no item ${input.item}`);
  return recordCheck(pool, {
    taskId,
    headSha,
    item: input.item - 1,
    outcome: input.outcome,
    evidence: input.evidence,
    memberId: input.memberId,
    channel: input.channel
  });
};
