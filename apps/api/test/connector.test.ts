import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { purgeConnectorCredentials } from '@officina/db';
import { Pool } from 'pg';
import { resetAndSeed, type Seeded } from '../../../packages/db/test/seed';
import { createApp } from '../src/app';
import { invite, loginLink } from '../src/people';

const url = process.env.TEST_DATABASE_URL;
const PUBLIC_URL = 'https://officina.example';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

describe.skipIf(!url)('connector for Claude', () => {
  const pool = new Pool({ connectionString: url });
  let seeded: Seeded;
  const app = createApp({ pool, webhookSecret: 'x'.repeat(32), board: { publicUrl: PUBLIC_URL } });

  beforeEach(async () => {
    seeded = await resetAndSeed(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  // Response bodies are checked field by field below, so their shape stays loose here.
  const json = async (response: Response): Promise<any> => response.json();

  const handle = (path: string, init?: RequestInit) =>
    app.handle(new Request(`http://local${path}`, init));

  const signIn = async (email?: string) => {
    const link = await loginLink(pool, { publicUrl: PUBLIC_URL, ...(email ? { email } : {}) });
    const response = await handle('/auth/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-officina-request': '1' },
      body: JSON.stringify({ token: link.slice(link.indexOf('#') + 1) })
    });
    return response.headers.get('set-cookie')!.split(';')[0]!;
  };

  const register = async (redirectUris = [CALLBACK]) =>
    handle('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: redirectUris })
    });

  const form = (fields: Record<string, string>) =>
    handle('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString()
    });

  /** The whole dance Claude does: register, authorize, consent on the board, exchange the code. */
  const connect = async (email?: string) => {
    const client = await json(await register());
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 'xyz',
      resource: `${PUBLIC_URL}/mcp`,
      scope: 'officina'
    });
    const authorize = await handle(`/oauth/authorize?${query}`);
    expect(authorize.status).toBe(302);
    expect(authorize.headers.get('location')).toBe(`${PUBLIC_URL}/connect?${query}`);

    const cookie = await signIn(email);
    const info = await json(
      await handle(`/api/connector/authorization?${query}`, { headers: { cookie } })
    );
    expect(info).toMatchObject({ client: 'Claude', returnsTo: 'claude.ai' });
    const consent = await json(
      await handle('/api/connector/authorization', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-officina-request': '1' },
        body: JSON.stringify({ params: Object.fromEntries(query), allow: true })
      })
    );
    const back = new URL(consent.redirect);
    expect(back.origin + back.pathname).toBe(CALLBACK);
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe(PUBLIC_URL);
    const code = back.searchParams.get('code')!;
    const exchange = {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      resource: `${PUBLIC_URL}/mcp`
    };
    const tokens = await json(await form(exchange));
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'officina' });
    return { tokens, clientId: client.client_id as string, exchange };
  };

  let rpcId = 0;
  const rpc = (token: string | null, method: string, params?: unknown) =>
    handle('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
    });

  const tool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const response = await json(await rpc(token, 'tools/call', { name, arguments: args }));
    return response.result as { content: { text: string }[]; isError: boolean };
  };

  test('publishes the metadata Claude discovers the server with', async () => {
    const resource = await json(await handle('/.well-known/oauth-protected-resource/mcp'));
    expect(resource).toMatchObject({
      resource: `${PUBLIC_URL}/mcp`,
      authorization_servers: [PUBLIC_URL]
    });
    const server = await json(await handle('/.well-known/oauth-authorization-server'));
    expect(server).toMatchObject({
      issuer: PUBLIC_URL,
      registration_endpoint: `${PUBLIC_URL}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none']
    });

    const anonymous = await rpc(null, 'initialize', { protocolVersion: '2025-06-18' });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp", scope="officina"`
    );
    expect((await rpc('forged', 'tools/list')).status).toBe(401);
    expect((await handle('/mcp')).status).toBe(405);
  });

  test('registration accepts https and loopback redirects only', async () => {
    expect((await register(['http://evil.example/cb'])).status).toBe(400);
    expect((await register(['https://claude.ai/cb#frag'])).status).toBe(400);
    const local = await register(['http://localhost:4567/callback']);
    expect(local.status).toBe(201);
    expect(await json(local)).toMatchObject({ token_endpoint_auth_method: 'none' });
  });

  test('a bad client or redirect is never redirected to', async () => {
    const client = await json(await register());
    const unknown = await handle('/oauth/authorize?client_id=nope&response_type=code');
    expect(unknown.headers.get('location')).toStartWith(`${PUBLIC_URL}/connect?error=`);
    const elsewhere = await handle(
      `/oauth/authorize?client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}`
    );
    expect(elsewhere.headers.get('location')).toStartWith(`${PUBLIC_URL}/connect?error=`);
    const noPkce = await handle(
      `/oauth/authorize?client_id=${client.client_id}&response_type=code&state=s`
    );
    const location = new URL(noPkce.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(CALLBACK);
    expect(location.searchParams.get('error')).toBe('invalid_request');
  });

  test('a code works once, only with its verifier, and refresh tokens rotate', async () => {
    const { tokens, clientId, exchange } = await connect();
    expect((await json(await form(exchange))).error).toBe('invalid_grant');

    const refresh = {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId
    };
    const rotated = await json(await form(refresh));
    expect(rotated.access_token).toBeString();
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect((await rpc(rotated.access_token, 'tools/list')).status).toBe(200);

    // Replaying a spent refresh token revokes the whole grant.
    expect((await json(await form(refresh))).error).toBe('invalid_grant');
    expect((await rpc(rotated.access_token, 'tools/list')).status).toBe(401);
    expect(
      (await json(await form({ ...refresh, refresh_token: rotated.refresh_token }))).error
    ).toBe('invalid_grant');

    // The spent code is purged; a second purge finds nothing more to do.
    expect(await purgeConnectorCredentials(pool)).toBeGreaterThan(0);
    expect(await purgeConnectorCredentials(pool)).toBe(0);
  });

  test('two concurrent uses of one refresh token never both rotate it', async () => {
    const { tokens, clientId } = await connect();
    const refresh = {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId
    };
    const answers = await Promise.all([form(refresh), form(refresh)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400]);
    // The second use is a replay: the grant is revoked, tokens issued a moment before included.
    const issued = await json(answers.find((answer) => answer.status === 200)!);
    expect((await rpc(issued.access_token, 'tools/list')).status).toBe(401);
    expect((await rpc(tokens.access_token, 'tools/list')).status).toBe(401);
  });

  test('a wrong verifier gets no token', async () => {
    const client = await json(await register());
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256'
    });
    const cookie = await signIn();
    const consent = await json(
      await handle('/api/connector/authorization', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-officina-request': '1' },
        body: JSON.stringify({ params: Object.fromEntries(query), allow: true })
      })
    );
    const code = new URL(consent.redirect).searchParams.get('code')!;
    const response = await form({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'x'.repeat(43),
      client_id: client.client_id
    });
    expect(response.status).toBe(400);
    expect((await json(response)).error).toBe('invalid_grant');
  });

  test('refusing sends the person back with access_denied', async () => {
    const client = await json(await register());
    const cookie = await signIn();
    const consent = await json(
      await handle('/api/connector/authorization', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-officina-request': '1' },
        body: JSON.stringify({
          params: {
            response_type: 'code',
            client_id: client.client_id,
            redirect_uri: CALLBACK,
            code_challenge: 'a'.repeat(43),
            code_challenge_method: 'S256',
            state: 's'
          },
          allow: false
        })
      })
    );
    expect(new URL(consent.redirect).searchParams.get('error')).toBe('access_denied');
  });

  test('Claude opens a request, sees its inbox and thread, and comments as the member', async () => {
    const { tokens } = await connect();
    const token = tokens.access_token as string;

    const init = await json(await rpc(token, 'initialize', { protocolVersion: '2025-06-18' }));
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'officina' }
    });
    expect(init.result.instructions).toContain('open_request');
    const notified = await handle('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    });
    expect(notified.status).toBe(202);

    const list = await json(await rpc(token, 'tools/list'));
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'list_projects',
      'open_request',
      'whats_waiting_on_me',
      'list_tasks',
      'show_task',
      'answer_question',
      'comment',
      'review'
    ]);
    const open = list.result.tools.find((tool: { name: string }) => tool.name === 'open_request');
    expect(open.inputSchema.required).toEqual(['title', 'request']);
    expect(open.annotations.readOnlyHint).toBe(false);

    expect((await tool(token, 'list_projects')).content[0]!.text).toContain(
      'vici-app (ViciApp/vici-app): your role is owner, so you can see every task in the project, its thread and every decision; open requests;'
    );
    const opened = await tool(token, 'open_request', {
      title: 'Rename the Wager button',
      request: 'It should say Prediction.',
      skip_interview: true
    });
    expect(opened.isError).toBe(false);
    expect(opened.content[0]!.text).toContain(
      `Opened task 1 in vici-app: ${PUBLIC_URL}/tasks/1?project=${seeded.projectId}`
    );

    const inbox = (await tool(token, 'whats_waiting_on_me')).content[0]!.text;
    expect(inbox).toContain('Task 1: Rename the Wager button');
    const shown = (await tool(token, 'show_task', { number: 1 })).content[0]!.text;
    expect(shown).toContain('It should say Prediction.');

    expect((await tool(token, 'comment', { number: 1, text: 'Also in German.' })).isError).toBe(
      false
    );
    expect((await tool(token, 'show_task', { number: 1 })).content[0]!.text).toContain(
      'Antonio: Also in German.'
    );

    const refused = await tool(token, 'review', { number: 1, decision: 'changes' });
    expect(refused).toMatchObject({ isError: true });
    const missing = await tool(token, 'show_task', { number: 99 });
    expect(missing).toMatchObject({ isError: true });
    const invalid = await tool(token, 'show_task', { number: 'one' });
    expect(invalid.isError).toBe(true);
  });

  test('every member sees every task in progress, with who asked and who approves', async () => {
    const owner = (await connect()).tokens.access_token as string;
    await tool(owner, 'open_request', {
      title: 'Rename the Wager button',
      request: 'It should say Prediction.',
      skip_interview: true
    });
    await invite(pool, {
      publicUrl: PUBLIC_URL,
      email: 'tim@example.com',
      name: 'Tim',
      role: 'contributor',
      domains: ['product']
    });
    const tim = (await connect('tim@example.com')).tokens.access_token as string;

    const listed = (await tool(tim, 'list_tasks')).content[0]!.text;
    expect(listed).toContain('1 in progress');
    expect(listed).toContain('Task 1: Rename the Wager button, requested by Antonio.');
    expect((await tool(tim, 'whats_waiting_on_me')).content[0]!.text).not.toContain('Task 1');

    const shown = (await tool(tim, 'show_task', { number: 1 })).content[0]!.text;
    expect(shown).toContain('Requested by Antonio.');
    expect(shown).toContain('Approve the plan: an owner (Antonio).');
    expect(shown).toContain('Merge: a person merges it on GitHub (Antonio).');
  });

  test('a watcher reads but cannot open requests or comment', async () => {
    await invite(pool, {
      publicUrl: PUBLIC_URL,
      email: 'gio@example.com',
      name: 'Gio',
      role: 'watcher',
      domains: []
    });
    const { tokens } = await connect('gio@example.com');
    const opened = await tool(tokens.access_token, 'open_request', {
      title: 'Anything',
      request: 'Anything at all.'
    });
    expect(opened.isError).toBe(true);
    expect(opened.content[0]!.text).toContain('not open requests');
    const commented = await tool(tokens.access_token, 'comment', { number: 1, text: 'Hello.' });
    expect(commented.isError).toBe(true);
    expect(commented.content[0]!.text).toContain('not comment');
  });
});
