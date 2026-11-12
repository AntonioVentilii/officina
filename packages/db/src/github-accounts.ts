import type { Pool, PoolClient } from 'pg';
import { hashToken } from './auth';
import { inTransaction } from './store';

type Queryable = Pool | PoolClient;

export const createOAuthState = async (
  db: Queryable,
  state: string,
  memberId: string | null,
  ttlMs: number
) => {
  await db.query(
    `insert into oauth_states (state_hash, member_id, expires_at)
     values ($1, $2, now() + make_interval(secs => $3))`,
    [hashToken(state), memberId, ttlMs / 1000]
  );
};

/** Spends a state: it works once, before it expires. */
export const consumeOAuthState = async (
  db: Queryable,
  state: string
): Promise<{ memberId: string | null } | null> => {
  const { rows } = await db.query<{ member_id: string | null }>(
    'delete from oauth_states where state_hash = $1 and expires_at > now() returning member_id',
    [hashToken(state)]
  );
  return rows[0] ? { memberId: rows[0].member_id } : null;
};

/**
 * Spends a state that was never stored, such as a sign-in's: recorded once it is used, until it
 * expires, so the same state cannot complete a second time.
 */
export const spendOAuthState = async (
  db: Queryable,
  state: string,
  expiresAt: Date
): Promise<boolean> =>
  (
    await db.query(
      `insert into oauth_states (state_hash, member_id, expires_at) values ($1, null, $2)
       on conflict (state_hash) do nothing returning state_hash`,
      [hashToken(state), expiresAt]
    )
  ).rowCount === 1;

export interface GitHubAccountRow {
  readonly memberId: string;
  readonly githubUserId: number;
  readonly login: string;
  readonly accessTokenEnc: string;
  readonly accessExpiresAt: Date | null;
  readonly refreshTokenEnc: string | null;
  readonly refreshExpiresAt: Date | null;
}

const COLUMNS = `member_id as "memberId", github_user_id::float8 as "githubUserId", login,
  access_token_enc as "accessTokenEnc", access_expires_at as "accessExpiresAt",
  refresh_token_enc as "refreshTokenEnc", refresh_expires_at as "refreshExpiresAt"`;

/**
 * Links a GitHub account to a member: moves it from any other member, stores its tokens and its
 * identity, all or nothing.
 */
export const saveGitHubAccount = (pool: Pool, account: GitHubAccountRow) =>
  inTransaction(pool, async (db) => {
    // A GitHub account belongs to one member: linking it elsewhere moves it.
    await db.query('delete from github_accounts where github_user_id = $1 and member_id <> $2', [
      account.githubUserId,
      account.memberId
    ]);
    await db.query(
      `insert into github_accounts (member_id, github_user_id, login, access_token_enc, access_expires_at,
       refresh_token_enc, refresh_expires_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (member_id) do update set github_user_id = excluded.github_user_id,
       login = excluded.login, access_token_enc = excluded.access_token_enc,
       access_expires_at = excluded.access_expires_at, refresh_token_enc = excluded.refresh_token_enc,
       refresh_expires_at = excluded.refresh_expires_at, updated_at = now()`,
      [
        account.memberId,
        account.githubUserId,
        account.login,
        account.accessTokenEnc,
        account.accessExpiresAt,
        account.refreshTokenEnc,
        account.refreshExpiresAt
      ]
    );
    await db.query(
      `insert into identities (provider, subject, member_id) values ('github', $1, $2)
     on conflict (provider, subject) do update set member_id = excluded.member_id`,
      [String(account.githubUserId), account.memberId]
    );
  });

export const loadGitHubAccount = async (
  db: Queryable,
  memberId: string
): Promise<GitHubAccountRow | null> =>
  (
    await db.query<GitHubAccountRow>(
      `select ${COLUMNS} from github_accounts where member_id = $1`,
      [memberId]
    )
  ).rows[0] ?? null;

export const memberForGitHubUser = async (db: Queryable, githubUserId: number) =>
  (
    await db.query<{ member_id: string }>(
      "select member_id from identities where provider = 'github' and subject = $1",
      [String(githubUserId)]
    )
  ).rows[0]?.member_id ?? null;

/** Removes the linked account and the sign-in it gave, both or neither. */
export const unlinkGitHubAccount = (pool: Pool, memberId: string) =>
  inTransaction(pool, async (client) => {
    await client.query('delete from github_accounts where member_id = $1', [memberId]);
    await client.query("delete from identities where provider = 'github' and member_id = $1", [
      memberId
    ]);
  });

export const githubLoginOf = async (db: Queryable, memberId: string) =>
  (
    await db.query<{ login: string }>('select login from github_accounts where member_id = $1', [
      memberId
    ])
  ).rows[0]?.login ?? null;
