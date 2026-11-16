import {
  forgetSpentGitHubAccount,
  forgetSpentGitHubAccountIn,
  linkGitHubAccount,
  loadGitHubAccount,
  memberForGitHubUser,
  refreshingGitHubAccount,
  saveGitHubAccount,
  saveRefreshedGitHubTokens,
  type GitHubAccountRow
} from '@officina/db';
import {
  RefreshTokenRefused,
  type GitHubAsUser,
  type GitHubUserAuth,
  type UserTokens
} from '@officina/github';
import type { Pool, PoolClient } from 'pg';
import type { TokenBox } from './token-box';

/**
 * Why a GitHub sign-in or link did not complete. Only the code reaches the browser, in the sign-in
 * page's address; the board words each one (`apps/board/src/routes/signin/+page.svelte`).
 */
export type GitHubSignInProblem =
  'github_mismatch' | 'github_expired' | 'github_not_linked' | 'github_linked_elsewhere';

/** Refresh a little before GitHub would refuse the token. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** A token for acting as a member on GitHub, and the GitHub user it acts as. */
interface ActingToken {
  readonly token: string;
  readonly login: string;
  readonly userId: number;
}

/**
 * The account a spent refresh token left dead could not be forgotten either. It goes to the server
 * log, so the caller gets the refresh's own outcome.
 */
const logForgetFailure = (memberId: string) => (error: unknown) => {
  console.error(
    JSON.stringify({
      at: new Date().toISOString(),
      message: 'could not forget a GitHub account that can no longer be refreshed',
      memberId,
      error: error instanceof Error ? error.message : String(error)
    })
  );
};

/** Members' linked GitHub accounts: linking, signing in, and a fresh token when acting for them. */
export const createGitHubAccounts = (deps: {
  pool: Pool;
  box: TokenBox;
  auth: GitHubUserAuth;
  asUser: GitHubAsUser;
}) => {
  const { pool, box } = deps;

  const sealed = (
    memberId: string,
    user: { id: number; login: string },
    tokens: UserTokens
  ): GitHubAccountRow => ({
    memberId,
    githubUserId: user.id,
    login: user.login,
    accessTokenEnc: box.seal(tokens.accessToken),
    accessExpiresAt: tokens.accessExpiresAt,
    refreshTokenEnc: tokens.refreshToken ? box.seal(tokens.refreshToken) : null,
    refreshExpiresAt: tokens.refreshExpiresAt
  });

  /**
   * Completes an authorization: links the account to the signed-in member, or, for a sign-in, finds
   * the member it is already linked to. GitHub alone never creates a member: people join by invite.
   * `claim`, when given, spends the authorization's state once the code proved real and before
   * anything is stored, so two callbacks with one state never both write.
   */
  const complete = async (
    code: string,
    linkTo: string | null,
    claim?: () => Promise<boolean>
  ): Promise<
    { ok: true; memberId: string; login: string } | { ok: false; problem: GitHubSignInProblem }
  > => {
    const tokens = await deps.auth.exchangeCode(code);
    const user = await deps.asUser.user(tokens.accessToken);
    if (claim && !(await claim())) return { ok: false, problem: 'github_expired' };
    if (linkTo) {
      // An account another member holds stays theirs until they disconnect it.
      const linked = await linkGitHubAccount(pool, sealed(linkTo, user, tokens));
      if (!linked.ok) return { ok: false, problem: 'github_linked_elsewhere' };
      return { ok: true, memberId: linkTo, login: user.login };
    }
    const memberId = await memberForGitHubUser(pool, user.id);
    if (!memberId) return { ok: false, problem: 'github_not_linked' };
    // The account is already this member's own, so storing its fresh tokens cannot be refused.
    await saveGitHubAccount(pool, sealed(memberId, user, tokens));
    return { ok: true, memberId, login: user.login };
  };

  /**
   * The tokens a refresh gives, or null when GitHub refuses the refresh token: a refresh whose
   * answer was lost spent it, so the account can never act again. It is forgotten and the member
   * told to reconnect, rather than left showing as connected while every refresh fails.
   */
  const refreshed = async (
    db: PoolClient,
    account: GitHubAccountRow,
    refreshTokenEnc: string
  ): Promise<UserTokens | null> => {
    try {
      return await deps.auth.refresh(box.open(refreshTokenEnc));
    } catch (error) {
      if (!(error instanceof RefreshTokenRefused)) throw error;
      await forgetSpentGitHubAccountIn(
        db,
        account.memberId,
        refreshTokenEnc,
        'refresh_refused'
      ).catch(logForgetFailure(account.memberId));
      return null;
    }
  };

  const expired = (at: Date | null) => at !== null && at.getTime() - REFRESH_MARGIN_MS < Date.now();

  const acting = (account: GitHubAccountRow, accessToken: string): ActingToken => ({
    token: accessToken,
    login: account.login,
    userId: account.githubUserId
  });

  /** The account's own access token, while it has not expired. */
  const current = (account: GitHubAccountRow): ActingToken | null =>
    expired(account.accessExpiresAt) ? null : acting(account, box.open(account.accessTokenEnc));

  /**
   * Renews an expired token, one refresh of an account at a time: a second caller waits for the
   * first and uses what it stored, rather than presenting the refresh token the first spent and
   * having the account forgotten although the refresh worked. The new tokens are stored only over
   * the account the refresh started from, so a refresh never overwrites a newer connection: `null`
   * when the member disconnected or reconnected meanwhile. GitHub spent the old refresh token in
   * giving them, so tokens that are not stored leave the account dead: once the refresh's
   * transaction is undone it is forgotten and the member told to reconnect, and the error still
   * reaches the caller.
   */
  const renewed = async (memberId: string): Promise<ActingToken | null> => {
    // Holds the refresh token once GitHub has given new tokens for it, and so spent it.
    const spent: { refreshTokenEnc?: string } = {};
    try {
      return await refreshingGitHubAccount(pool, memberId, async (db, account) => {
        if (!account) return null;
        const renewedMeanwhile = current(account);
        if (renewedMeanwhile) return renewedMeanwhile;
        const refreshTokenEnc = account.refreshTokenEnc;
        if (!refreshTokenEnc || expired(account.refreshExpiresAt)) return null;
        const tokens = await refreshed(db, account, refreshTokenEnc);
        if (!tokens) return null;
        spent.refreshTokenEnc = refreshTokenEnc;
        const user = { id: account.githubUserId, login: account.login };
        const saved = await saveRefreshedGitHubTokens(
          db,
          sealed(memberId, user, tokens),
          refreshTokenEnc
        );
        return saved ? acting(account, tokens.accessToken) : null;
      });
    } catch (error) {
      if (spent.refreshTokenEnc) {
        await forgetSpentGitHubAccount(pool, memberId, spent.refreshTokenEnc, 'refresh_lost').catch(
          logForgetFailure(memberId)
        );
      }
      throw error;
    }
  };

  /** A usable token for acting as the member, refreshed when needed; `null` when not linked or revoked. */
  const tokenFor = async (memberId: string): Promise<ActingToken | null> => {
    const account = await loadGitHubAccount(pool, memberId);
    if (!account) return null;
    return current(account) ?? renewed(memberId);
  };

  return { complete, tokenFor };
};

export type GitHubAccounts = ReturnType<typeof createGitHubAccounts>;
