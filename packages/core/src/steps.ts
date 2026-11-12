import {
  REVIEWER_ROLES,
  TERMINAL_STAGES,
  gateSubject,
  type AgentRole,
  type Task
} from './lifecycle';

/** The agent roles whose work a task is waiting on right now. Held tasks wait on people, not agents. */
export const nextAgentRoles = (task: Task): AgentRole[] => {
  if (TERMINAL_STAGES.has(task.stage) || task.blocked || task.paused) return [];
  switch (task.stage) {
    case 'request':
      return ['interviewer'];
    case 'speccing':
      return ['spec'];
    case 'spec_review':
      // The approval chooser decides who must approve each spec version before anyone can.
      return task.approvalPlans.spec_review?.subject === gateSubject(task, 'spec_review')
        ? []
        : ['chooser'];
    case 'building':
      return task.assignee?.kind === 'agent' ? [task.assignee.role] : [];
    case 'reviewing':
      return REVIEWER_ROLES.filter((role) => task.reviews[role] !== 'approve');
    case 'choosing':
      return ['chooser'];
    default:
      return [];
  }
};

/** Agents may only push to this branch; the engine rejects a push anywhere else. */
/** Every branch an agent may push starts with this; the engine checks it is the task's own. */
export const TASK_BRANCH_PREFIX = 'officina/';

export const branchForTask = (taskNumber: number): string =>
  `${TASK_BRANCH_PREFIX}task-${taskNumber}`;
