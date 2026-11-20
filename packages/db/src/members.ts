import { ROLES, managesEverywhere, type Role } from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { recordAccessEvent } from './access';
import { notifyInviteAccepted } from './notifications';
import { viewerRolesOver } from './projects';
import { inTransaction } from './store';

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
 * nobody. It takes the caller's transaction (a client, never the pool), as `redeemLoginLink`
 * gives it, so the sign-in and its notifications land together or not at all. Returns how many
 * notifications went out.
 */
export const recordFirstSignIn = async (client: PoolClient, memberId: string): Promise<number> => {
  const { rows } = await client.query<{ display_name: string }>(
    `update members set first_signed_in_at = now()
     where id = $1 and first_signed_in_at is null
     returning display_name`,
    [memberId]
  );
  const first = rows[0];
  return first ? notifyInviteAccepted(client, { id: memberId, name: first.display_name }) : 0;
};

export type RenameMemberResult =
  | { readonly ok: true; readonly name: string; readonly changed: boolean }
  | { readonly ok: false; readonly error: 'empty' | 'not_member' }
  | { readonly ok: false; readonly error: 'not_allowed'; readonly name: string };

/**
 * Changes a member's display name, trimmed. A name belongs to the member in every project of the
 * workspace, so anyone may change their own, and someone else's only if they may manage that member
 * in every project the member is in, as for a fresh invite link. The member must be in `projectId`,
 * the project the request comes from. Renaming to the name already held changes nothing and records
 * nothing, so a repeated request leaves one `renamed` access event.
 */
export const renameMember = (
  pool: Pool,
  input: { projectId: string; memberId: string; viewerId: string; name: string }
): Promise<RenameMemberResult> =>
  inTransaction(pool, async (client) => {
    const name = input.name.trim();
    if (!name) return { ok: false, error: 'empty' };
    const { rows } = await client.query<{ name: string }>(
      `select m.display_name as name
       from members m join project_roles r on r.member_id = m.id and r.project_id = $2
       where m.id = $1 for update of m`,
      [input.memberId, input.projectId]
    );
    const member = rows[0];
    if (!member) return { ok: false, error: 'not_member' };
    const self = input.viewerId === input.memberId;
    if (!self) {
      const roles = await viewerRolesOver(client, input.viewerId, [input.memberId]);
      if (!managesEverywhere(roles.get(input.memberId) ?? []))
        return { ok: false, error: 'not_allowed', name: member.name };
    }
    if (member.name === name) return { ok: true, name, changed: false };
    await client.query('update members set display_name = $2 where id = $1', [
      input.memberId,
      name
    ]);
    await recordAccessEvent(client, {
      memberId: input.memberId,
      type: 'renamed',
      detail: { from: member.name, to: name },
      actor: self ? null : { memberId: input.viewerId }
    });
    return { ok: true, name, changed: true };
  });
