import type { ProjectConfig, Requirement } from './config';
import {
  effectivePolicy,
  gateSubject,
  humanBuildReason,
  type PlanInput,
  type Task
} from './lifecycle';
import { applicableRequirements, eligibleMembers, type Eligibility } from './policies';
import { APPROVER_ROLES, type Member } from './roles';

type PlannedTask = Pick<
  Task,
  | 'stage'
  | 'lane'
  | 'specVersion'
  | 'headSha'
  | 'approvalPlans'
  | 'guards'
  | 'requesterId'
  | 'userVisible'
>;

/** What a plan made by rule tells the people who approve, in place of the chooser's reasoning. */
export const RULED_PLAN_RATIONALE =
  'Planned by rule: a person builds this, and no approval the chooser could add would change who approves the plan.';

/**
 * Every approval the chooser could add at a gate: either approver role and each domain a member
 * holds (a domain nobody holds is waived), plus the lane's own requirements as they would read if
 * the chooser marked the change user-visible.
 */
const possibleAdditions = (policy: readonly Requirement[], members: readonly Member[]) => [
  ...applicableRequirements(policy, true),
  ...APPROVER_ROLES.map((role) => ({ role })),
  ...[...new Set(members.flatMap((member) => member.domains))].map((domain) => ({ domain }))
];

/**
 * Whether requiring `addition` could change which approvals open the gate. It cannot when nobody
 * may meet it (it is waived), or when a requirement already in force can only be met by members
 * who meet it too: whoever meets that one meets the addition with the same approval.
 */
const changesNothing = (
  addition: Requirement,
  inForce: readonly Requirement[],
  eligibility: Eligibility
): boolean => {
  const meetsAddition = new Set(eligibleMembers(addition, eligibility).map(({ id }) => id));
  if (meetsAddition.size === 0) return true;
  return inForce.some((requirement) => {
    const meets = eligibleMembers(requirement, eligibility);
    return meets.length > 0 && meets.every(({ id }) => meetsAddition.has(id));
  });
};

/**
 * The spec's approval plan when no chooser could change it, `null` when the chooser must decide.
 * That is when the lane (or an earlier plan) already says a person builds it, and every approval
 * the chooser could add is waived or already implied. The chooser's depth, verifiers and
 * rationale then only inform people, so the engine plans it without paying for a session.
 */
export const ruledSpecPlan = (
  config: ProjectConfig,
  task: PlannedTask,
  members: readonly Member[]
): PlanInput | null => {
  if (task.stage !== 'spec_review') return null;
  if (task.approvalPlans.spec_review?.subject === gateSubject(task, 'spec_review')) return null;
  const buildReason = humanBuildReason(config, task);
  if (buildReason === null) return null;
  const policy = effectivePolicy(config, task, 'spec_review');
  const eligibility: Eligibility = {
    gate: 'spec_review',
    members,
    requesterId: task.requesterId,
    selfApproval: config.approvals.selfApproval,
    guards: task.guards
  };
  const inForce = applicableRequirements(policy, task.userVisible);
  const settled = possibleAdditions(policy, members).every((addition) =>
    changesNothing(addition, inForce, eligibility)
  );
  if (!settled) return null;
  return {
    depth: 'glance',
    rationale: RULED_PLAN_RATIONALE,
    extra: [],
    verifiers: [],
    build: 'person',
    buildReason
  };
};
