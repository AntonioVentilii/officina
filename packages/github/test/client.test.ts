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
  query: string;
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
      query: url.search,
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

  test("a commit's parents and the paths it changes, a rename under both names", async () => {
    const { fetchImpl } = fakeGitHub({
      'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
      'GET /repos/ViciApp/vici-app/commits/s1': () =>
        json({
          parents: [{ sha: 'h1' }],
          files: [
            { filename: 'docs/specs/a.md', status: 'modified' },
            { filename: 'src/b.ts', previous_filename: 'src/a.ts', status: 'renamed' }
          ]
        })
    });
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
    expect(await client.commitChanges({ ...ref, sha: 's1' })).toEqual({
      parents: ['h1'],
      paths: ['docs/specs/a.md', 'src/b.ts', 'src/a.ts']
    });
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

  test('opening a pull request again returns the one the first attempt opened', async () => {
    const opened: { number: number; html_url: string }[] = [];
    const { fetchImpl, calls } = fakeGitHub({
      'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
      'POST /repos/ViciApp/vici-app/pulls': () => {
        if (opened.length)
          return json(
            { message: 'A pull request already exists for ViciApp:officina/12-copy.' },
            422
          );
        opened.push({ number: 5, html_url: 'https://github.com/ViciApp/vici-app/pull/5' });
        return json(opened[0], 201);
      },
      'GET /repos/ViciApp/vici-app/pulls': () => json(opened)
    });
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
    const input = { ...ref, base: 'main', branch: 'officina/12-copy', title: 't', body: 'b' };
    const first = await client.openPullRequest(input);
    expect(await client.openPullRequest(input)).toEqual(first);
    expect(opened).toHaveLength(1);
    expect(new URLSearchParams(calls.at(-1)!.query).get('head')).toBe('ViciApp:officina/12-copy');
  });

  test('a refused pull request with none open from its branch is still an error', async () => {
    const { fetchImpl } = fakeGitHub({
      'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
      'POST /repos/ViciApp/vici-app/pulls': () => json({ message: 'No commits between' }, 422),
      'GET /repos/ViciApp/vici-app/pulls': () => json([])
    });
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
    const opening = client.openPullRequest({
      ...ref,
      base: 'main',
      branch: 'b',
      title: 't',
      body: 'b'
    });
    await expect(opening).rejects.toThrow('GitHub 422');
  });

  test('closes every pull request still open from a branch, and none open is not an error', async () => {
    let open = [
      { number: 7, html_url: 'https://github.com/ViciApp/vici-app/pull/7' },
      { number: 9, html_url: 'https://github.com/ViciApp/vici-app/pull/9' }
    ];
    const { fetchImpl, calls } = fakeGitHub({
      'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
      'GET /repos/ViciApp/vici-app/pulls': () => json(open),
      'PATCH /repos/ViciApp/vici-app/pulls/7': () => json({}),
      'PATCH /repos/ViciApp/vici-app/pulls/9': () => json({})
    });
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
    await client.closePullRequestsFrom({ ...ref, branch: 'officina/learning-1' });
    const listed = new URLSearchParams(calls[1]!.query);
    expect(listed.get('head')).toBe('ViciApp:officina/learning-1');
    expect(listed.get('state')).toBe('open');
    const closed = calls.filter((call) => call.method === 'PATCH');
    expect(closed.map((call) => [call.url, call.body])).toEqual([
      ['/repos/ViciApp/vici-app/pulls/7', { state: 'closed' }],
      ['/repos/ViciApp/vici-app/pulls/9', { state: 'closed' }]
    ]);

    open = [];
    await client.closePullRequestsFrom({ ...ref, branch: 'officina/learning-1' });
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
  });

  test('closes the pull requests on every page, reading them all before closing any', async () => {
    const pulls = Array.from({ length: 101 }, (_, index) => ({
      number: index + 1,
      html_url: `https://github.com/ViciApp/vici-app/pull/${index + 1}`
    }));
    const routes: Record<string, () => Response> = {
      'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
      'GET /repos/ViciApp/vici-app/pulls': () => {
        const query = new URLSearchParams(calls.at(-1)!.query);
        const page = Number(query.get('page'));
        expect(query.get('per_page')).toBe('100');
        return json(pulls.slice((page - 1) * 100, page * 100));
      }
    };
    for (const pull of pulls)
      routes[`PATCH /repos/ViciApp/vici-app/pulls/${pull.number}`] = () => json({});
    const { fetchImpl, calls } = fakeGitHub(routes);
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
    await client.closePullRequestsFrom({ ...ref, branch: 'officina/learning-1' });
    const methods = calls.slice(1).map((call) => call.method);
    expect(methods.slice(0, 2)).toEqual(['GET', 'GET']);
    expect(methods.filter((method) => method === 'PATCH')).toHaveLength(101);
  });

  test('creating a branch again keeps the one the first attempt made, never moving it', async () => {
    const refs = new Map<string, string>();
    let head = 'abc';
    const { fetchImpl, calls } = fakeGitHub({
      'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
      'GET /repos/ViciApp/vici-app/git/ref/heads/main': () => json({ object: { sha: head } }),
      'POST /repos/ViciApp/vici-app/git/refs': () => {
        const created = calls.at(-1)!.body as { ref: string; sha: string };
        if (refs.has(created.ref)) return json({ message: 'Reference already exists' }, 422);
        refs.set(created.ref, created.sha);
        return json({ ref: created.ref }, 201);
      }
    });
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
    const input = { ...ref, branch: 'officina/learning-1', from: 'main' };
    await client.createBranch(input);
    head = 'def';
    await client.createBranch(input);
    expect(refs.get('refs/heads/officina/learning-1')).toBe('abc');
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  test('any other refusal to create a branch is still an error', async () => {
    const { fetchImpl } = fakeGitHub({
      'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
      'GET /repos/ViciApp/vici-app/git/ref/heads/main': () => json({ object: { sha: 'abc' } }),
      'POST /repos/ViciApp/vici-app/git/refs': () => json({ message: 'Invalid request' }, 422)
    });
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
    const creating = client.createBranch({ ...ref, branch: 'officina/learning-1', from: 'main' });
    await expect(creating).rejects.toThrow('GitHub 422');
  });

  test('resolves the open threads of the given reviews on every page of a pull request', async () => {
    const thread = (id: string, reviewId: number, isResolved = false) => ({
      id,
      isResolved,
      comments: { nodes: [{ pullRequestReview: { databaseId: reviewId } }] }
    });
    const page = (nodes: unknown[], endCursor: string | null) =>
      json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes }
            }
          }
        }
      });
    const answers = [
      page([thread('T1', 7), thread('T2', 8), thread('T3', 7, true)], 'c1'),
      page([thread('T4', 7)], null),
      json({ data: {} }),
      json({ data: {} })
    ];
    const { fetchImpl, calls } = fakeGitHub({
      'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
      'POST /graphql': () => answers.shift()!
    });
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });

    expect(await client.resolveReviewThreads({ ...ref, pullRequest: 42, reviewIds: [7] })).toBe(2);
    const graphqlCalls = calls.filter((call) => call.url === '/graphql');
    const variables = graphqlCalls.map(
      (call) => (call.body as { variables: Record<string, unknown> }).variables
    );
    expect(variables).toEqual([
      { owner: 'ViciApp', name: 'vici-app', number: 42, after: null },
      { owner: 'ViciApp', name: 'vici-app', number: 42, after: 'c1' },
      { id: 'T1' },
      { id: 'T4' }
    ]);
  });
});

describe('merge when ready', () => {
  const ref = {
    installationId: 99,
    repo: 'ViciApp/vici-app',
    pullRequest: 42,
    expectedHead: 'abc'
  };
  const routes = (graphql: () => Response) => ({
    'POST /app/installations/99/access_tokens': tokenRoute('2099-01-01T00:00:00Z'),
    'GET /repos/ViciApp/vici-app/pulls/42': () => json({ node_id: 'PR_42', head: { sha: 'abc' } }),
    'POST /graphql': graphql,
    'PUT /repos/ViciApp/vici-app/pulls/42/merge': () => json({ merged: true })
  });

  test('as the App, turns auto-merge on pinned to the verified head', async () => {
    const { fetchImpl, calls } = fakeGitHub(routes(() => json({ data: {} })));
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
    expect(await client.mergeWhenReady(ref)).toBe('auto_merge');
    const graphql = calls.find((call) => call.url === '/graphql')!;
    expect(graphql.authorization).toStartWith('Bearer ghs_');
    expect((graphql.body as { variables: unknown }).variables).toEqual({
      id: 'PR_42',
      head: 'abc'
    });
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  test('as the App, merges a pull request already clean with a squash pinned to the head', async () => {
    const clean = () => json({ errors: [{ message: 'Pull request is in clean status' }] });
    const { fetchImpl, calls } = fakeGitHub(routes(clean));
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
    expect(await client.mergeWhenReady(ref)).toBe('merged');
    const merge = calls.find((call) => call.method === 'PUT')!;
    expect(merge.authorization).toStartWith('Bearer ghs_');
    expect(merge.body).toEqual({ merge_method: 'squash', sha: 'abc' });
  });

  test('as the App, any other refusal is an error and nothing is merged', async () => {
    const refused = () => json({ errors: [{ message: 'Auto merge is not allowed' }] });
    const { fetchImpl, calls } = fakeGitHub(routes(refused));
    const client = createGitHubClient({ appId: '1', privateKeyPem, fetch: fetchImpl });
    await expect(client.mergeWhenReady(ref)).rejects.toThrow('Auto merge is not allowed');
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  test('as a person, uses their token for both calls', async () => {
    const clean = () => json({ errors: [{ message: 'Pull request is in clean status' }] });
    const { fetchImpl, calls } = fakeGitHub(routes(clean));
    const asUser = createGitHubAsUser({ fetch: fetchImpl });
    expect(await asUser.mergeWhenReady('gho_person', 'ViciApp/vici-app', 42, 'abc')).toBe('merged');
    expect(calls.map((call) => call.authorization)).toEqual([
      'Bearer gho_person',
      'Bearer gho_person',
      'Bearer gho_person'
    ]);
    expect(calls.at(-1)!.body).toEqual({ merge_method: 'squash', sha: 'abc' });
  });
});

describe('GitHub as a person', () => {
  test('lists every page of reviews with the person token, leaving out deleted accounts', async () => {
    const page = (count: number, offset: number) =>
      Array.from({ length: count }, (_, index) => ({
        user:
          index === 0 && offset > 0
            ? null
            : { id: offset + index, login: `reviewer${offset + index}` },
        state: 'APPROVED',
        commit_id: 'abc'
      }));
    let served = 0;
    const { fetchImpl, calls } = fakeGitHub({
      'GET /repos/ViciApp/vici-app/pulls/42/reviews': () =>
        json(served++ === 0 ? page(100, 0) : page(2, 100))
    });
    const asUser = createGitHubAsUser({ fetch: fetchImpl });

    const reviews = await asUser.reviews('gho_person', 'ViciApp/vici-app', 42);
    expect(reviews).toHaveLength(101);
    expect(reviews.at(-1)).toEqual({
      userId: 101,
      login: 'reviewer101',
      state: 'APPROVED',
      commitId: 'abc'
    });
    expect(calls.map((call) => [call.query, call.authorization])).toEqual([
      ['?per_page=100&page=1', 'Bearer gho_person'],
      ['?per_page=100&page=2', 'Bearer gho_person']
    ]);
  });

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
      query: '',
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
