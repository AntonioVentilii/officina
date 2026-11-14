/** Ordered from least to most privileged; a role includes every role before it. */
export const ROLES = ['watcher', 'contributor', 'maintainer', 'owner'] as const;
export type Role = (typeof ROLES)[number];

/**
 * The roles an approval requirement may name, and a handoff may go to: those that meet the
 * maintainer floor (`APPROVAL_FLOOR`).
 */
export const APPROVER_ROLES = ['maintainer', 'owner'] as const satisfies readonly Role[];
export type ApproverRole = (typeof APPROVER_ROLES)[number];

export interface Member {
  readonly id: string;
  readonly role: Role;
  /** Approval domains such as `product` or `legal`. */
  readonly domains: readonly string[];
}

export const hasRole = (member: Pick<Member, 'role'>, atLeast: Role): boolean =>
  ROLES.indexOf(member.role) >= ROLES.indexOf(atLeast);
