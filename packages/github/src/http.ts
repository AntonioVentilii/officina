const API = 'https://api.github.com';

/** How long one call may take, body included; a hung call would otherwise hold the scheduler's pass. */
export const REQUEST_TIMEOUT_MS = 30_000;

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string
  ) {
    super(`GitHub ${status} on ${path}: ${message}`);
  }
}

/**
 * One call to GitHub's REST or GraphQL API with a token, as the App or as a person. An answer that
 * is not 2xx is a `GitHubError` with the start of its body; an empty body reads as `{}`. A call that
 * takes longer than `REQUEST_TIMEOUT_MS` is aborted and rejects with a `TimeoutError`.
 */
export const githubRequest = async <T>(
  http: typeof fetch,
  token: string,
  path: string,
  init: { readonly method?: string | undefined; readonly body?: unknown } = {}
): Promise<T> => {
  const response = await http(`${API}${path}`, {
    method: init.method ?? 'GET',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
