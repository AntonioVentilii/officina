import {
  ENGINE,
  type Actor,
  type ProposedSplit,
  type ProposedSubtask,
  type Task
} from '@officina/core';
import type { PoolClient } from 'pg';
import { insertTask } from './store';
import { appendTaskEvent } from './task-history';
import { setTaskLinks } from './task-links';
import { addComment } from './tasks';

interface ApprovedTask {
  readonly projectId: string;
  readonly number: number;
  readonly requesterId: string;
  readonly guards: Task['guards'];
  readonly split: ProposedSplit | null;
}

/** What a sub-task's spec agent reads as its request: its part of the approved split. */
const subtaskRequest = (
  parent: number,
  split: ProposedSplit,
  subtask: ProposedSubtask,
  index: number
): string =>
  [
    `Sub-task ${index + 1} of ${split.subtasks.length} of task ${parent}, from its approved split.`,
    subtask.scope,
    `Files it roughly touches: ${subtask.paths.map((path) => `\`${path}\``).join(', ')}`
  ].join('\n\n');

/**
 * Opens the sub-tasks of the split a task's current spec version proposes, inside the transaction
 * that approved it: each at `speccing` with its part of the split as its request and the task's
 * guards, linked to the task as their parent and to the sub-tasks it waits for. Returns their
 * numbers in order; the approval moved the task on, so it never runs twice.
 */
export const openSplitSubtasks = async (
  client: PoolClient,
  input: { readonly taskId: string; readonly actor: Actor }
): Promise<number[]> => {
  const parent = (
    await client.query<ApprovedTask>(
      `select t.project_id as "projectId", t.number, t.requester_id as "requesterId", t.guards,
              v.split
         from tasks t join spec_versions v on v.task_id = t.id and v.version = t.spec_version
        where t.id = $1`,
      [input.taskId]
    )
  ).rows[0];
  if (!parent?.split) return [];
  const opened: { id: string; number: number }[] = [];
  for (const [index, subtask] of parent.split.subtasks.entries()) {
    const { task } = await insertTask(client, {
      projectId: parent.projectId,
      title: subtask.title,
      requesterId: parent.requesterId,
      guards: parent.guards,
      stage: 'speccing'
    });
    await addComment(
      client,
      task.id,
      ENGINE,
      subtaskRequest(parent.number, parent.split, subtask, index)
    );
    const number = (
      await client.query<{ number: number }>('select number from tasks where id = $1', [task.id])
    ).rows[0]!.number;
    const links = await setTaskLinks(client, {
      projectId: parent.projectId,
      taskId: task.id,
      parentId: input.taskId,
      after: subtask.after.map((position) => opened[position - 1]!.id),
      actor: input.actor
    });
    if (links.problem)
      throw new Error(`a sub-task of the split could not be linked: ${links.problem}`);
    opened.push({ id: task.id, number });
  }
  const numbers = opened.map((task) => task.number);
  await appendTaskEvent(client, {
    taskId: input.taskId,
    actor: input.actor,
    type: 'subtasks_opened',
    payload: { subtasks: numbers }
  });
  return numbers;
};
