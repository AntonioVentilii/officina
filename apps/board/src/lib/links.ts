type Payload = Readonly<Record<string, unknown>>;

/** "task 3" or "tasks 3, 5", from the task numbers an event's payload holds. */
const tasks = (numbers: unknown): string => {
  const list: unknown[] = Array.isArray(numbers) ? numbers : [];
  return `${list.length === 1 ? 'task' : 'tasks'} ${list.join(', ')}`;
};

const linked = (payload: Payload): string => {
  const parts = [
    ...(payload.parent ? [`parent task ${String(payload.parent)}`] : []),
    ...(Array.isArray(payload.after) && payload.after.length
      ? [`waits for ${tasks(payload.after)}`]
      : [])
  ];
  return parts.length ? `linked it: ${parts.join(', ')}` : 'removed its links';
};

/** The timeline's sentence for a change to a task's links, and for a parent's sub-tasks opened or closed. */
export const LINK_SENTENCES: Readonly<Record<string, (payload: Payload) => string>> = {
  links_changed: linked,
  subtasks_merged: (payload) =>
    `closed it: no sub-task left open, ${tasks(payload.subtasks)} merged`,
  subtasks_opened: (payload) => `opened its sub-tasks from the split: ${tasks(payload.subtasks)}`
};
