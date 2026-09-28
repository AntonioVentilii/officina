import { createHash, randomBytes } from 'node:crypto';
import type { Role } from '@officina/core';
import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

const newToken = () => randomBytes(32).toString('base64url');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

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

/** Spends a sign-in link and opens a session. A link works once, and only before it expires. */
export const redeemLoginLink = async (
  db: Queryable,
  token: string
): Promise<{ sessionToken: string; memberId: string } | null> => {
  const { rows } = await db.query<{ member_id: string }>(
    `update login_links set used_at = now()
     where token_hash = $1 and used_at is null and expires_at > now()
     returning member_id`,
    [hashToken(token)]
  );
  const memberId = rows[0]?.member_id;
  if (!memberId) return null;
  return { sessionToken: await createSession(db, memberId), memberId };
};

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

export const endSession = async (db: Queryable, sessionToken: string) => {
  await db.query('delete from sessions where token_hash = $1', [hashToken(sessionToken)]);
};

export interface MemberProject {
  readonly id: string;
  readonly name: string;
  readonly repo: string;
  readonly role: Role;
  readonly domains: readonly string[];
}

export const listMemberProjects = async (
  db: Queryable,
  memberId: string
): Promise<MemberProject[]> =>
  (
    await db.query<MemberProject>(
      `select p.id, p.name, p.github_repo as repo, r.role, r.domains
       from project_roles r join projects p on p.id = r.project_id
       where r.member_id = $1 order by p.name`,
      [memberId]
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
