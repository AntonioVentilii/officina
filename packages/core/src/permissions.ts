import type { Gate } from './config';
import type { Guard } from './guards';
import type { Blocked } from './lifecycle';
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
  'see_confidential',
  'publish',
  'manage_members'
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * The least role that may take each action; roles are ordered, so every role above it may too.
 * Approving a plan or checking a result also needs the gate's policy to name the member (a role,
 * a domain or the requester), and answering needs the question to be asked of them.
 */
export const PERMISSIONS = {
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
  see_confidential: 'maintainer',
  publish: 'owner',
  manage_members: 'owner'
} as const satisfies Readonly<Record<Action, Role>>;

/**
 * Domains that grant an action below its least role, so a project can let one contributor (a
 * developer it brings in to build, a CEO or finance lead who reads confidential work) do it without
 * making them a maintainer.
 */
export const DOMAIN_GRANTS: Readonly<Partial<Record<Action, string>>> = {
  build: 'developer',
  see_confidential: 'confidential'
};

/** A domain grants nothing below this role: a watcher with a domain still only reads the board. */
const DOMAIN_GRANT_FLOOR: Role = 'contributor';

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
  see_confidential:
    "read and approve tasks that touch the project's confidential content (also anyone with the `confidential` domain)",
  publish: 'approve anything that publishes, deploys, changes access or touches secrets',
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
    (domain !== undefined &&
      hasRole(member, DOMAIN_GRANT_FLOOR) &&
      (member.domains ?? []).includes(domain))
  );
};

/** Everything a member may do, in the matrix's order. */
export const allowedActions = (
  member: Pick<Member, 'role'> & Partial<Pick<Member, 'domains'>>
): Action[] => ACTIONS.filter((action) => can(member, action));

type Person = Pick<Member, 'id' | 'role'> & Partial<Pick<Member, 'domains'>>;

/** Whether a question is asked of this member: by name, or of a role they hold. */
const isAskedOf = (member: Person, askedOf: Blocked['askedOf']): boolean =>
  'memberId' in askedOf ? askedOf.memberId === member.id : hasRole(member, askedOf.role);

/**
 * Whether a member may answer a question: one asked of them, and any question for an owner, so
 * nothing waits on someone who is away.
 */
export const canAnswer = (member: Person, askedOf: Blocked['askedOf']): boolean =>
  can(member, 'answer') && (hasRole(member, 'owner') || isAskedOf(member, askedOf));

/**
 * Whether a member may read a question. Questions are often an agent's or Officina's own failure,
 * quoting an error, so beyond those it is asked of only members who see the runs read them.
 */
export const seesQuestion = (member: Person, askedOf: Blocked['askedOf']): boolean =>
  can(member, 'see_runs') || isAskedOf(member, askedOf);

/**
 * Whether a member may read what a task says. A task guarded as confidential keeps its title,
 * stage and people for everyone, and its words for members with `see_confidential`.
 */
export const readsTask = (
  member: Pick<Member, 'role'> & Partial<Pick<Member, 'domains'>>,
  task: { readonly guards: readonly Guard[] }
): boolean => !task.guards.includes('confidential') || can(member, 'see_confidential');
