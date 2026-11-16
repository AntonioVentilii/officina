import { describe, expect, test } from 'bun:test';
import { GitHubError } from '../src';
import { githubRequest, rateLimitResetAt } from '../src/http';

const answering = (response: () => Response): typeof fetch =>
  Object.assign(async () => response(), { preconnect: fetch.preconnect });

describe('one GitHub request', () => {
  test('a successful answer with no body reads as an empty object', async () => {
    const http = answering(() => new Response(null, { status: 204 }));
    expect(
      await githubRequest<Record<string, unknown>>(http, 'ghs_1', '/repos/o/r/pulls/1/merge', {
        method: 'PUT'
      })
    ).toEqual({});
  });

  test('a successful answer is parsed, and any other is a GitHubError with its status and path', async () => {
    expect(
      await githubRequest<Record<string, unknown>>(
        answering(() => Response.json({ id: 1 })),
        't',
        '/user'
      )
    ).toEqual({
      id: 1
    });
    const failing = githubRequest<unknown>(
      answering(() => new Response('nope', { status: 403 })),
      't',
      '/user'
    );
    await expect(failing).rejects.toBeInstanceOf(GitHubError);
    await expect(failing).rejects.toThrow('GitHub 403 on /user: nope');
  });

  test('a call a rate limit refused says when the limit resets, and a missing right does not', async () => {
    const limited = githubRequest<unknown>(
      answering(
        () =>
          new Response('API rate limit exceeded', {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' }
          })
      ),
      't',
      '/repos/o/r/pulls/1'
    );
    await expect(limited).rejects.toMatchObject({ status: 403, resetAt: 1_700_000_000_000 });
    const forbidden = githubRequest<unknown>(
      answering(
        () =>
          new Response('Resource not accessible by integration', {
            status: 403,
            headers: { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1700000000' }
          })
      ),
      't',
      '/repos/o/r/pulls/1'
    );
    await expect(forbidden).rejects.toMatchObject({ status: 403, resetAt: null });
  });

  test('every call carries a deadline, so a GitHub that never answers cannot hold the caller', async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const http = (async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return Response.json({});
    }) as unknown as typeof fetch;
    await githubRequest<unknown>(http, 't', '/user');
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });
});

describe('when a rate limit resets', () => {
  const now = 1_700_000_000_000;
  const headers = (values: Record<string, string>) => new Headers(values);

  test('a secondary limit waits the seconds of retry-after, on a 403 or a 429', () => {
    expect(rateLimitResetAt(429, headers({ 'retry-after': '60' }), now)).toBe(now + 60_000);
    expect(rateLimitResetAt(403, headers({ 'retry-after': '30' }), now)).toBe(now + 30_000);
  });

  test('a spent primary limit waits until x-ratelimit-reset', () => {
    expect(
      rateLimitResetAt(
        403,
        headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000900' }),
        now
      )
    ).toBe(1_700_000_900_000);
  });

  test('any other answer is not a rate limit', () => {
    // Calls left: a 403 for a missing right, which carries the same headers.
    expect(
      rateLimitResetAt(
        403,
        headers({ 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': '1700000900' }),
        now
      )
    ).toBeNull();
    expect(rateLimitResetAt(403, headers({}), now)).toBeNull();
    expect(rateLimitResetAt(500, headers({ 'retry-after': '60' }), now)).toBeNull();
    expect(rateLimitResetAt(429, headers({ 'retry-after': 'soon' }), now)).toBeNull();
    expect(rateLimitResetAt(403, headers({ 'x-ratelimit-remaining': '0' }), now)).toBeNull();
  });
});
