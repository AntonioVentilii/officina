import { GitHubError, REQUEST_TIMEOUT_MS, githubRequest } from './http';
import { mergeWhenReadyWith } from './merge';

/**
 * Acting as a person on GitHub, through the GitHub App's user authorization. Reviews and merges done
 * this way are that person's own: they count as their code-owner review, and branch rules apply to
 * them exactly as to a click in the GitHub UI.
 */

const WEB = 'https://github.com';
const TOKEN_PATH = '/login/oauth/access_token';

export interface OAuthAppOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly fetch?: typeof fetch;
}

export interface UserTokens {
  readonly accessToken: string;
  readonly accessExpiresAt: Date | null;
  readonly refreshToken: string | null;
  readonly refreshExpiresAt: Date | null;
}

export interface GitHubUser {
  readonly id: number;
  readonly login: string;
}

/** The JSON object a text holds, or `undefined` when it holds anything else. */
const jsonObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const expiry = (seconds: unknown, now: number) =>
  typeof seconds === 'number' && seconds > 0 ? new Date(now + seconds * 1000) : null;

export const createGitHubUserAuth = (options: OAuthAppOptions) => {
  const http = options.fetch ?? fetch;

  const authorizeUrl = (state: string) =>
    `${WEB}/login/oauth/authorize?${new URLSearchParams({
      client_id: options.clientId,
      redirect_uri: options.redirectUri,
      state,
      allow_signup: 'false'
    })}`;

  const tokenRequest = async (params: Record<string, string>): Promise<UserTokens> => {
    const response = await http(`${WEB}${TOKEN_PATH}`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        ...params
      })
    });
    // An outage answers with an HTML page, so the body is parsed only after it is read whole.
    const text = await response.text();
    const body = jsonObject(text);
    if (!response.ok || typeof body?.access_token !== 'string') {
      throw new GitHubError(
        response.status,
        TOKEN_PATH,
        body ? String(body.error ?? 'no token') : 'not JSON'
      );
    }
    const now = Date.now();
    return {
      accessToken: body.access_token,
      accessExpiresAt: expiry(body.expires_in, now),
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      refreshExpiresAt: expiry(body.refresh_token_expires_in, now)
    };
  };

  return {
    authorizeUrl,
    exchangeCode: (code: string) => tokenRequest({ code, redirect_uri: options.redirectUri }),
    refresh: (refreshToken: string) =>
      tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
  };
};

export type GitHubUserAuth = ReturnType<typeof createGitHubUserAuth>;

/** Calls GitHub with a person's token. */
export const createGitHubAsUser = (options: { fetch?: typeof fetch } = {}) => {
  const http = options.fetch ?? fetch;

  const request = <T>(
    token: string,
    path: string,
    init: { method?: string; body?: unknown } = {}
  ) => githubRequest<T>(http, token, path, init);

  const user = (token: string) => request<GitHubUser>(token, '/user');

  const pullRequest = (token: string, repo: string, number: number) =>
    request<{ node_id: string; state: string; merged: boolean; head: { sha: string } }>(
      token,
      `/repos/${repo}/pulls/${number}`
    );

  /**
   * Every review left on the pull request, oldest first, page by page: who (by GitHub's stable
   * user id, since a login can be renamed), how and at which commit.
   */
  const reviews = async (token: string, repo: string, number: number) => {
    const all: { userId: number; login: string; state: string; commitId: string | null }[] = [];
    for (let page = 1; ; page++) {
      const batch = await request<
        { user: { id: number; login: string } | null; state: string; commit_id: string | null }[]
      >(token, `/repos/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`);
      for (const review of batch) {
        if (review.user)
          all.push({
            userId: review.user.id,
            login: review.user.login,
            state: review.state,
            commitId: review.commit_id
          });
      }
      if (batch.length < 100) return all;
    }
  };

  /** Approves exactly the given commit, so a later push is never approved by accident. */
  const approve = (token: string, repo: string, number: number, commitId: string, body: string) =>
    request(token, `/repos/${repo}/pulls/${number}/reviews`, {
      method: 'POST',
      body: { event: 'APPROVE', commit_id: commitId, body }
    });

  /** Turns on auto-merge as the person they verified it as (see `mergeWhenReadyWith`). */
  const mergeWhenReady = async (
    token: string,
    repo: string,
    number: number,
    expectedHead: string
  ): Promise<'auto_merge' | 'merged'> =>
    mergeWhenReadyWith(
      {
        graphql: (query, variables) =>
          request<{ errors?: { message: string }[] }>(token, '/graphql', {
            method: 'POST',
            body: { query, variables }
          }),
        merge: (body) =>
          request(token, `/repos/${repo}/pulls/${number}/merge`, { method: 'PUT', body })
      },
      (await pullRequest(token, repo, number)).node_id,
      expectedHead
    );

  /**
   * Asks Copilot to review the pull request as the person, so it is billed to their Copilot seat.
   * GitHub refuses (422, with a `failure_reason`) when the person has no seat or quota left, and
   * answers 409 when a Copilot review is already pending, which is the outcome asked for.
   */
  const requestCopilotReview = async (
    token: string,
    repo: string,
    number: number
  ): Promise<'requested' | 'already_pending'> => {
    try {
      await request(token, `/repos/${repo}/pulls/${number}/copilot-code-review`, {
        method: 'POST'
      });
      return 'requested';
    } catch (error) {
      if (error instanceof GitHubError && error.status === 409) return 'already_pending';
      throw error;
    }
  };

  return { user, pullRequest, reviews, approve, mergeWhenReady, requestCopilotReview };
};

export type GitHubAsUser = ReturnType<typeof createGitHubAsUser>;
