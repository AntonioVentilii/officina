import type { Pool, PoolClient } from 'pg';
import { recordAccessEvent } from './access';
import { hashToken } from './auth';
import { inTransaction } from './store';

type Queryable = Pool | PoolClient;

export const createOAuthState = async (
  db: Queryable,
  state: string,
  memberId: string,
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
): Promise<{ memberId: string } | null> => {
  const { rows } = await db.query<{ member_id: string }>(
    'delete from oauth_states where state_hash = $1 and expires_at > now() returning member_id',
    [hashToken(state)]
  );
  return rows[0] ? { memberId: rows[0].member_id } : null;
};

/** Deletes the states that expired before anyone spent them; returns how many. */
export const purgeExpiredOAuthStates = async (db: Queryable): Promise<number> =>
  (await db.query('delete from oauth_states where expires_at <= now()')).rowCount ?? 0;

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

export type SaveGitHubAccountResult =
  { readonly ok: true } | { readonly ok: false; readonly error: 'linked_elsewhere' };

/**
 * Stores a member's GitHub account, its tokens and its identity. An account linked to another
 * member stays theirs until they disconnect it, and relinking to another account drops the sign-in
 * the member's previous account gave.
 */
const writeGitHubAccount = async (
  db: PoolClient,
  account: GitHubAccountRow
): Promise<SaveGitHubAccountResult> => {
  const subject = String(account.githubUserId);
  const taken = await db.query(
    `select 1 from github_accounts where github_user_id = $1 and member_id <> $2
     union all
     select 1 from identities where provider = 'github' and subject = $3 and member_id <> $2`,
    [account.githubUserId, account.memberId, subject]
  );
  if (taken.rowCount) return { ok: false, error: 'linked_elsewhere' };
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
    "delete from identities where provider = 'github' and member_id = $1 and subject <> $2",
    [account.memberId, subject]
  );
  await db.query(
    `insert into identities (provider, subject, member_id) values ('github', $1, $2)
     on conflict (provider, subject) do nothing`,
    [subject, account.memberId]
  );
  return { ok: true };
};

/**
 * Stores the tokens a refresh gave, only over the account that refresh started from: the same
 * GitHub user, still holding the refresh token it spent. A member who disconnected or reconnected
 * while GitHub answered keeps that newer state, and `false` says the fresh tokens were not kept.
 */
export const saveRefreshedGitHubTokens = async (
  db: Queryable,
  account: GitHubAccountRow,
  spentRefreshTokenEnc: string
): Promise<boolean> =>
  (
    await db.query(
      `update github_accounts set access_token_enc = $4, access_expires_at = $5,
         refresh_token_enc = $6, refresh_expires_at = $7, updated_at = now()
       where member_id = $1 and github_user_id = $2 and refresh_token_enc = $3`,
      [
        account.memberId,
        account.githubUserId,
        spentRefreshTokenEnc,
        account.accessTokenEnc,
        account.accessExpiresAt,
        account.refreshTokenEnc,
        account.refreshExpiresAt
      ]
    )
  ).rowCount === 1;

/** Stores fresh tokens for a member's GitHub account, as a sign-in gets them. */
export const saveGitHubAccount = (
  pool: Pool,
  account: GitHubAccountRow
): Promise<SaveGitHubAccountResult> => inTransaction(pool, (db) => writeGitHubAccount(db, account));

/**
 * Links a GitHub account to a member and records it in the access log, all or nothing. An account
 * another member holds is refused, so nothing is recorded for it.
 */
export const linkGitHubAccount = (
  pool: Pool,
  account: GitHubAccountRow
): Promise<SaveGitHubAccountResult> =>
  inTransaction(pool, async (db) => {
    const saved = await writeGitHubAccount(db, account);
    if (!saved.ok) return saved;
    await recordAccessEvent(db, {
      memberId: account.memberId,
      type: 'github_linked',
      detail: { login: account.login }
    });
    return saved;
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

/**
 * Forgets a linked account whose refresh token GitHub has already spent, when the tokens it gave in
 * exchange could not be stored, and records in the access log that the member must reconnect. Only
 * the row still holding that spent token goes, so an account reconnected meanwhile stays. The GitHub
 * sign-in stays too: signing in with GitHub stores fresh tokens again.
 */
export const forgetSpentGitHubAccount = (pool: Pool, memberId: string, refreshTokenEnc: string) =>
  inTransaction(pool, async (db) => {
    const { rows } = await db.query<{ login: string }>(
      `delete from github_accounts where member_id = $1 and refresh_token_enc = $2
       returning login`,
      [memberId, refreshTokenEnc]
    );
    if (!rows[0]) return false;
    await recordAccessEvent(db, {
      memberId,
      type: 'github_unlinked',
      detail: { login: rows[0].login, reason: 'refresh_lost' }
    });
    return true;
  });

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
