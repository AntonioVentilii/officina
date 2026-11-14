import { ROLES, type Role } from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { notifyInviteAccepted } from './notifications';

type Queryable = Pool | PoolClient;

/** Where a member's latest sign-in link stands. */
export const LINK_STATES = ['pending', 'used', 'expired'] as const;
export type LinkState = (typeof LINK_STATES)[number];

export interface MemberActivity {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  /** Approval domains such as `product`; what they may approve beyond their role. */
  readonly domains: readonly string[];
  readonly firstSignedInAt: Date | null;
  /** The member's latest sign-in link, or null when none is on record. */
  readonly link: {
    readonly state: LinkState;
    readonly createdAt: Date;
    readonly usedAt: Date | null;
    readonly expiresAt: Date;
  } | null;
  readonly lastSeenAt: Date | null;
  /** Whether a Claude connector grant of theirs can still be refreshed. */
  readonly claudeConnected: boolean;
}

interface ActivityRow {
  id: string;
  name: string;
  role: Role;
  domains: string[];
  first_signed_in_at: Date | null;
  link_state: LinkState | null;
  link_created_at: Date | null;
  link_used_at: Date | null;
  link_expires_at: Date | null;
  last_seen_at: Date | null;
  claude_connected: boolean;
}

/**
 * Who is in a project and how far each person got: their latest link, their last board request and
 * whether they connected Claude. Only names, roles and timestamps leave this query, never a token.
 * Highest role first, then by name.
 */
export const listMemberActivity = async (
  db: Queryable,
  projectId: string
): Promise<MemberActivity[]> =>
  (
    await db.query<ActivityRow>(
      `select m.id, m.display_name as name, r.role, r.domains, m.first_signed_in_at,
              case when l.used_at is not null then 'used'
                   when l.expires_at <= now() then 'expired'
                   when l.created_at is not null then 'pending' end as link_state,
              l.created_at as link_created_at, l.used_at as link_used_at,
              l.expires_at as link_expires_at,
              (select max(s.last_seen_at) from sessions s where s.member_id = m.id) as last_seen_at,
              exists (select 1 from connector_tokens t
                      where t.member_id = m.id and t.kind = 'refresh' and t.used_at is null
                        and t.expires_at > now()) as claude_connected
       from project_roles r
       join members m on m.id = r.member_id
       left join lateral (
         select created_at, used_at, expires_at from login_links
         where member_id = m.id order by created_at desc, token_hash desc limit 1
       ) l on true
       where r.project_id = $1
       order by array_position($2::text[], r.role) desc, lower(m.display_name)`,
      [projectId, ROLES]
    )
  ).rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    domains: row.domains,
    firstSignedInAt: row.first_signed_in_at,
    link:
      row.link_state && row.link_created_at && row.link_expires_at
        ? {
            state: row.link_state,
            createdAt: row.link_created_at,
            usedAt: row.link_used_at,
            expiresAt: row.link_expires_at
          }
        : null,
    lastSeenAt: row.last_seen_at,
    claudeConnected: row.claude_connected
  }));

/**
 * Records a member's first sign-in and tells whoever may invite members to each of their projects
 * that the invite was accepted. Only the first call finds the column empty, so a repeat notifies
 * nobody. The caller holds a transaction, as `redeemLoginLink` does, so the two land together.
 * Returns how many notifications went out.
 */
export const recordFirstSignIn = async (db: Queryable, memberId: string): Promise<number> => {
  const { rows } = await db.query<{ display_name: string }>(
    `update members set first_signed_in_at = now()
     where id = $1 and first_signed_in_at is null
     returning display_name`,
    [memberId]
  );
  const first = rows[0];
  return first ? notifyInviteAccepted(db, { id: memberId, name: first.display_name }) : 0;
};
