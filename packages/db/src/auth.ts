import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_BOARD_LOOK, type BoardLook, type Role } from '@officina/core';
import type { Pool, PoolClient } from 'pg';
import { recordAccessEvent } from './access';
import { purgeExpiredOAuthStates } from './github-accounts';
import { recordFirstSignIn } from './members';
import { inTransaction } from './store';

type Queryable = Pool | PoolClient;

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A one-time sign-in link token for a member; only its hash is stored. */
export const createLoginLink = async (
  db: Queryable,
  memberId: string,
  ttlMs: number
): Promise<string> => {
  const token = newToken();
  await db.query(
    `insert into login_links (token_hash, member_id, expires_at)
     values ($1, $2, now() + make_interval(secs => $3))`,
    [hashToken(token), memberId, ttlMs / 1000]
  );
  return token;
};

export type InviteLinkResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly error: 'not_member' }
  | { readonly ok: false; readonly error: 'signed_in'; readonly name: string };

/**
 * A new sign-in link for a project member who has never signed in. The member's row is locked while
 * the link is written, so a sign-in racing it either lands first, and no link is made, or after.
 */
export const createInviteLink = (
  pool: Pool,
  input: { projectId: string; memberId: string; ttlMs: number }
): Promise<InviteLinkResult> =>
  inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ name: string; signed_in: boolean }>(
      `select m.display_name as name, m.first_signed_in_at is not null as signed_in
       from members m join project_roles r on r.member_id = m.id and r.project_id = $2
       where m.id = $1 for update of m`,
      [input.memberId, input.projectId]
    );
    const member = rows[0];
    if (!member) return { ok: false, error: 'not_member' };
    if (member.signed_in) return { ok: false, error: 'signed_in', name: member.name };
    return { ok: true, token: await createLoginLink(client, input.memberId, input.ttlMs) };
  });

/** The member a sign-in link signs in as, while it can still be used; it is not spent. */
export const loginLinkMember = async (db: Queryable, token: string): Promise<string | null> =>
  (
    await db.query<{ member_id: string }>(
      `select member_id from login_links
       where token_hash = $1 and used_at is null and expires_at > now()`,
      [hashToken(token)]
    )
  ).rows[0]?.member_id ?? null;

/**
 * Spends a sign-in link and opens a session, both or neither: a failure after spending it would
 * otherwise burn the link without signing anyone in. A link works once, and only before it expires.
 * A member's first link also records their first sign-in, which tells the project owners.
 */
export const redeemLoginLink = (
  pool: Pool,
  token: string
): Promise<{ sessionToken: string; memberId: string } | null> =>
  inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ member_id: string }>(
      `update login_links set used_at = now()
       where token_hash = $1 and used_at is null and expires_at > now()
       returning member_id`,
      [hashToken(token)]
    );
    const memberId = rows[0]?.member_id;
    if (!memberId) return null;
    await recordFirstSignIn(client, memberId);
    await recordAccessEvent(client, { memberId, type: 'signed_in', detail: { method: 'link' } });
    return { sessionToken: await createSession(client, memberId), memberId };
  });

/** Opens a session for a member whose identity was just proven; returns its token. */
export const createSession = async (db: Queryable, memberId: string): Promise<string> => {
  const sessionToken = newToken();
  await db.query(
    `insert into sessions (token_hash, member_id, expires_at)
     values ($1, $2, now() + make_interval(secs => $3))`,
    [hashToken(sessionToken), memberId, SESSION_TTL_MS / 1000]
  );
  return sessionToken;
};

export interface SessionMember {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly workspaceId: string;
}

export const memberForSession = async (
  db: Queryable,
  sessionToken: string
): Promise<SessionMember | null> => {
  const { rows } = await db.query<SessionMember>(
    `update sessions s set last_seen_at = now()
     from members m
     where s.token_hash = $1 and s.expires_at > now() and m.id = s.member_id
     returning m.id, m.display_name as "displayName", m.email, m.workspace_id as "workspaceId"`,
    [hashToken(sessionToken)]
  );
  return rows[0] ?? null;
};

/** A member by id, for credentials other than a session cookie (the connector's tokens). */
export const loadSessionMember = async (
  db: Queryable,
  memberId: string
): Promise<SessionMember | null> =>
  (
    await db.query<SessionMember>(
      `select id, display_name as "displayName", email, workspace_id as "workspaceId"
       from members where id = $1`,
      [memberId]
    )
  ).rows[0] ?? null;

export const endSession = async (db: Queryable, sessionToken: string) => {
  await db.query('delete from sessions where token_hash = $1', [hashToken(sessionToken)]);
};

/**
 * Deletes sign-in links, sessions and GitHub authorization states that can no longer be used, so
 * the tables hold only live credentials. Each member's latest link stays, spent or not: it is what
 * shows owners whether an invite was used or ran out, and its hash can no longer sign anyone in.
 */
export const purgeExpiredCredentials = async (
  db: Queryable
): Promise<{ loginLinks: number; sessions: number; oauthStates: number }> => {
  const links = await db.query(
    `delete from login_links l
     where (l.expires_at <= now() or l.used_at is not null)
       and exists (select 1 from login_links newer
                   where newer.member_id = l.member_id
                     and (newer.created_at, newer.token_hash) > (l.created_at, l.token_hash))`
  );
  const sessions = await db.query('delete from sessions where expires_at <= now()');
  return {
    loginLinks: links.rowCount ?? 0,
    sessions: sessions.rowCount ?? 0,
    oauthStates: await purgeExpiredOAuthStates(db)
  };
};

export interface MemberProject {
  readonly id: string;
  readonly name: string;
  readonly repo: string;
  readonly role: Role;
  readonly domains: readonly string[];
  /** The project's default board look; the config is validated before it is stored. */
  readonly look: BoardLook;
}

export const listMemberProjects = async (
  db: Queryable,
  memberId: string
): Promise<MemberProject[]> =>
  (
    await db.query<MemberProject>(
      `select p.id, p.name, p.github_repo as repo, r.role, r.domains,
              coalesce(p.config #>> '{board,look}', $2) as look
       from project_roles r join projects p on p.id = r.project_id
       where r.member_id = $1 order by p.name`,
      [memberId, DEFAULT_BOARD_LOOK]
    )
  ).rows;

export const findMemberByEmail = async (
  db: Queryable,
  email: string
): Promise<{ id: string; workspaceId: string } | null> =>
  (
    await db.query<{ id: string; workspaceId: string }>(
      'select id, workspace_id as "workspaceId" from members where lower(email) = lower($1) order by created_at limit 1',
      [email]
    )
  ).rows[0] ?? null;
