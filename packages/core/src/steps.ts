import { REVIEWER_ROLES, TERMINAL_STAGES, type AgentRole, type Task } from './lifecycle';

/** The agent roles whose work a task is waiting on right now. Held tasks wait on people, not agents. */
export const nextAgentRoles = (task: Task): AgentRole[] => {
  if (TERMINAL_STAGES.has(task.stage) || task.blocked || task.paused) return [];
  switch (task.stage) {
    case 'speccing':
      return ['spec'];
    case 'building':
      return task.assignee?.kind === 'agent' ? ['builder'] : [];
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
