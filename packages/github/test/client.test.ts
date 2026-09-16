import { describe, expect, test } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { COMPARE_FILE_LIMIT, GitHubError, createAppJwt, createGitHubClient } from '../src';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

interface Call {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/** A fetch stand-in that answers by `METHOD path` and records every request. */
const fakeGitHub = (routes: Record<string, () => Response>) => {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      url: url.pathname,
      authorization: headers.get('authorization'),
      body: init?.body ? JSON.parse(init.body as string) : undefined
    });
    const route = routes[`${method} ${url.pathname}`];
    return route ? route() : new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

const tokenRoute = (expiresAt: string) => () =>
  json({ token: `ghs_${Math.random()}`, expires_at: expiresAt }, 201);

describe('app JWT', () => {
  test('is signed with the app key and carries a short, backdated lifetime', () => {
    const jwt = createAppJwt('4965437', privateKeyPem, 1_000_000);
    const [header, payload, signature] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT'
    });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
      iat: 999_940,
      exp: 1_000_540,
      iss: '4965437'
    });
    const valid = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, signature, 'base64url');
    expect(valid).toBe(true);
  });
});

describe('GitHub client', () => {
  const ref = { installationId: 99, repo: 'ViciApp/vici-app' };

  test('scopes installation tokens to one repository and reuses them until near expiry', async () => {
    let nowMs = Date.parse('2026-09-16T12:00:00Z');
    const { fetchImpl, calls } = fakeGitHub({
      'POST /app/installations/99/access_tokens': tokenRoute('2026-09-16T13:00:00Z')
    });
    const client = createGitHubClient({
      appId: '1',
      privateKeyPem,
      fetch: fetchImpl,
      now: () => nowMs
    });

    const first = await client.installationToken(ref);
    expect(await client.installationToken(ref)).toBe(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ repositories: ['vici-app'] });
    expect(calls[0]!.authorization).toStartWith('Bearer ey');

    nowMs = Date.parse('2026-09-16T12:56:00Z');
    expect(await client.installationToken(ref)).not.toBe(first);
    expect(calls).toHaveLength(2);
  });

  test('push facts come from the branch head and the compare, counting renames under both names', async () => {
    const { fetchImpl, calls } = fakeGitHub({
      'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
      'GET /repos/ViciApp/vici-app/branches/officina%2F12-copy': () =>
        json({ commit: { sha: 'headsha' } }),
      'GET /repos/ViciApp/vici-app/compare/main...headsha': () =>
        json({
          files: [
            { filename: 'src/lib/constants/messages/en.ts', changes: 4 },
            {
              filename: 'src/lib/moved.ts',
              previous_filename: 'src/satellite/moved.ts',
              changes: 0
            }
          ]
        })
    });
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
    const facts = await client.pushFacts({ ...ref, base: 'main', branch: 'officina/12-copy' });
    expect(facts).toEqual({
      headSha: 'headsha',
      changedPaths: [
        'src/lib/constants/messages/en.ts',
        'src/lib/moved.ts',
        'src/satellite/moved.ts'
      ],
      diffLines: 4
    });
    const reads = calls.filter((call) => call.method === 'GET');
    expect(reads).toHaveLength(2);
    expect(reads.every((call) => call.authorization?.startsWith('Bearer ghs_'))).toBe(true);
  });

  test('a possibly truncated file list reports an unbounded diff', async () => {
    const files = Array.from({ length: COMPARE_FILE_LIMIT }, (_, index) => ({
      filename: `src/file${index}.ts`,
      changes: 1
    }));
    const { fetchImpl } = fakeGitHub({
      'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
      'GET /repos/ViciApp/vici-app/branches/officina%2Fbig': () => json({ commit: { sha: 'h' } }),
      'GET /repos/ViciApp/vici-app/compare/main...h': () => json({ files })
    });
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
    const facts = await client.pushFacts({ ...ref, base: 'main', branch: 'officina/big' });
    expect(facts.diffLines).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('opens pull requests and surfaces GitHub errors with status and path', async () => {
    const { fetchImpl, calls } = fakeGitHub({
      'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
      'POST /repos/ViciApp/vici-app/pulls': () =>
        json({ number: 5, html_url: 'https://github.com/ViciApp/vici-app/pull/5' }, 201),
      'POST /repos/ViciApp/vici-app/issues/3/comments': () => json({ message: 'nope' }, 403)
    });
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
    expect(
      await client.openPullRequest({
        ...ref,
        base: 'main',
        branch: 'officina/12-copy',
        title: 'fix: copy',
        body: 'Closes #3'
      })
    ).toEqual({ number: 5, url: 'https://github.com/ViciApp/vici-app/pull/5' });
    expect(calls.at(-1)!.body).toEqual({
      base: 'main',
      head: 'officina/12-copy',
      title: 'fix: copy',
      body: 'Closes #3'
    });

    const failure = client.commentOnIssue({ ...ref, issueNumber: 3, body: 'hi' });
    await expect(failure).rejects.toBeInstanceOf(GitHubError);
    await expect(failure).rejects.toThrow('GitHub 403');
  });
});
