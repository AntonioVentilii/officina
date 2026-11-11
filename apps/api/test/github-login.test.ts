import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { createGitHubAsUser } from '@officina/github';
import { Pool } from 'pg';
import { resetAndSeed, type Seeded } from '../../../packages/db/test/seed';
import { createApp } from '../src/app';
import { createGitHubAccounts } from '../src/github-accounts';
import { loginLink } from '../src/people';
import { createTokenBox } from '../src/token-box';

const url = process.env.TEST_DATABASE_URL;
const KEY = randomBytes(32).toString('base64');

describe('token box', () => {
  test('round-trips, uses a fresh nonce, and refuses tampered or foreign boxes', () => {
    const box = createTokenBox(KEY);
    const sealed = box.seal('ghu_secret');
    expect(sealed).not.toContain('ghu_secret');
    expect(box.seal('ghu_secret')).not.toBe(sealed);
    expect(box.open(sealed)).toBe('ghu_secret');
    const tampered = `${sealed.slice(0, -4)}AAAA`;
    expect(() => box.open(tampered)).toThrow();
    expect(() => createTokenBox(randomBytes(32).toString('base64')).open(sealed)).toThrow();
    expect(() => createTokenBox('short')).toThrow('32 bytes');
  });
});

describe('approving as a person', () => {
  test('approves exactly the verified commit and never asks GitHub to merge', async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input).replace('https://api.github.com', '')}`);
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return Response.json({});
    }) as typeof fetch;
    const asUser = createGitHubAsUser({ fetch: fetchFake });
    await asUser.approve('t', 'o/r', 5, 'verified', 'Verified.');
    expect(calls).toEqual(['POST /repos/o/r/pulls/5/reviews']);
    expect(bodies).toEqual([{ event: 'APPROVE', commit_id: 'verified', body: 'Verified.' }]);
  });
});

describe.skipIf(!url)('GitHub sign-in', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const githubAs = (user: { id: number; login: string }) => {
    const accounts = createGitHubAccounts({
      pool,
      box: createTokenBox(KEY),
      auth: {
        authorizeUrl: (state) => `https://github.com/login/oauth/authorize?state=${state}`,
        exchangeCode: async () => ({
          accessToken: 'ghu_access',
          accessExpiresAt: new Date(Date.now() + 8 * 3600_000),
          refreshToken: 'ghr_refresh',
          refreshExpiresAt: new Date(Date.now() + 180 * 86_400_000)
        }),
        refresh: async () => {
          throw new Error('not expected');
        }
      },
      asUser: { user: async () => user } as never
    });
    return accounts;
  };

  const appFor = (user: { id: number; login: string }) => {
    const accounts = githubAs(user);
    return {
      accounts,
      app: createApp({
        pool,
        webhookSecret: 'x'.repeat(32),
        board: {
          publicUrl: 'https://officina.example',
          githubLogin: {
            accounts,
            authorizeUrl: (state) => `https://github.com/login/oauth/authorize?state=${state}`
          }
        }
      })
    };
  };

  const signIn = async (app: ReturnType<typeof appFor>['app']) => {
    const link = await loginLink(pool, { publicUrl: 'https://officina.example' });
    const response = await app.handle(
      new Request('http://local/auth/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-officina-request': '1' },
        body: JSON.stringify({ token: link.slice(link.indexOf('#') + 1) })
      })
    );
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };

  const start = async (app: ReturnType<typeof appFor>['app'], mode: string, cookie?: string) => {
    const response = await app.handle(
      new Request(`http://local/auth/github/start?mode=${mode}`, {
        headers: cookie ? { cookie } : {}
      })
    );
    expect(response.status).toBe(302);
    const state = new URL(response.headers.get('location')!).searchParams.get('state')!;
    const oauth = response.headers.get('set-cookie')!.split(';')[0]!;
    expect(oauth).toBe(`officina_oauth=${state}`);
    return { state, oauth };
  };

  const callback = (app: ReturnType<typeof appFor>['app'], state: string, cookie: string) =>
    app.handle(
      new Request(`http://local/auth/github/callback?code=c&state=${state}`, {
        headers: { cookie }
      })
    );

  test('a signed-in member links their account, then can sign in with GitHub alone', async () => {
    const { app, accounts } = appFor({ id: 42, login: 'antonio' });
    const session = await signIn(app);
    const { state, oauth } = await start(app, 'link', session);
    const linked = await callback(app, state, oauth);
    expect(linked.headers.get('location')).toBe('/?github=linked');
    expect(await accounts.tokenFor(seeded.ownerId)).toEqual({
      token: 'ghu_access',
      login: 'antonio'
    });
    const stored = await pool.query('select access_token_enc from github_accounts');
    expect(stored.rows[0].access_token_enc).not.toContain('ghu_access');

    const me = (await (
      await app.handle(new Request('http://local/api/me', { headers: { cookie: session } }))
    ).json()) as { github: unknown };
    expect(me.github).toEqual({ login: 'antonio' });

    const second = await start(app, 'signin');
    // Starting a sign-in needs no session, so it must not write anything.
    expect((await pool.query('select 1 from oauth_states')).rowCount).toBe(0);
    const signedIn = await callback(app, second.state, second.oauth);
    expect(signedIn.headers.get('location')).toBe('/');
    expect(
      signedIn.headers.getSetCookie().some((cookie) => cookie.startsWith('officina_session='))
    ).toBe(true);

    const replay = await callback(app, second.state, second.oauth);
    expect(replay.headers.get('location')).toContain('/signin?error=');
  });

  test('a state from another browser, or an unknown GitHub account, never signs anyone in', async () => {
    const { app } = appFor({ id: 7, login: 'stranger' });
    const { state } = await start(app, 'signin');
    const forged = await callback(app, state, 'officina_oauth=other');
    expect(decodeURIComponent(forged.headers.get('location')!)).toContain(
      'did not match this browser'
    );

    const stale = `s.${Date.now() - 1000}.abc`;
    const expired = await callback(app, stale, `officina_oauth=${stale}`);
    expect(decodeURIComponent(expired.headers.get('location')!)).toContain('expired');
    const stretched = `s.${Date.now() + 86_400_000}.abc`;
    const tooLong = await callback(app, stretched, `officina_oauth=${stretched}`);
    expect(decodeURIComponent(tooLong.headers.get('location')!)).toContain('expired');

    const fresh = await start(app, 'signin');
    const unknown = await callback(app, fresh.state, fresh.oauth);
    expect(decodeURIComponent(unknown.headers.get('location')!)).toContain(
      '@stranger is not linked to a member yet'
    );
    expect(
      unknown.headers.getSetCookie().some((cookie) => cookie.startsWith('officina_session='))
    ).toBe(false);
  });
});
