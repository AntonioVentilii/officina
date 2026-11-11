import { GitHubError } from './client';

/**
 * Acting as a person on GitHub, through the GitHub App's user authorization. Reviews and merges done
 * this way are that person's own: they count as their code-owner review, and branch rules apply to
 * them exactly as to a click in the GitHub UI.
 */

const API = 'https://api.github.com';
const WEB = 'https://github.com';

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
    const response = await http(`${WEB}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        ...params
      })
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok || typeof body.access_token !== 'string') {
      throw new GitHubError(
        response.status,
        '/login/oauth/access_token',
        String(body.error ?? 'no token')
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

  const request = async <T>(
    token: string,
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<T> => {
    const response = await http(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    });
    const text = await response.text();
    if (!response.ok) throw new GitHubError(response.status, path, text.slice(0, 300));
    return (text ? JSON.parse(text) : {}) as T;
  };

  const user = (token: string) => request<GitHubUser>(token, '/user');

  const pullRequest = (token: string, repo: string, number: number) =>
    request<{ node_id: string; state: string; merged: boolean; head: { sha: string } }>(
      token,
      `/repos/${repo}/pulls/${number}`
    );

  /** Approves exactly the given commit, so a later push is never approved by accident. */
  const approve = (token: string, repo: string, number: number, commitId: string, body: string) =>
    request(token, `/repos/${repo}/pulls/${number}/reviews`, {
      method: 'POST',
      body: { event: 'APPROVE', commit_id: commitId, body }
    });

  return { user, pullRequest, approve };
};

export type GitHubAsUser = ReturnType<typeof createGitHubAsUser>;
