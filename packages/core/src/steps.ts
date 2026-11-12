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
export const branchForTask = (taskNumber: number): string => `officina/task-${taskNumber}`;

/** Where the board opens a task. Task numbers are per project, so the link names the project. */
export const taskUrl = (publicUrl: string, projectId: string, taskNumber: number): string =>
  `${publicUrl.replace(/\/$/, '')}/tasks/${taskNumber}?project=${projectId}`;
