const API = 'https://api.github.com';

/** How long one call may take, body included; a hung call would otherwise hold the scheduler's pass. */
export const REQUEST_TIMEOUT_MS = 30_000;

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
    /** When a rate limit that refused this call lets calls through again (epoch ms), if it was one. */
    readonly resetAt: number | null = null
  ) {
    super(`GitHub ${status} on ${path}: ${message}`);
  }
}

/** The statuses GitHub refuses a call with when a rate limit is spent; 403 is also a missing right. */
const RATE_LIMIT_STATUSES: ReadonlySet<number> = new Set([403, 429]);

/** A header that holds a whole number of seconds, or `null` when it is missing or not one. */
const secondsIn = (headers: Headers, name: string): number | null => {
  const value = headers.get(name)?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  return Number(value);
};

/**
 * When a rate limit that refused a call lets calls through again (epoch ms), read from GitHub's
 * answer: `retry-after` (seconds from now) for a secondary limit, or `x-ratelimit-reset` (epoch
 * seconds) once `x-ratelimit-remaining` is 0 for the primary one. `null` for any other answer, a
 * 403 for a missing right included.
 */
export const rateLimitResetAt = (status: number, headers: Headers, now: number): number | null => {
  if (!RATE_LIMIT_STATUSES.has(status)) return null;
  const retryAfter = secondsIn(headers, 'retry-after');
  if (retryAfter !== null) return now + retryAfter * 1000;
  if (headers.get('x-ratelimit-remaining')?.trim() !== '0') return null;
  const reset = secondsIn(headers, 'x-ratelimit-reset');
  return reset === null ? null : reset * 1000;
};

/**
 * One call to GitHub's REST or GraphQL API with a token, as the App or as a person. An answer that
 * is not 2xx is a `GitHubError` with the start of its body, and when a rate limit refused it, the
 * time the limit resets; an empty body reads as `{}`. A call that takes longer than
 * `REQUEST_TIMEOUT_MS` is aborted and rejects with a `TimeoutError`. `now` is the caller's clock,
 * which a `retry-after` counts from.
 */
export const githubRequest = async <T>(
  http: typeof fetch,
  token: string,
  path: string,
  init: { readonly method?: string | undefined; readonly body?: unknown } = {},
  now: () => number = Date.now
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
  if (!response.ok)
    throw new GitHubError(
      response.status,
      path,
      text.slice(0, 300),
      rateLimitResetAt(response.status, response.headers, now())
    );
  return (text ? JSON.parse(text) : {}) as T;
};
