import { describe, expect, test } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  COMPARE_FILE_LIMIT,
  GitHubError,
  createAppJwt,
  createGitHubAsUser,
  createGitHubClient
} from '../src';

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

    const readOnly = await client.installationToken(ref, { contents: 'read' });
    expect(readOnly).not.toBe(first);
    expect(calls[1]!.body).toEqual({
      repositories: ['vici-app'],
      permissions: { contents: 'read' }
    });

    nowMs = Date.parse('2026-09-16T12:56:00Z');
    expect(await client.installationToken(ref)).not.toBe(first);
    expect(calls).toHaveLength(3);
  });

  test('push facts come from the branch head and the compare, counting renames under both names and as added', async () => {
    const { fetchImpl, calls } = fakeGitHub({
      'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
      'GET /repos/ViciApp/vici-app/branches/officina%2F12-copy': () =>
        json({ commit: { sha: 'headsha' } }),
      'GET /repos/ViciApp/vici-app/compare/main...headsha': () =>
        json({
          files: [
            { filename: 'src/lib/constants/messages/en.ts', status: 'modified', changes: 4 },
            {
              filename: 'src/lib/moved.ts',
              previous_filename: 'src/satellite/moved.ts',
              status: 'renamed',
              changes: 0
            },
            { filename: 'src/lib/new.ts', status: 'added', changes: 0 },
            { filename: 'src/lib/gone.ts', status: 'removed', changes: 0 }
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
        'src/satellite/moved.ts',
        'src/lib/new.ts',
        'src/lib/gone.ts'
      ],
      addedPaths: ['src/lib/moved.ts', 'src/lib/new.ts'],
      diffLines: 4
    });
    const reads = calls.filter((call) => call.method === 'GET');
    expect(reads).toHaveLength(2);
    expect(reads.every((call) => call.authorization?.startsWith('Bearer ghs_'))).toBe(true);
  });

  test('a ref snapshot reads every page of tags', async () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => ({ ref: `refs/tags/v${i}`, object: { sha: `t${i}` } })),
      [{ ref: 'refs/tags/v100', object: { sha: 't100' } }]
    ];
    const { fetchImpl } = fakeGitHub({
      'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
      'GET /repos/ViciApp/vici-app/git/ref/heads/main': () => json({ object: { sha: 'main1' } }),
      'GET /repos/ViciApp/vici-app/git/matching-refs/tags': () => json(pages.shift() ?? [])
    });
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
    const snapshot = await client.refSnapshot({ ...ref, defaultBranch: 'main' });
    expect(snapshot.defaultHead).toBe('main1');
    expect(Object.keys(snapshot.tags)).toHaveLength(101);
    expect(snapshot.tags['v100']).toBe('t100');
  });

  test('only a pull request merged on top of the old head counts as a merge', async () => {
    const merged = [{ merged_at: '2026-11-01', merge_commit_sha: 'm1', base: { ref: 'main' } }];
    const check = async (status: string) => {
      const { fetchImpl } = fakeGitHub({
        'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
        'GET /repos/ViciApp/vici-app/compare/old...m1': () => json({ status }),
        'GET /repos/ViciApp/vici-app/commits/m1/pulls': () => json(merged)
      });
      const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
      return client.isPullRequestMerge({ ...ref, sha: 'm1', base: 'main', since: 'old' });
    };
    expect(await check('ahead')).toBe(true);
    // An older merge commit: the branch was rewritten back in history.
    expect(await check('behind')).toBe(false);
    expect(await check('diverged')).toBe(false);
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

  test('finds the installation, the default branch and file contents', async () => {
    const { fetchImpl, calls } = fakeGitHub({
      'GET /repos/ViciApp/vici-app/installation': () => json({ id: 99 }),
      'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
      'GET /repos/ViciApp/vici-app': () => json({ default_branch: 'main' }),
      'GET /repos/ViciApp/vici-app/contents/.github/officina.yml': () =>
        json({
          type: 'file',
          content: Buffer.from('version: 1\n').toString('base64'),
          encoding: 'base64',
          sha: 'blob1'
        }),
      'GET /repos/ViciApp/vici-app/contents/docs/ai/notes.md': () =>
        json([{ type: 'file', name: 'a.md', path: 'docs/ai/notes.md/a.md' }])
    });
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
    expect(await client.repoInstallationId('ViciApp/vici-app')).toBe(99);
    expect(calls[0]!.authorization).toStartWith('Bearer ey');
    expect(await client.defaultBranch(ref)).toBe('main');
    expect(await client.fileContent({ ...ref, path: '.github/officina.yml', branch: 'main' })).toBe(
      'version: 1\n'
    );
    expect(await client.fileContent({ ...ref, path: 'missing.yml', branch: 'main' })).toBeNull();
    // A directory named like a page is not the page.
    expect(
      await client.fileContent({ ...ref, path: 'docs/ai/notes.md', branch: 'main' })
    ).toBeNull();
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

describe('GitHub as a person', () => {
  test('asks Copilot to review with the person token, and a pending review is not an error', async () => {
    const path = '/repos/ViciApp/vici-app/pulls';
    const { fetchImpl, calls } = fakeGitHub({
      [`POST ${path}/1/copilot-code-review`]: () => json({ node_id: 'R_1', state: 'PENDING' }, 201),
      [`POST ${path}/2/copilot-code-review`]: () =>
        json({ message: 'A Copilot code review request is already pending' }, 409),
      [`POST ${path}/3/copilot-code-review`]: () =>
        json({ message: 'Not eligible', failure_reason: 'ACTOR_NOT_ELIGIBLE' }, 422)
    });
    const asUser = createGitHubAsUser({ fetch: fetchImpl });

    expect(await asUser.requestCopilotReview('ghu_1', 'ViciApp/vici-app', 1)).toBe('requested');
    expect(calls[0]).toEqual({
      method: 'POST',
      url: `${path}/1/copilot-code-review`,
      authorization: 'Bearer ghu_1',
      body: undefined
    });
    expect(await asUser.requestCopilotReview('ghu_1', 'ViciApp/vici-app', 2)).toBe(
      'already_pending'
    );
    const refused = asUser.requestCopilotReview('ghu_1', 'ViciApp/vici-app', 3);
    await expect(refused).rejects.toBeInstanceOf(GitHubError);
    await expect(refused).rejects.toThrow('ACTOR_NOT_ELIGIBLE');
  });
});
