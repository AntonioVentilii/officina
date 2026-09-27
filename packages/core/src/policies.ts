import type { Policy, Requirement } from './config';
import { hasRole, type Member } from './roles';

export interface Approval {
  readonly memberId: string;
  /** What was approved: a spec version (`spec:3`) or a head commit (`sha:abc123`). */
  readonly subject: string;
}

export interface PolicyContext {
  readonly members: readonly Member[];
  readonly requesterId: string;
  readonly userVisible: boolean;
  readonly subject: string;
}

export interface PolicyResult {
  readonly satisfied: boolean;
  /** Requirements that still need an approval. */
  readonly pending: readonly Requirement[];
  /** Requirements no current member can meet, skipped so a small team is never stuck. */
  readonly waived: readonly Requirement[];
}

/** Every gate needs at least one maintainer or owner, whatever the lane policy says. */
export const APPROVAL_FLOOR: Requirement = { role: 'maintainer' };

export const isEligible = (
  member: Member,
  requirement: Requirement,
  requesterId: string
): boolean => {
  if (!hasRole(member, 'contributor')) {
    return false;
  }
  if ('role' in requirement) {
    return hasRole(member, requirement.role);
  }
  if ('domain' in requirement) {
    return member.domains.includes(requirement.domain);
  }
  return member.id === requesterId;
};

const applies = (requirement: Requirement, userVisible: boolean): boolean =>
  !('when' in requirement && requirement.when === 'user_visible' && !userVisible);

/**
 * One member's approval satisfies every requirement they are eligible for, which is what lets a
 * single owner run the whole workshop. Approvals on an older subject never count.
 */
export const evaluatePolicy = (
  policy: Policy,
  approvals: readonly Approval[],
  context: PolicyContext
): PolicyResult => {
  const membersById = new Map(context.members.map((member) => [member.id, member]));
  const approvers = approvals
    .filter((approval) => approval.subject === context.subject)
    .map((approval) => membersById.get(approval.memberId))
    .filter((member): member is Member => member !== undefined);

  const pending: Requirement[] = [];
  const waived: Requirement[] = [];

  for (const requirement of [...policy, APPROVAL_FLOOR]) {
    if (!applies(requirement, context.userVisible)) {
      continue;
    }
    const eligibleExists = context.members.some((member) =>
      isEligible(member, requirement, context.requesterId)
    );
    // The floor is never waived: without a maintainer the gate must stay closed, not open.
    if (!eligibleExists && requirement !== APPROVAL_FLOOR) {
      waived.push(requirement);
      continue;
    }
    const met = approvers.some((member) => isEligible(member, requirement, context.requesterId));
    if (!met) {
      pending.push(requirement);
    }
  }

  return { satisfied: pending.length === 0, pending, waived };
};

export const canApprove = (member: Member): boolean => hasRole(member, 'contributor');
