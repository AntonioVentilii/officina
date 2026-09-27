import { createSign } from 'node:crypto';
import type { PushFacts } from '@officina/core';

const API = 'https://api.github.com';

/** GitHub's compare endpoint lists at most this many files; a full page means the list may be cut. */
export const COMPARE_FILE_LIMIT = 300;

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string
  ) {
    super(`GitHub ${status} on ${path}: ${message}`);
  }
}

const base64url = (input: string | Buffer): string => Buffer.from(input).toString('base64url');

/** A short-lived JWT that authenticates as the GitHub App itself. */
export const createAppJwt = (appId: string, privateKeyPem: string, nowSeconds: number): string => {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // Backdated a minute to tolerate clock drift; GitHub rejects lifetimes over ten minutes.
  const payload = base64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId })
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKeyPem, 'base64url');
  return `${header}.${payload}.${signature}`;
};

export interface GitHubClientOptions {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** Repository permissions requested for an installation token, never more than the app was granted. */
export type TokenPermissions = Readonly<
  Partial<Record<'contents' | 'pull_requests' | 'issues', 'read' | 'write'>>
>;

export interface RepoRef {
  readonly installationId: number;
  /** `owner/name` */
  readonly repo: string;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export const createGitHubClient = (options: GitHubClientOptions) => {
  const http = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const tokens = new Map<string, CachedToken>();

  const request = async <T>(
    path: string,
    init: { method?: string; token: string; body?: unknown }
  ): Promise<T> => {
    const response = await http(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${init.token}`,
        'x-github-api-version': '2022-11-28',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
    });
    if (!response.ok) {
      const text = await response.text();
      throw new GitHubError(response.status, path, text.slice(0, 300));
    }
    return (await response.json()) as T;
  };

  /**
   * Installation tokens are scoped to the one repository being worked on, not everything the
   * app is installed on, optionally narrowed to specific permissions (an agent that only reads gets
   * a token that cannot push), and reused until shortly before they expire.
   */
  const installationToken = async (
    { installationId, repo }: RepoRef,
    permissions?: TokenPermissions
  ): Promise<string> => {
    const key = `${installationId}:${repo}:${JSON.stringify(permissions ?? {})}`;
    const cached = tokens.get(key);
    if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > now()) return cached.token;

    const jwt = createAppJwt(options.appId, options.privateKeyPem, Math.floor(now() / 1000));
    const repoName = repo.split('/')[1];
    const created = await request<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        token: jwt,
        body: permissions ? { repositories: [repoName], permissions } : { repositories: [repoName] }
      }
    );
    tokens.set(key, { token: created.token, expiresAtMs: Date.parse(created.expires_at) });
    return created.token;
  };

  /**
   * Reads what a branch really changed relative to its base. Renamed files count under both names,
   * so moving a protected file out of its folder still touches the protected path. If GitHub may
   * have cut the file list, the diff size is reported as unbounded so size guardrails trip.
   */
  const pushFacts = async (
    ref: RepoRef & { readonly base: string; readonly branch: string }
  ): Promise<PushFacts> => {
    const token = await installationToken(ref);
    const branch = await request<{ commit: { sha: string } }>(
      `/repos/${ref.repo}/branches/${encodeURIComponent(ref.branch)}`,
      { token }
    );
    const headSha = branch.commit.sha;
    const comparison = await request<{
      files?: { filename: string; previous_filename?: string; changes: number }[];
    }>(`/repos/${ref.repo}/compare/${encodeURIComponent(ref.base)}...${headSha}`, { token });

    const files = comparison.files ?? [];
    const changedPaths = [
      ...new Set(files.flatMap((file) => [file.filename, file.previous_filename ?? []].flat()))
    ];
    const truncated = comparison.files === undefined || files.length >= COMPARE_FILE_LIMIT;
    const diffLines = truncated
      ? Number.MAX_SAFE_INTEGER
      : files.reduce((total, file) => total + file.changes, 0);
    return { headSha, changedPaths, diffLines };
  };

  /** The installation of this app on a repository, authenticated as the app itself. */
  const repoInstallationId = async (repo: string): Promise<number> => {
    const jwt = createAppJwt(options.appId, options.privateKeyPem, Math.floor(now() / 1000));
    const installation = await request<{ id: number }>(`/repos/${repo}/installation`, {
      token: jwt
    });
    return installation.id;
  };

  const defaultBranch = async (ref: RepoRef): Promise<string> => {
    const token = await installationToken(ref, { contents: 'read' });
    return (await request<{ default_branch: string }>(`/repos/${ref.repo}`, { token }))
      .default_branch;
  };

  const contentsPath = (repo: string, path: string) =>
    `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

  /** A file's text and blob sha at a branch, or `null` when it does not exist there. */
  const readFile = async (
    ref: RepoRef & { readonly path: string; readonly branch: string }
  ): Promise<{ text: string; sha: string } | null> => {
    const token = await installationToken(ref, { contents: 'read' });
    try {
      const file = await request<{ content: string; encoding: string; sha: string }>(
        `${contentsPath(ref.repo, ref.path)}?ref=${encodeURIComponent(ref.branch)}`,
        { token }
      );
      return {
        text: Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8').toString(
          'utf8'
        ),
        sha: file.sha
      };
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  };

  /** Commits a new version of one file to a branch; `sha` is the blob being replaced. */
  const updateFile = async (
    ref: RepoRef & {
      readonly path: string;
      readonly branch: string;
      readonly text: string;
      readonly sha: string;
      readonly message: string;
    }
  ): Promise<void> => {
    const token = await installationToken(ref, { contents: 'write' });
    await request(contentsPath(ref.repo, ref.path), {
      method: 'PUT',
      token,
      body: {
        message: ref.message,
        content: Buffer.from(ref.text, 'utf8').toString('base64'),
        sha: ref.sha,
        branch: ref.branch
      }
    });
  };

  /** A file's text at a branch, or `null` when it does not exist there. */
  const fileContent = async (
    ref: RepoRef & { readonly path: string; readonly branch: string }
  ): Promise<string | null> => {
    const token = await installationToken(ref, { contents: 'read' });
    try {
      const file = await request<{ content: string; encoding: string }>(
        `/repos/${ref.repo}/contents/${ref.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref.branch)}`,
        { token }
      );
      return Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8').toString(
        'utf8'
      );
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  };

  const openPullRequest = async (
    ref: RepoRef & {
      readonly base: string;
      readonly branch: string;
      readonly title: string;
      readonly body: string;
    }
  ): Promise<{ number: number; url: string }> => {
    const token = await installationToken(ref);
    const created = await request<{ number: number; html_url: string }>(
      `/repos/${ref.repo}/pulls`,
      {
        method: 'POST',
        token,
        body: { base: ref.base, head: ref.branch, title: ref.title, body: ref.body }
      }
    );
    return { number: created.number, url: created.html_url };
  };

  const commentOnIssue = async (
    ref: RepoRef & { readonly issueNumber: number; readonly body: string }
  ): Promise<void> => {
    const token = await installationToken(ref);
    await request(`/repos/${ref.repo}/issues/${ref.issueNumber}/comments`, {
      method: 'POST',
      token,
      body: { body: ref.body }
    });
  };

  return {
    installationToken,
    repoInstallationId,
    defaultBranch,
    fileContent,
    readFile,
    updateFile,
    pushFacts,
    openPullRequest,
    commentOnIssue
  };
};

export type GitHubClient = ReturnType<typeof createGitHubClient>;
