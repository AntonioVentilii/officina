import {
  forgetSpentGitHubAccount,
  linkGitHubAccount,
  loadGitHubAccount,
  memberForGitHubUser,
  saveGitHubAccount,
  type GitHubAccountRow
} from '@officina/db';
import type { GitHubAsUser, GitHubUserAuth, UserTokens } from '@officina/github';
import type { Pool } from 'pg';
import type { TokenBox } from './token-box';

/**
 * Why a GitHub sign-in or link did not complete. Only the code reaches the browser, in the sign-in
 * page's address; the board words each one (`apps/board/src/routes/signin/+page.svelte`).
 */
export type GitHubSignInProblem =
  'github_mismatch' | 'github_expired' | 'github_not_linked' | 'github_linked_elsewhere';

/** Refresh a little before GitHub would refuse the token. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

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
   * Stores the tokens a refresh gave. GitHub spent the old refresh token in giving them, so tokens
   * that cannot be stored leave the account dead: it is forgotten and the member told to reconnect.
   */
  const keepRefreshed = async (
    account: GitHubAccountRow,
    spentRefreshEnc: string,
    tokens: UserTokens
  ): Promise<boolean> => {
    const user = { id: account.githubUserId, login: account.login };
    let kept = false;
    try {
      kept = (await saveGitHubAccount(pool, sealed(account.memberId, user, tokens))).ok;
    } finally {
      if (!kept) await forgetSpentGitHubAccount(pool, account.memberId, spentRefreshEnc);
    }
    return kept;
  };

  const expired = (at: Date | null) => at !== null && at.getTime() - REFRESH_MARGIN_MS < Date.now();

  /** A usable token for acting as the member, refreshed when needed; `null` when not linked or revoked. */
  const tokenFor = async (
    memberId: string
  ): Promise<{ token: string; login: string; userId: number } | null> => {
    const account: GitHubAccountRow | null = await loadGitHubAccount(pool, memberId);
    if (!account) return null;
    if (!expired(account.accessExpiresAt)) {
      return {
        token: box.open(account.accessTokenEnc),
        login: account.login,
        userId: account.githubUserId
      };
    }
    if (!account.refreshTokenEnc || expired(account.refreshExpiresAt)) return null;
    const tokens = await deps.auth.refresh(box.open(account.refreshTokenEnc));
    if (!(await keepRefreshed(account, account.refreshTokenEnc, tokens))) return null;
    return { token: tokens.accessToken, login: account.login, userId: account.githubUserId };
  };

  return { complete, tokenFor };
};

export type GitHubAccounts = ReturnType<typeof createGitHubAccounts>;
