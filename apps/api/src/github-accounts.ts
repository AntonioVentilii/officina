import {
  loadGitHubAccount,
  memberForGitHubUser,
  saveGitHubAccount,
  type GitHubAccountRow
} from '@officina/db';
import type { GitHubAsUser, GitHubUserAuth, UserTokens } from '@officina/github';
import type { Pool } from 'pg';
import type { TokenBox } from './token-box';

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

  const store = async (memberId: string, user: { id: number; login: string }, tokens: UserTokens) =>
    saveGitHubAccount(pool, {
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
   */
  const complete = async (
    code: string,
    linkTo: string | null
  ): Promise<{ ok: true; memberId: string; login: string } | { ok: false; why: string }> => {
    const tokens = await deps.auth.exchangeCode(code);
    const user = await deps.asUser.user(tokens.accessToken);
    const memberId = linkTo ?? (await memberForGitHubUser(pool, user.id));
    if (!memberId) {
      return {
        ok: false,
        why: `@${user.login} is not linked to a member yet: sign in with an invite link, then connect GitHub`
      };
    }
    await store(memberId, user, tokens);
    return { ok: true, memberId, login: user.login };
  };

  const expired = (at: Date | null) => at !== null && at.getTime() - REFRESH_MARGIN_MS < Date.now();

  /** A usable token for acting as the member, refreshed when needed; `null` when not linked or revoked. */
  const tokenFor = async (memberId: string): Promise<{ token: string; login: string } | null> => {
    const account: GitHubAccountRow | null = await loadGitHubAccount(pool, memberId);
    if (!account) return null;
    if (!expired(account.accessExpiresAt)) {
      return { token: box.open(account.accessTokenEnc), login: account.login };
    }
    if (!account.refreshTokenEnc || expired(account.refreshExpiresAt)) return null;
    const tokens = await deps.auth.refresh(box.open(account.refreshTokenEnc));
    await store(memberId, { id: account.githubUserId, login: account.login }, tokens);
    return { token: tokens.accessToken, login: account.login };
  };

  return { complete, tokenFor };
};

export type GitHubAccounts = ReturnType<typeof createGitHubAccounts>;
