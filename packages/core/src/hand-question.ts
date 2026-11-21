import { asOneQuestion } from './handoff-routes';
import type { Decision, Task } from './lifecycle';
import { isAskedOf, takesQuestion } from './permissions';
import type { Member } from './roles';

/**
 * An owner hands a task's waiting question to one member, who then answers it as if it had been
 * asked of them by name; owners may still answer it. The hold of an early merge is closed rather
 * than answered, so it stays with whoever decides it. Handing it to someone it is already asked of,
 * by name or by a role they hold, records nothing.
 */
export const handedQuestion = (task: Task, to: Member | undefined): Decision => {
  const blocked = task.blocked;
  if (!blocked) return { ok: false, error: 'not_blocked' };
  if (task.mergedEarly) return { ok: false, error: 'merged_early' };
  if (to === undefined || !takesQuestion(to, task)) return { ok: false, error: 'not_answerer' };
  if (isAskedOf(to, blocked.askedOf)) return { ok: true, task, events: [] };
  return {
    ok: true,
    // The whole question goes to them: parts others already answered are in the thread.
    task: { ...task, blocked: asOneQuestion(blocked, { memberId: to.id }) },
    events: [{ type: 'question_handed', from: blocked.askedOf, memberId: to.id }]
  };
};
