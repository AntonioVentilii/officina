import { describe, expect, test } from 'bun:test';
import { GitHubError } from '../src';
import { githubRequest } from '../src/http';

const answering = (response: () => Response) => (async () => response()) as unknown as typeof fetch;

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
});
