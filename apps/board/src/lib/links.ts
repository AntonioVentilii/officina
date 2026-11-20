import type { TaskEvent } from './types';

const numbers = (value: unknown) => (Array.isArray(value) ? value.join(', ') : '');

/** What the timeline says about a task's links to other tasks; `null` for any other event. */
export const linkSentence = ({
  type,
  payload
}: Pick<TaskEvent, 'type' | 'payload'>): string | null => {
  if (type === 'subtasks_merged')
    return `closed it: every sub-task merged (tasks ${numbers(payload.subtasks)})`;
  if (type !== 'links_changed') return null;
  const after = numbers(payload.after);
  const links = [
    ...(typeof payload.parent === 'number' ? [`parent task ${payload.parent}`] : []),
    ...(after ? [`waits for tasks ${after}`] : [])
  ];
  return links.length ? `linked it: ${links.join(', ')}` : 'removed its links';
};
