import type { ProjectConfig } from './config';
import type { Lane } from './lanes';
import type { Blocked, Task } from './lifecycle';
import { canAnswer } from './permissions';
import { optionKey, type QuestionOption } from './questions';
import type { ApproverRole, Member } from './roles';

/**
 * More lines than its lane allows, granted for one task by a person who looked at it. It holds only
 * in the lane it was granted in: a task that turns stricter is someone else's to allow again.
 */
export interface DiffAllowance {
  readonly lines: number;
  readonly lane: Lane;
  readonly memberId: string;
}

/** What the size check's question offers to allow, and the option that allows it. */
export interface AllowanceOffer {
  readonly lines: number;
  readonly lane: Lane;
  readonly option: string;
}

/**
 * Who may allow a task more lines than its lane: in red, the lane people always build and the owner
 * approves, only the owner; elsewhere a maintainer, or the owner.
 */
export const ALLOWS_DIFF: Readonly<Record<Lane, ApproverRole>> = {
  green: 'maintainer',
  standard: 'maintainer',
  red: 'owner'
};

const ALLOWED_BY: Readonly<Record<ApproverRole, string>> = {
  maintainer: 'a maintainer or the owner',
  owner: 'the owner'
};

/** Whether a member may allow a task in this lane more lines than the lane does. */
export const allowsDiff = (member: Pick<Member, 'id' | 'role' | 'domains'>, lane: Lane): boolean =>
  canAnswer(member, { role: ALLOWS_DIFF[lane] });

/** The task's allowance where it holds: granted in this same lane. */
const allowanceIn = (task: Pick<Task, 'diffAllowance'>, lane: Lane): DiffAllowance | null =>
  task.diffAllowance?.lane === lane ? task.diffAllowance : null;

/** The question the size check asks when a head is over the limit, and what tripped it. */
export interface DiffHold {
  readonly blocked: Blocked;
  readonly details: string;
}

/**
 * The hold for a head with more lines than the task may have in its lane: the lane's limit, or the
 * allowance granted for this task in that lane. It offers to split, to reduce, or to allow this size
 * for this task alone; the lane's limit stays for every other task.
 */
export const diffHold = (
  config: ProjectConfig,
  task: Pick<Task, 'diffAllowance'>,
  lane: Lane,
  lines: number
): DiffHold | null => {
  const laneLimit = config.lanes[lane].diffLines;
  const allowance = allowanceIn(task, lane);
  const limit = Math.max(laneLimit, allowance?.lines ?? 0);
  if (lines <= limit) return null;
  const over = allowance
    ? `over the ${lane} lane limit of ${laneLimit} and the ${allowance.lines} lines allowed for this task`
    : `over the ${lane} lane limit of ${laneLimit}`;
  const options: QuestionOption[] = [
    { label: 'Split the spec into smaller tasks' },
    { label: 'Reduce the change' },
    {
      label: `Allow ${lines} lines for this task`,
      detail: `Later heads of this task pass the size check up to ${lines} lines; every other task keeps the ${lane} lane limit of ${laneLimit}. Only ${ALLOWED_BY[ALLOWS_DIFF[lane]]} may choose this.`
    }
  ];
  return {
    blocked: {
      question: `The change has ${lines} lines, ${over}. Split the spec, reduce the change, or allow ${lines} lines for this task.`,
      askedOf: { role: 'maintainer' },
      options,
      allowance: { lines, lane, option: optionKey(options.length - 1) }
    },
    details: `${lines} > ${limit}`
  };
};

/** The allowance an answer grants: the size check's own option, picked from its question. */
export const pickedAllowance = (
  blocked: Blocked,
  option: string | undefined
): AllowanceOffer | null =>
  blocked.allowance && option === blocked.allowance.option ? blocked.allowance : null;
