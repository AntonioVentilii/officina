import type { Gate, Policy, ProjectConfig, Requirement } from './config';
import type { Guard } from './guards';
import { GATE_ACTIONS, can, readsTask } from './permissions';
import { hasRole, type Member } from './roles';

export interface Approval {
  readonly memberId: string;
  /** What was approved: a spec version (`spec:3`) or a head commit (`sha:abc123`). */
  readonly subject: string;
}

export interface PolicyContext {
  readonly gate: Gate;
  readonly members: readonly Member[];
  readonly requesterId: string;
  readonly userVisible: boolean;
  readonly subject: string;
  /** The project's `approvals.self_approval`: whether the requester may meet their own gates. */
  readonly selfApproval: boolean;
  /** The task's guards: a confidential task is approved only by members who may read it. */
  readonly guards: readonly Guard[];
}

/** Who an approval needs, for the members who may meet it, without the subject and its approvals. */
export type Eligibility = Pick<
  PolicyContext,
  'gate' | 'members' | 'requesterId' | 'selfApproval' | 'guards'
>;

export interface PolicyResult {
  readonly satisfied: boolean;
  /** Requirements that still need an approval. */
  readonly pending: readonly Requirement[];
  /** Requirements no current member can meet, skipped so a small team is never stuck. */
  readonly waived: readonly Requirement[];
}

/** Every gate needs at least one maintainer or owner, whatever the lane policy says. */
export const APPROVAL_FLOOR: Requirement = { role: 'maintainer' };

/**
 * Whether an approval that meets `requirement` always meets `other` too, so `other` adds nothing
 * to ask for: a role includes every role below it, so an owner's approval meets the maintainer
 * floor.
 */
export const outranks = (requirement: Requirement, other: Requirement): boolean =>
  'role' in requirement &&
  'role' in other &&
  requirement.role !== other.role &&
  hasRole(requirement, other.role);

/** The policy context of a task's gate, from the project's config and its current members. */
export const policyContext = (
  config: Pick<ProjectConfig, 'approvals'>,
  task: {
    readonly requesterId: string;
    readonly userVisible: boolean;
    readonly guards: readonly Guard[];
  },
  gate: Gate,
  at: { readonly members: readonly Member[]; readonly subject: string }
): PolicyContext => ({
  gate,
  members: at.members,
  requesterId: task.requesterId,
  userVisible: task.userVisible,
  subject: at.subject,
  selfApproval: config.approvals.selfApproval,
  guards: task.guards
});

const meets = (member: Member, requirement: Requirement, context: Eligibility): boolean => {
  if (!can(member, GATE_ACTIONS[context.gate])) return false;
  if (!readsTask(member, context)) return false;
  if ('role' in requirement) return hasRole(member, requirement.role);
  if ('domain' in requirement) return member.domains.includes(requirement.domain);
  return member.id === context.requesterId;
};

/**
 * The members whose approval meets a requirement. Without self-approval the requester meets only
 * the requester requirement, unless nobody else can meet it, so a small team is never stuck.
 */
export const eligibleMembers = (requirement: Requirement, context: Eligibility): Member[] => {
  const all = context.members.filter((member) => meets(member, requirement, context));
  if (context.selfApproval || 'requester' in requirement) return all;
  const others = all.filter((member) => member.id !== context.requesterId);
  return others.length ? others : all;
};

/** The requirements of a policy that apply to this change, the maintainer floor last. */
export const applicableRequirements = (policy: Policy, userVisible: boolean): Requirement[] =>
  [...policy, APPROVAL_FLOOR].filter(
    (requirement) => !('when' in requirement && requirement.when === 'user_visible' && !userVisible)
  );

/**
 * One member's approval satisfies every requirement they are eligible for, which is what lets a
 * single owner run the whole workshop. Approvals on an older subject never count.
 */
export const evaluatePolicy = (
  policy: Policy,
  approvals: readonly Approval[],
  context: PolicyContext
): PolicyResult => {
  const approverIds = new Set(
    approvals
      .filter((approval) => approval.subject === context.subject)
      .map((approval) => approval.memberId)
  );

  const pending: Requirement[] = [];
  const waived: Requirement[] = [];

  for (const requirement of applicableRequirements(policy, context.userVisible)) {
    const eligible = eligibleMembers(requirement, context);
    // The floor is never waived: without a maintainer the gate must stay closed, not open.
    if (!eligible.length && requirement !== APPROVAL_FLOOR) {
      waived.push(requirement);
      continue;
    }
    if (!eligible.some((member) => approverIds.has(member.id))) pending.push(requirement);
  }

  return { satisfied: pending.length === 0, pending, waived };
};
