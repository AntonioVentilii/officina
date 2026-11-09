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

export interface RefSnapshot {
  readonly defaultHead: string;
  /** Tag name to the sha it points at. */
  readonly tags: Readonly<Record<string, string>>;
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

  /**
   * The refs a builder's token could rewrite outside its own branch: the default branch head and
   * every tag. Taken before and after a build run, so a push anywhere else is caught.
   */
  const refSnapshot = async (
    ref: RepoRef & { readonly defaultBranch: string }
  ): Promise<RefSnapshot> => {
    const token = await installationToken(ref, { contents: 'read' });
    const head = await request<{ object: { sha: string } }>(
      `/repos/${ref.repo}/git/ref/heads/${encodeURIComponent(ref.defaultBranch)}`,
      { token }
    );
    const tags: { ref: string; object: { sha: string } }[] = [];
    // Every page: a tag on a page left unread could be rewritten unseen.
    for (let page = 1; ; page++) {
      const batch = await request<typeof tags>(
        `/repos/${ref.repo}/git/matching-refs/tags?per_page=100&page=${page}`,
        { token }
      );
      tags.push(...batch);
      if (batch.length < 100) break;
    }
    return {
      defaultHead: head.object.sha,
      tags: Object.fromEntries(
        tags.map((tag) => [tag.ref.replace(/^refs\/tags\//, ''), tag.object.sha])
      )
    };
  };

  /**
   * Whether `base` moving from `since` to `sha` is a pull request merged on top of it. Such a move
   * went through the branch rules, unlike a push made with a builder's token. The new head must
   * descend from the old one: an older merge commit would be a rewrite back in history.
   */
  const isPullRequestMerge = async (
    ref: RepoRef & { readonly sha: string; readonly base: string; readonly since: string }
  ): Promise<boolean> => {
    const token = await installationToken(ref, { contents: 'read', pull_requests: 'read' });
    const comparison = await request<{ status: string }>(
      `/repos/${ref.repo}/compare/${ref.since}...${ref.sha}`,
      { token }
    );
    if (comparison.status !== 'ahead') return false;
    const pulls = await request<
      { merged_at: string | null; merge_commit_sha: string | null; base: { ref: string } }[]
    >(`/repos/${ref.repo}/commits/${ref.sha}/pulls`, { token });
    return pulls.some(
      (pull) =>
        pull.merged_at !== null && pull.merge_commit_sha === ref.sha && pull.base.ref === ref.base
    );
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

  /**
   * A file's text and blob sha at a branch, or `null` when no file exists there. A directory (or a
   * symlink or submodule) at that path is not a file, so it reads as missing instead of failing.
   */
  const readFile = async (
    ref: RepoRef & { readonly path: string; readonly branch: string }
  ): Promise<{ text: string; sha: string } | null> => {
    const token = await installationToken(ref, { contents: 'read' });
    try {
      const file = await request<
        { type?: string; content: string; encoding: string; sha: string } | unknown[]
      >(`${contentsPath(ref.repo, ref.path)}?ref=${encodeURIComponent(ref.branch)}`, { token });
      if (Array.isArray(file) || file.type !== 'file') return null;
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

  /** Commits a new version of one file to a branch; `sha` is the blob being replaced, absent for a new file. */
  const updateFile = async (
    ref: RepoRef & {
      readonly path: string;
      readonly branch: string;
      readonly text: string;
      readonly sha?: string | undefined;
      readonly message: string;
    }
  ): Promise<{ commitSha: string | null; parentSha: string | null }> => {
    const token = await installationToken(ref, { contents: 'write' });
    const written = await request<{
      commit?: { sha?: string; parents?: { sha: string }[] };
    }>(contentsPath(ref.repo, ref.path), {
      method: 'PUT',
      token,
      body: {
        message: ref.message,
        content: Buffer.from(ref.text, 'utf8').toString('base64'),
        sha: ref.sha,
        branch: ref.branch
      }
    });
    return {
      commitSha: written.commit?.sha ?? null,
      parentSha: written.commit?.parents?.[0]?.sha ?? null
    };
  };

  /** A file's text at a branch, or `null` when no file exists there. */
  const fileContent = async (
    ref: RepoRef & { readonly path: string; readonly branch: string }
  ): Promise<string | null> => (await readFile(ref))?.text ?? null;

  /** Creates a branch pointing at the current head of another one. */
  const createBranch = async (
    ref: RepoRef & { readonly branch: string; readonly from: string }
  ): Promise<void> => {
    const token = await installationToken(ref, { contents: 'write' });
    const head = await request<{ object: { sha: string } }>(
      `/repos/${ref.repo}/git/ref/heads/${encodeURIComponent(ref.from)}`,
      { token }
    );
    await request(`/repos/${ref.repo}/git/refs`, {
      method: 'POST',
      token,
      body: { ref: `refs/heads/${ref.branch}`, sha: head.object.sha }
    });
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

  /** Inline comments of one review, as `path:line` and text, so the builder can find each one. */
  const reviewComments = async (
    ref: RepoRef & { readonly pullRequest: number; readonly reviewId: number }
  ): Promise<{ path: string; line: number | null; body: string }[]> => {
    const token = await installationToken(ref, { pull_requests: 'read' });
    const comments: {
      path: string;
      line: number | null;
      original_line: number | null;
      body: string;
    }[] = [];
    // Every page: a fix round that misses some of the comments would only be sent back again.
    for (let page = 1; ; page++) {
      const batch = await request<typeof comments>(
        `/repos/${ref.repo}/pulls/${ref.pullRequest}/reviews/${ref.reviewId}/comments?per_page=100&page=${page}`,
        { token }
      );
      comments.push(...batch);
      if (batch.length < 100) break;
    }
    return comments.map((comment) => ({
      path: comment.path,
      line: comment.line ?? comment.original_line,
      body: comment.body
    }));
  };

  const graphql = async <T>(ref: RepoRef, query: string, variables: Record<string, unknown>) => {
    const token = await installationToken(ref);
    const response = await request<{ data?: T; errors?: { message: string }[] }>('/graphql', {
      method: 'POST',
      token,
      body: { query, variables }
    });
    return response;
  };

  const pullRequestNode = (ref: RepoRef & { readonly pullRequest: number }) =>
    installationToken(ref).then((token) =>
      request<{ node_id: string; head: { sha: string } }>(
        `/repos/${ref.repo}/pulls/${ref.pullRequest}`,
        { token }
      )
    );

  /**
   * Turns on auto-merge as the app, for a result that needed no person's check, so the branch
   * rules (checks, resolved threads, any required review) still decide when it lands. A pull request
   * that already meets them cannot take auto-merge and is merged straight away. Both are pinned to
   * `expectedHead`, so a commit pushed after the result was accepted is never merged with it.
   */
  const mergeWhenReady = async (
    ref: RepoRef & { readonly pullRequest: number; readonly expectedHead: string }
  ): Promise<'auto_merge' | 'merged'> => {
    const pr = await pullRequestNode(ref);
    const response = await graphql(
      ref,
      'mutation($id: ID!, $head: GitObjectID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $head }) { clientMutationId } }',
      { id: pr.node_id, head: ref.expectedHead }
    );
    if (!response.errors?.length) return 'auto_merge';
    const message = response.errors.map((error) => error.message).join('; ');
    if (!/clean status|is in clean/i.test(message)) {
      throw new GitHubError(422, '/graphql enablePullRequestAutoMerge', message);
    }
    const token = await installationToken(ref);
    await request(`/repos/${ref.repo}/pulls/${ref.pullRequest}/merge`, {
      method: 'PUT',
      token,
      body: { merge_method: 'squash', sha: ref.expectedHead }
    });
    return 'merged';
  };

  /** Turns auto-merge off, so work sent back to building cannot land before it is checked again. */
  const cancelAutoMerge = async (ref: RepoRef & { readonly pullRequest: number }) => {
    const pr = await pullRequestNode(ref);
    const response = await graphql(
      ref,
      'mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }',
      { id: pr.node_id }
    );
    const message = response.errors?.map((error) => error.message).join('; ') ?? '';
    // Auto-merge already off is the outcome wanted; anything else must be retried.
    if (message && !/not in auto.?merge|auto.?merge is not enabled|is not enabled/i.test(message)) {
      throw new GitHubError(422, '/graphql disablePullRequestAutoMerge', message);
    }
  };

  /**
   * Resolves the open threads started by the given reviews. Officina calls it once the fixes for
   * those reviews were reviewed again and verified, since the repository only merges with every
   * thread resolved.
   */
  const resolveReviewThreads = async (
    ref: RepoRef & { readonly pullRequest: number; readonly reviewIds: readonly number[] }
  ): Promise<number> => {
    const [owner, name] = ref.repo.split('/');
    const response = await graphql<{
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: {
              id: string;
              isResolved: boolean;
              comments: { nodes: { pullRequestReview: { databaseId: number } | null }[] };
            }[];
          };
        };
      };
    }>(
      ref,
      'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 1) { nodes { pullRequestReview { databaseId } } } } } } } }',
      { owner, name, number: ref.pullRequest }
    );
    if (response.errors?.length) {
      throw new GitHubError(422, '/graphql reviewThreads', response.errors[0]!.message);
    }
    const threads = response.data?.repository.pullRequest.reviewThreads.nodes ?? [];
    const open = threads.filter((thread) => {
      const reviewId = thread.comments.nodes[0]?.pullRequestReview?.databaseId;
      return !thread.isResolved && reviewId !== undefined && ref.reviewIds.includes(reviewId);
    });
    for (const thread of open) {
      const resolved = await graphql(
        ref,
        'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { clientMutationId } }',
        { id: thread.id }
      );
      if (resolved.errors?.length) {
        throw new GitHubError(422, '/graphql resolveReviewThread', resolved.errors[0]!.message);
      }
    }
    return open.length;
  };

  return {
    installationToken,
    repoInstallationId,
    defaultBranch,
    fileContent,
    readFile,
    updateFile,
    createBranch,
    pushFacts,
    refSnapshot,
    isPullRequestMerge,
    openPullRequest,
    commentOnIssue,
    reviewComments,
    mergeWhenReady,
    cancelAutoMerge,
    resolveReviewThreads
  };
};

export type GitHubClient = ReturnType<typeof createGitHubClient>;
