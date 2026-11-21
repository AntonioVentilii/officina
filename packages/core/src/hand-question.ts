import type { Decision, Task } from './lifecycle';
import { can, readsTask } from './permissions';
import type { Member } from './roles';

/** Whether a member can take a question handed to them: they may answer and read the task. */
export const takesQuestion = (member: Member, task: Pick<Task, 'guards'>): boolean =>
  can(member, 'answer') && readsTask(member, task);

/**
 * An owner hands a task's waiting question to one member, who then answers it as if it had been
 * asked of them by name; owners may still answer it. The hold of an early merge is closed rather
 * than answered, so it stays with whoever decides it. Handing it to whoever it is already asked of
 * records nothing.
 */
export const handedQuestion = (task: Task, to: Member | undefined): Decision => {
  const blocked = task.blocked;
  if (!blocked) return { ok: false, error: 'not_blocked' };
  if (task.mergedEarly) return { ok: false, error: 'merged_early' };
  if (to === undefined || !takesQuestion(to, task)) return { ok: false, error: 'not_answerer' };
  if ('memberId' in blocked.askedOf && blocked.askedOf.memberId === to.id)
    return { ok: true, task, events: [] };
  return {
    ok: true,
    task: { ...task, blocked: { ...blocked, askedOf: { memberId: to.id } } },
    events: [{ type: 'question_handed', from: blocked.askedOf, memberId: to.id }]
  };
};
