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

/** Every branch Officina's agents push starts with this; the contracts check it. */
export const TASK_BRANCH_PREFIX = 'officina/';

/** Agents may only push to this branch; the engine rejects a push anywhere else. */
export const branchForTask = (taskNumber: number): string =>
  `${TASK_BRANCH_PREFIX}task-${taskNumber}`;

/**
 * The branch an accepted learning's edit is pushed to. A rewritten edit gets a branch of its own:
 * one an accept left before the rewrite starts from an older default branch, while retries of the
 * same edit keep reusing theirs.
 */
export const branchForLearning = (learning: {
  readonly id: string;
  readonly rewrittenAt: Date | null;
}): string =>
  `${TASK_BRANCH_PREFIX}learning-${learning.id.slice(0, 8)}` +
  (learning.rewrittenAt ? `-${learning.rewrittenAt.getTime().toString(36)}` : '');

/** Where the board opens a task. Task numbers are per project, so the link names the project. */
export const taskUrl = (publicUrl: string, projectId: string, taskNumber: number): string =>
  `${publicUrl.replace(/\/$/, '')}/tasks/${taskNumber}?project=${projectId}`;
