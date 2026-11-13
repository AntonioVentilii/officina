import type { Gate } from './config';
import { hasRole, type Member, type Role } from './roles';

/**
 * What a member may do in a project. Every check of a person's rights (the lifecycle, the board's
 * views and actions, the API, the CLI and the Claude connector) reads it from here, so the matrix
 * people read in the docs is the one the code enforces.
 */
export const ACTIONS = [
  'see',
  'request',
  'comment',
  'answer',
  'approve_spec',
  'verify_result',
  'triage',
  'build',
  'steer',
  'see_runs',
  'decide_learnings',
  'merge',
  'manage_members'
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * The least role that may take each action; roles are ordered, so every role above it may too.
 * Approving a plan or checking a result also needs the gate's policy to name the member (a role,
 * a domain or the requester), and answering needs the question to be asked of them.
 */
export const PERMISSIONS: Readonly<Record<Action, Role>> = {
  see: 'watcher',
  request: 'contributor',
  comment: 'contributor',
  answer: 'contributor',
  approve_spec: 'contributor',
  verify_result: 'contributor',
  triage: 'maintainer',
  build: 'maintainer',
  steer: 'maintainer',
  see_runs: 'maintainer',
  decide_learnings: 'maintainer',
  merge: 'maintainer',
  manage_members: 'owner'
};

/**
 * Domains that grant an action below its least role, so a project can let one contributor (a
 * developer it brings in to build) do it without making them a maintainer.
 */
export const DOMAIN_GRANTS: Readonly<Partial<Record<Action, string>>> = {
  build: 'developer'
};

/** Each action in the words people read on the board and in Claude. */
export const ACTION_LABELS: Readonly<Record<Action, string>> = {
  see: 'see every task in the project, its thread and every decision',
  request: 'open requests',
  comment: 'comment',
  answer: 'answer the questions asked of them',
  approve_spec: 'approve a plan when its approval policy names them',
  verify_result: 'check a result when its approval policy names them',
  triage: "accept or decline requests, and send anyone's request on",
  build:
    'claim a build and hand it in, built by hand or with their own agents (also anyone with the `developer` domain)',
  steer: 'pause, resume, review by hand or cancel any task, and hand a claimed build back',
  see_runs: 'see agent runs, their logs and costs',
  decide_learnings: 'accept or reject learnings',
  merge: 'merge results on GitHub',
  manage_members: 'invite members and change their roles'
};

/** The action a member takes at each human gate. */
export const GATE_ACTIONS: Readonly<Record<Gate, Action>> = {
  spec_review: 'approve_spec',
  verifying: 'verify_result'
};

export const can = (
  member: Pick<Member, 'role'> & Partial<Pick<Member, 'domains'>>,
  action: Action
): boolean => {
  const domain = DOMAIN_GRANTS[action];
  return (
    hasRole(member, PERMISSIONS[action]) ||
    (domain !== undefined && (member.domains ?? []).includes(domain))
  );
};

/** Everything a member may do, in the matrix's order. */
export const allowedActions = (
  member: Pick<Member, 'role'> & Partial<Pick<Member, 'domains'>>
): Action[] => ACTIONS.filter((action) => can(member, action));
