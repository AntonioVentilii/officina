import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { findMemberByEmail, linkGitHubAccount, unlinkGitHubAccount } from '@officina/db';
import {
  GitHubError,
  RefreshTokenRefused,
  createGitHubAsUser,
  type UserTokens
} from '@officina/github';
import { Pool } from 'pg';
import { resetAndSeed, type Seeded } from '../../../packages/db/test/seed';
import { createApp } from '../src/app';
import { createGitHubAccounts } from '../src/github-accounts';
import { accessLogView, invite, loginLink } from '../src/people';
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

describe('merging as a person', () => {
  const fake = (graphqlErrors: string | null) => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input).replace('https://api.github.com', '');
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      if (path.endsWith('/pulls/5'))
        return Response.json({
          node_id: 'PR_1',
          state: 'open',
          merged: false,
          head: { sha: 'abc' }
        });
      if (path === '/graphql')
        return Response.json(
          graphqlErrors ? { errors: [{ message: graphqlErrors }] } : { data: {} }
        );
      return Response.json({});
    }) as typeof fetch;
    return { asUser: createGitHubAsUser({ fetch: fetchFake }), calls, bodies };
  };

  test('turns on auto-merge, or merges straight away when GitHub says the pull request is ready', async () => {
    const pending = fake(null);
    expect(await pending.asUser.mergeWhenReady('t', 'o/r', 5, 'abc')).toBe('auto_merge');
    expect(pending.calls).toEqual(['GET /repos/o/r/pulls/5', 'POST /graphql']);

    const clean = fake('Pull request is in clean status');
    expect(await clean.asUser.mergeWhenReady('t', 'o/r', 5, 'abc')).toBe('merged');
    expect(clean.calls.at(-1)).toBe('PUT /repos/o/r/pulls/5/merge');

    // Pinned to the verified commit, never the head GitHub reports now.
    const pinned = fake('Pull request is in clean status');
    await pinned.asUser.mergeWhenReady('t', 'o/r', 5, 'verified');
    expect(pinned.bodies).toEqual([
      expect.objectContaining({ variables: { id: 'PR_1', head: 'verified' } }),
      { merge_method: 'squash', sha: 'verified' }
    ]);

    await expect(
      fake('Resource not accessible').asUser.mergeWhenReady('t', 'o/r', 5, 'abc')
    ).rejects.toThrow('Resource not accessible');
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

  const fromNow = (ms: number) => new Date(Date.now() + ms);

  const githubAs = (
    user: { id: number; login: string },
    tokens: UserTokens = {
      accessToken: 'ghu_access',
      accessExpiresAt: fromNow(8 * 3600_000),
      refreshToken: 'ghr_refresh',
      refreshExpiresAt: fromNow(180 * 86_400_000)
    },
    refresh: (refreshToken: string) => Promise<UserTokens> = async () => {
      throw new Error('not expected');
    }
  ) => {
    const accounts = createGitHubAccounts({
      pool,
      box: createTokenBox(KEY),
      auth: {
        authorizeUrl: (state) => `https://github.com/login/oauth/authorize?state=${state}`,
        exchangeCode: async () => tokens,
        refresh
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

  const redeem = (
    app: ReturnType<typeof appFor>['app'],
    link: string,
    cookie?: string,
    replace?: boolean
  ) =>
    app.handle(
      new Request('http://local/auth/redeem', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-officina-request': '1',
          ...(cookie ? { cookie } : {})
        },
        body: JSON.stringify({ token: link.slice(link.indexOf('#') + 1), replace })
      })
    );

  const sessionFrom = (response: Response) => response.headers.get('set-cookie')!.split(';')[0]!;

  const signIn = async (app: ReturnType<typeof appFor>['app'], link?: string) =>
    sessionFrom(
      await redeem(app, link ?? (await loginLink(pool, { publicUrl: 'https://officina.example' })))
    );

  const inviteTim = () =>
    invite(pool, {
      publicUrl: 'https://officina.example',
      email: 'tim@example.com',
      name: 'Tim',
      role: 'contributor',
      domains: []
    });

  /** Where the browser is sent to authorize, and the cookie that binds the state to it. */
  const authorization = (url: string, response: Response) => {
    const state = new URL(url).searchParams.get('state')!;
    const oauth = response.headers.getSetCookie()[0]!.split(';')[0]!;
    expect(oauth).toBe(`officina_oauth=${state}`);
    return { state, oauth };
  };

  const start = async (app: ReturnType<typeof appFor>['app'], mode: string, cookie?: string) => {
    const response = await app.handle(
      new Request(`http://local/auth/github/start?mode=${mode}`, {
        headers: cookie ? { cookie } : {}
      })
    );
    expect(response.status).toBe(302);
    return authorization(response.headers.get('location')!, response);
  };

  const link = async (app: ReturnType<typeof appFor>['app'], cookie: string) => {
    const response = await app.handle(
      new Request('http://local/auth/github/link', {
        method: 'POST',
        headers: { 'x-officina-request': '1', cookie }
      })
    );
    expect(response.status).toBe(200);
    const { redirect } = (await response.json()) as { redirect: string };
    return authorization(redirect, response);
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
    const { state, oauth } = await link(app, session);
    const linked = await callback(app, state, oauth);
    expect(linked.headers.get('location')).toBe('/?github=linked');
    expect(await accounts.tokenFor(seeded.ownerId)).toEqual({
      token: 'ghu_access',
      login: 'antonio',
      userId: 42
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

  test('linking an account another member holds is refused, and the log records only the first link', async () => {
    await invite(pool, {
      publicUrl: 'https://officina.example',
      email: 'gio@example.com',
      name: 'Gio',
      role: 'contributor',
      domains: []
    });
    const gio = (await findMemberByEmail(pool, 'gio@example.com'))!.id;
    const accounts = githubAs({ id: 42, login: 'antonio' });
    expect(await accounts.complete('c', seeded.ownerId)).toMatchObject({ ok: true });
    // Signing in with the account stores fresh tokens but links nothing new.
    expect(await accounts.complete('c', null)).toMatchObject({ ok: true });
    expect(await accounts.complete('c', gio)).toEqual({
      ok: false,
      problem: 'github_linked_elsewhere'
    });

    expect(await accounts.tokenFor(seeded.ownerId)).not.toBeNull();
    const github = (await accessLogView(pool, seeded.projectId))
      .filter((event) => event.type.startsWith('github_'))
      .map((event) => `${event.member} ${event.text}`);
    expect(github).toEqual(['Antonio connected GitHub as @antonio']);
  });

  test('after a GitHub sign-in a member returns only to a path on this site', async () => {
    const { app } = appFor({ id: 42, login: 'antonio' });
    const session = await signIn(app);
    const linked = await link(app, session);
    await callback(app, linked.state, linked.oauth);

    const landing = async (next: string) => {
      const { state, oauth } = await start(app, 'signin');
      const response = await callback(
        app,
        state,
        `${oauth}; officina_next=${encodeURIComponent(next)}`
      );
      return response.headers.get('location');
    };
    expect(await landing('/tasks/3?tab=log')).toBe('/tasks/3?tab=log');
    for (const elsewhere of [
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r/evil.example',
      '/.//evil.example',
      '/./\\evil.example',
      '/..//evil.example',
      '/a/..//evil.example',
      '/%2e//evil.example',
      'https://evil.example'
    ]) {
      expect(await landing(elsewhere)).toBe('/');
    }
  });

  test('a state from another browser, or an unknown GitHub account, never signs anyone in', async () => {
    const { app } = appFor({ id: 7, login: 'stranger' });
    const { state } = await start(app, 'signin');
    // The sign-in page gets a code it words itself, never text to show as it is.
    const forged = await callback(app, state, 'officina_oauth=other');
    expect(forged.headers.get('location')).toBe('/signin?error=github_mismatch');

    const stale = `s.${Date.now() - 1000}.abc`;
    const expired = await callback(app, stale, `officina_oauth=${stale}`);
    expect(expired.headers.get('location')).toBe('/signin?error=github_expired');
    const stretched = `s.${Date.now() + 86_400_000}.abc`;
    const tooLong = await callback(app, stretched, `officina_oauth=${stretched}`);
    expect(tooLong.headers.get('location')).toBe('/signin?error=github_expired');

    const fresh = await start(app, 'signin');
    const unknown = await callback(app, fresh.state, fresh.oauth);
    expect(unknown.headers.get('location')).toBe('/signin?error=github_not_linked');
    expect(
      unknown.headers.getSetCookie().some((cookie) => cookie.startsWith('officina_session='))
    ).toBe(false);
  });

  test('an expired access token is refreshed once and the new tokens are kept', async () => {
    const refreshedWith: string[] = [];
    const accounts = githubAs(
      { id: 42, login: 'antonio' },
      {
        accessToken: 'ghu_old',
        accessExpiresAt: fromNow(-60_000),
        refreshToken: 'ghr_old',
        refreshExpiresAt: fromNow(180 * 86_400_000)
      },
      async (refreshToken) => {
        refreshedWith.push(refreshToken);
        return {
          accessToken: 'ghu_new',
          accessExpiresAt: fromNow(8 * 3600_000),
          refreshToken: 'ghr_new',
          refreshExpiresAt: fromNow(180 * 86_400_000)
        };
      }
    );
    expect(await accounts.complete('c', seeded.ownerId)).toMatchObject({ ok: true });

    const fresh = { token: 'ghu_new', login: 'antonio', userId: 42 };
    expect(await accounts.tokenFor(seeded.ownerId)).toEqual(fresh);
    expect(await accounts.tokenFor(seeded.ownerId)).toEqual(fresh);
    expect(refreshedWith).toEqual(['ghr_old']);
    const stored = await pool.query<{ refresh_token_enc: string }>(
      'select refresh_token_enc from github_accounts'
    );
    expect(createTokenBox(KEY).open(stored.rows[0]!.refresh_token_enc)).toBe('ghr_new');
  });

  describe('a refresh of an expired token', () => {
    const RENEWED: UserTokens = {
      accessToken: 'ghu_new',
      accessExpiresAt: fromNow(8 * 3600_000),
      refreshToken: 'ghr_new',
      refreshExpiresAt: fromNow(180 * 86_400_000)
    };
    const expiredAccount = (refresh: () => Promise<UserTokens> = async () => RENEWED) =>
      githubAs(
        { id: 42, login: 'antonio' },
        {
          accessToken: 'ghu_old',
          accessExpiresAt: fromNow(-60_000),
          refreshToken: 'ghr_old',
          refreshExpiresAt: fromNow(180 * 86_400_000)
        },
        refresh
      );
    const githubLog = async () =>
      (await accessLogView(pool, seeded.projectId))
        .filter((event) => event.type.startsWith('github_'))
        .map((event) => `${event.member} ${event.text}`);
    const accountRows = async () =>
      (
        await pool.query<{ access_token_enc: string }>(
          'select access_token_enc from github_accounts'
        )
      ).rows;
    const LOST =
      'Antonio lost GitHub @antonio: its renewed token could not be kept, so it must reconnect';

    /** Makes every `action` on `table` fail, as a lost connection at that step would. */
    const failing = async (action: 'insert' | 'update', table: string) => {
      const name = `fail_${action}_${table}`;
      await pool.query(
        `create function ${name}() returns trigger language plpgsql as
           $$ begin raise exception '% of % failed', tg_op, tg_table_name; end $$`
      );
      await pool.query(
        `create trigger ${name} before ${action} on ${table} for each row execute function ${name}()`
      );
      return async () => {
        await pool.query(`drop trigger ${name} on ${table}`);
        await pool.query(`drop function ${name}()`);
      };
    };

    test('whose new tokens cannot be stored forgets the spent account and tells the member to reconnect', async () => {
      const accounts = expiredAccount();
      expect(await accounts.complete('c', seeded.ownerId)).toMatchObject({ ok: true });
      const heal = await failing('update', 'github_accounts');
      await expect(accounts.tokenFor(seeded.ownerId)).rejects.toThrow(
        'UPDATE of github_accounts failed'
      );
      await heal();

      expect(await accountRows()).toHaveLength(0);
      expect(await githubLog()).toEqual([LOST, 'Antonio connected GitHub as @antonio']);
      expect(await accounts.tokenFor(seeded.ownerId)).toBeNull();
      // The GitHub sign-in stays, and signing in with it stores fresh tokens again.
      expect(await accounts.complete('c', null)).toMatchObject({
        ok: true,
        memberId: seeded.ownerId
      });
      expect(await accountRows()).toHaveLength(1);
    });

    test('that GitHub refuses, its token spent by a refresh whose answer was lost, forgets the account and tells the member to reconnect', async () => {
      const refusals: string[] = [];
      const accounts = expiredAccount(async () => {
        refusals.push('refused');
        throw new RefreshTokenRefused(200, '/login/oauth/access_token', 'bad_refresh_token');
      });
      expect(await accounts.complete('c', seeded.ownerId)).toMatchObject({ ok: true });

      expect(await accounts.tokenFor(seeded.ownerId)).toBeNull();
      expect(await accountRows()).toHaveLength(0);
      expect(await githubLog()).toEqual([
        'Antonio lost GitHub @antonio: GitHub no longer accepts its token, so it must reconnect',
        'Antonio connected GitHub as @antonio'
      ]);
      // Forgotten once: nothing is left to refresh with.
      expect(await accounts.tokenFor(seeded.ownerId)).toBeNull();
      expect(refusals).toHaveLength(1);
    });

    test('that fails for another reason keeps the account and passes the error on', async () => {
      const accounts = expiredAccount(async () => {
        throw new GitHubError(502, '/login/oauth/access_token', 'not JSON');
      });
      expect(await accounts.complete('c', seeded.ownerId)).toMatchObject({ ok: true });
      await expect(accounts.tokenFor(seeded.ownerId)).rejects.toThrow('GitHub 502');
      expect(await accountRows()).toHaveLength(1);
    });

    test('whose account cannot be forgotten either still fails with the error of its save', async () => {
      const accounts = expiredAccount();
      expect(await accounts.complete('c', seeded.ownerId)).toMatchObject({ ok: true });
      const healUpdates = await failing('update', 'github_accounts');
      const healLog = await failing('insert', 'access_events');
      await expect(accounts.tokenFor(seeded.ownerId)).rejects.toThrow(
        'UPDATE of github_accounts failed'
      );
      await healUpdates();
      await healLog();
      expect(await accountRows()).toHaveLength(1);
    });

    /** A refresh GitHub answers only once the test lets it, so the member can act meanwhile. */
    const pausedRefresh = () => {
      let answer = () => {};
      let asked = () => {};
      const reached = new Promise<void>((resolve) => (asked = resolve));
      const released = new Promise<void>((resolve) => (answer = resolve));
      const refresh = async () => {
        asked();
        await released;
        return RENEWED;
      };
      return { refresh, reached, answer: () => answer() };
    };

    const waitsForARefresh = async () =>
      (
        await pool.query<{ waiting: boolean }>(
          "select exists (select 1 from pg_locks where locktype = 'advisory' and not granted) as waiting"
        )
      ).rows[0]!.waiting;

    test('that another caller needs meanwhile is waited for, so the spent token is never presented again', async () => {
      const paused = pausedRefresh();
      let asked = 0;
      const accounts = expiredAccount(async () => {
        asked += 1;
        if (asked === 1) return paused.refresh();
        // GitHub spent the token in answering the first refresh.
        throw new RefreshTokenRefused(200, '/login/oauth/access_token', 'bad_refresh_token');
      });
      expect(await accounts.complete('c', seeded.ownerId)).toMatchObject({ ok: true });
      const first = accounts.tokenFor(seeded.ownerId);
      await paused.reached;
      let finished = false;
      const second = accounts.tokenFor(seeded.ownerId).finally(() => {
        finished = true;
      });
      while (!finished && !(await waitsForARefresh())) await Bun.sleep(5);
      paused.answer();

      const fresh = { token: 'ghu_new', login: 'antonio', userId: 42 };
      expect(await first).toEqual(fresh);
      expect(await second).toEqual(fresh);
      expect(asked).toBe(1);
      expect(await accountRows()).toHaveLength(1);
      expect(await githubLog()).toEqual(['Antonio connected GitHub as @antonio']);
    });

    test('never brings back an account the member disconnected meanwhile', async () => {
      const paused = pausedRefresh();
      const accounts = expiredAccount(paused.refresh);
      expect(await accounts.complete('c', seeded.ownerId)).toMatchObject({ ok: true });
      const pending = accounts.tokenFor(seeded.ownerId);
      await paused.reached;
      await unlinkGitHubAccount(pool, seeded.ownerId);
      paused.answer();

      expect(await pending).toBeNull();
      expect(await accountRows()).toHaveLength(0);
    });

    test('never overwrites the account the member reconnected meanwhile', async () => {
      const paused = pausedRefresh();
      const accounts = expiredAccount(paused.refresh);
      expect(await accounts.complete('c', seeded.ownerId)).toMatchObject({ ok: true });
      const pending = accounts.tokenFor(seeded.ownerId);
      await paused.reached;
      const box = createTokenBox(KEY);
      await linkGitHubAccount(pool, {
        memberId: seeded.ownerId,
        githubUserId: 42,
        login: 'antonio',
        accessTokenEnc: box.seal('ghu_reconnected'),
        accessExpiresAt: fromNow(8 * 3600_000),
        refreshTokenEnc: box.seal('ghr_reconnected'),
        refreshExpiresAt: fromNow(180 * 86_400_000)
      });
      paused.answer();

      expect(await pending).toBeNull();
      const rows = await accountRows();
      expect(rows.map((row) => box.open(row.access_token_enc))).toEqual(['ghu_reconnected']);
      expect(await accounts.tokenFor(seeded.ownerId)).toMatchObject({ token: 'ghu_reconnected' });
    });
  });

  test('an expired refresh token gives no token, without asking GitHub', async () => {
    const accounts = githubAs(
      { id: 42, login: 'antonio' },
      {
        accessToken: 'ghu_old',
        accessExpiresAt: fromNow(-60_000),
        refreshToken: 'ghr_old',
        refreshExpiresAt: fromNow(-60_000)
      }
    );
    expect(await accounts.complete('c', seeded.ownerId)).toMatchObject({ ok: true });
    expect(await accounts.tokenFor(seeded.ownerId)).toBeNull();
  });

  const githubOwners = async () =>
    (
      await pool.query<{ subject: string; member_id: string }>(
        "select subject, member_id from identities where provider = 'github' order by subject"
      )
    ).rows;

  test('connecting GitHub starts only from a request the board sent', async () => {
    const { app } = appFor({ id: 42, login: 'antonio' });
    const session = await signIn(app);
    const forged = await app.handle(
      new Request('http://local/auth/github/link', { method: 'POST', headers: { cookie: session } })
    );
    expect(forged.status).toBe(403);

    // A plain link only ever starts a sign-in, whoever is signed in.
    const { state, oauth } = await start(app, 'link', session);
    expect(state.startsWith('s.')).toBe(true);
    const result = await callback(app, state, oauth);
    expect(result.headers.get('location')).toContain('/signin?error=');
    expect((await pool.query('select 1 from github_accounts')).rowCount).toBe(0);
  });

  test('a sign-in link for someone else replaces the session this browser holds only when asked', async () => {
    const { app } = appFor({ id: 42, login: 'antonio' });
    const owner = await signIn(app);
    const timLink = await inviteTim();

    const asked = await redeem(app, timLink, owner);
    expect(asked.status).toBe(409);
    expect(asked.headers.get('set-cookie')).toBeNull();

    // The link was not spent: confirming signs in as Tim.
    const confirmed = await redeem(app, timLink, owner, true);
    expect(confirmed.status).toBe(200);
    const me = (await (
      await app.handle(
        new Request('http://local/api/me', { headers: { cookie: sessionFrom(confirmed) } })
      )
    ).json()) as { member: { name: string } };
    expect(me.member.name).toBe('Tim');

    // A link for the member already signed in needs no confirmation.
    const own = await loginLink(pool, { publicUrl: 'https://officina.example' });
    expect((await redeem(app, own, owner)).status).toBe(200);
  });

  test('a GitHub account connected to one member is never moved to another', async () => {
    const { app } = appFor({ id: 42, login: 'antonio' });
    const owner = await signIn(app);
    const first = await link(app, owner);
    await callback(app, first.state, first.oauth);

    const tim = await signIn(app, await inviteTim());
    const second = await link(app, tim);
    const refused = await callback(app, second.state, second.oauth);
    expect(refused.headers.get('location')).toBe('/signin?error=github_linked_elsewhere');
    const accounts = await pool.query('select member_id from github_accounts');
    expect(accounts.rows).toEqual([{ member_id: seeded.ownerId }]);
    expect(await githubOwners()).toEqual([{ subject: '42', member_id: seeded.ownerId }]);
  });

  test('connecting another GitHub account stops the previous one from signing in', async () => {
    const before = appFor({ id: 42, login: 'antonio' });
    const session = await signIn(before.app);
    const first = await link(before.app, session);
    await callback(before.app, first.state, first.oauth);

    const after = appFor({ id: 43, login: 'antonio-work' });
    const second = await link(after.app, session);
    expect((await callback(after.app, second.state, second.oauth)).headers.get('location')).toBe(
      '/?github=linked'
    );
    expect(await githubOwners()).toEqual([{ subject: '43', member_id: seeded.ownerId }]);

    const old = await start(before.app, 'signin');
    const refused = await callback(before.app, old.state, old.oauth);
    expect(refused.headers.get('location')).toBe('/signin?error=github_not_linked');
  });
});
