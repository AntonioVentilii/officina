import { createHash } from 'node:crypto';
import {
  createConnectorCode,
  issueConnectorTokens,
  loadConnectorClient,
  registerConnectorClient,
  spendConnectorCode,
  spendConnectorRefreshToken,
  type ConnectorClient
} from '@officina/db';
import type { Pool } from 'pg';
import { z } from 'zod';

/**
 * Officina is its own OAuth 2.1 authorization server for the connector, as the MCP authorization
 * spec (2025-11-25) and Claude's custom connectors expect: metadata discovery, dynamic client
 * registration, authorization code with PKCE (S256 only), resource indicators, rotating refresh
 * tokens. Signing in is the board's: a person consents on the board while signed in, so the
 * connector acts as an existing member and never creates one.
 */

export const SCOPE = 'officina';
const CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const origin = (publicUrl: string) => publicUrl.replace(/\/$/, '');

/** The connector's address, which is also the `resource` every token is issued for. */
export const mcpResource = (publicUrl: string) => `${origin(publicUrl)}/mcp`;

export const protectedResourceMetadataUrl = (publicUrl: string) =>
  `${origin(publicUrl)}/.well-known/oauth-protected-resource/mcp`;

/** RFC 9728: where clients find the authorization server for `/mcp`. */
export const protectedResourceMetadata = (publicUrl: string) => ({
  resource: mcpResource(publicUrl),
  resource_name: 'Officina',
  authorization_servers: [origin(publicUrl)],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ['header']
});

/** RFC 8414 authorization server metadata. Clients are public: PKCE replaces a client secret. */
export const authorizationServerMetadata = (publicUrl: string) => ({
  issuer: origin(publicUrl),
  authorization_endpoint: `${origin(publicUrl)}/oauth/authorize`,
  token_endpoint: `${origin(publicUrl)}/oauth/token`,
  registration_endpoint: `${origin(publicUrl)}/oauth/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: [SCOPE]
});

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const isLoopback = (url: URL) => url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);

/** Redirects are https, or http on the loopback interface for apps on the person's computer. */
const allowedRedirect = (raw: string): boolean => {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  return !url.hash && (url.protocol === 'https:' || isLoopback(url));
};

/**
 * Exact match, except that a loopback redirect may use any port (RFC 8252, 7.3): a local app picks
 * a free port each time it listens.
 */
const redirectMatches = (registered: readonly string[], requested: string): boolean =>
  registered.some((candidate) => {
    if (candidate === requested) return true;
    if (!URL.canParse(candidate) || !URL.canParse(requested)) return false;
    const a = new URL(candidate);
    const b = new URL(requested);
    if (!isLoopback(a) || !isLoopback(b)) return false;
    a.port = '';
    b.port = '';
    return a.href === b.href;
  });

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400
  ) {
    super(description);
  }

  body() {
    return { error: this.error, error_description: this.description };
  }
}

const registrationSchema = z.object({
  redirect_uris: z.array(z.string().max(2_000)).min(1).max(5),
  client_name: z.string().trim().max(200).optional(),
  token_endpoint_auth_method: z.string().optional()
});

/** RFC 7591 dynamic client registration, for public clients only. */
export const registerClient = async (pool: Pool, body: unknown) => {
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success)
    throw new OAuthError('invalid_client_metadata', 'redirect_uris must list 1 to 5 addresses');
  const input = parsed.data;
  if (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none')
    throw new OAuthError(
      'invalid_client_metadata',
      'only public clients (token_endpoint_auth_method none) are supported'
    );
  const bad = input.redirect_uris.find((uri) => !allowedRedirect(uri));
  if (bad)
    throw new OAuthError(
      'invalid_redirect_uri',
      'redirect URIs must be https, or http on localhost, without a fragment'
    );
  const client = await registerConnectorClient(pool, {
    name: input.client_name || 'An MCP client',
    redirectUris: input.redirect_uris
  });
  return {
    client_id: client.id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client.name,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code']
  };
};

export interface AuthorizationRequest {
  readonly client: ConnectorClient;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly state: string | null;
}

/**
 * Checks an authorization request. Problems with the client or the redirect are shown to the
 * person (`redirectable: false`): sending them to an unverified address would make Officina an
 * open redirect. Anything else goes back to the client as an OAuth error.
 */
export const checkAuthorization = async (
  pool: Pool,
  publicUrl: string,
  query: Record<string, unknown>
): Promise<
  | { ok: true; request: AuthorizationRequest }
  | { ok: false; redirectable: false; message: string }
  | { ok: false; redirectable: true; redirect: string }
> => {
  const value = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : null);
  const clientId = value('client_id');
  const client = clientId ? await loadConnectorClient(pool, clientId) : null;
  if (!client)
    return {
      ok: false,
      redirectable: false,
      message: 'This connector is not registered with Officina; remove it and add it again.'
    };
  const requested = value('redirect_uri');
  const redirectUri =
    requested ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : null);
  if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri))
    return {
      ok: false,
      redirectable: false,
      message: 'The connector asked to return to an address it did not register.'
    };
  const state = value('state');
  const fail = (error: string, description: string) => {
    const url = new URL(redirectUri);
    url.searchParams.set('error', error);
    url.searchParams.set('error_description', description);
    if (state) url.searchParams.set('state', state);
    return { ok: false as const, redirectable: true as const, redirect: url.href };
  };
  if (value('response_type') !== 'code')
    return fail('unsupported_response_type', 'only the code flow is supported');
  const codeChallenge = value('code_challenge');
  if (
    value('code_challenge_method') !== 'S256' ||
    !codeChallenge ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)
  )
    return fail('invalid_request', 'PKCE with code_challenge_method S256 is required');
  const resource = value('resource') ?? mcpResource(publicUrl);
  if (resource.replace(/\/$/, '') !== mcpResource(publicUrl))
    return fail('invalid_target', `this server only issues tokens for ${mcpResource(publicUrl)}`);
  const scope = value('scope');
  if (scope && !scope.split(' ').every((item) => item === SCOPE))
    return fail('invalid_scope', `the only scope is ${SCOPE}`);
  return {
    ok: true,
    request: { client, redirectUri, codeChallenge, resource: mcpResource(publicUrl), state }
  };
};

/** Where the person's browser goes once they allowed or refused the connector. */
export const consentRedirect = async (
  pool: Pool,
  publicUrl: string,
  request: AuthorizationRequest,
  decision: { allow: true; memberId: string } | { allow: false }
): Promise<string> => {
  const url = new URL(request.redirectUri);
  if (decision.allow) {
    const code = await createConnectorCode(
      pool,
      {
        clientId: request.client.id,
        memberId: decision.memberId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        resource: request.resource
      },
      CODE_TTL_MS
    );
    url.searchParams.set('code', code);
  } else {
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'The person did not allow the connector');
  }
  if (request.state) url.searchParams.set('state', request.state);
  url.searchParams.set('iss', origin(publicUrl));
  return url.href;
};

const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

const tokenResponse = (tokens: { accessToken: string; refreshToken: string }) => ({
  access_token: tokens.accessToken,
  token_type: 'Bearer',
  expires_in: ACCESS_TTL_MS / 1000,
  refresh_token: tokens.refreshToken,
  scope: SCOPE
});

/** The token endpoint: an authorization code with its PKCE verifier, or a refresh token. */
export const exchangeToken = async (pool: Pool, publicUrl: string, body: unknown) => {
  const form = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const value = (key: string) => (typeof form[key] === 'string' ? (form[key] as string) : null);
  const clientId = value('client_id');
  if (!clientId || !(await loadConnectorClient(pool, clientId)))
    throw new OAuthError('invalid_client', 'unknown client_id', 401);
  const resource = value('resource');
  if (resource && resource.replace(/\/$/, '') !== mcpResource(publicUrl))
    throw new OAuthError('invalid_target', `tokens are only issued for ${mcpResource(publicUrl)}`);
  const ttl = { accessTtlMs: ACCESS_TTL_MS, refreshTtlMs: REFRESH_TTL_MS };

  switch (value('grant_type')) {
    case 'authorization_code': {
      const code = value('code');
      const verifier = value('code_verifier');
      if (!code || !verifier) throw new OAuthError('invalid_request', 'code and code_verifier');
      const grant = await spendConnectorCode(pool, code, clientId);
      if (
        !grant ||
        grant.codeChallenge !== challengeOf(verifier) ||
        (value('redirect_uri') ?? grant.redirectUri) !== grant.redirectUri
      )
        throw new OAuthError('invalid_grant', 'the code is invalid, spent or expired');
      return tokenResponse(
        await issueConnectorTokens(pool, {
          clientId,
          memberId: grant.memberId,
          resource: grant.resource,
          ...ttl
        })
      );
    }
    case 'refresh_token': {
      const token = value('refresh_token');
      if (!token) throw new OAuthError('invalid_request', 'refresh_token is required');
      const grant = await spendConnectorRefreshToken(pool, token, clientId);
      if (!grant) throw new OAuthError('invalid_grant', 'the refresh token is invalid or spent');
      return tokenResponse(
        await issueConnectorTokens(pool, {
          clientId,
          memberId: grant.memberId,
          resource: grant.resource,
          grantId: grant.grantId,
          ...ttl
        })
      );
    }
    default:
      throw new OAuthError('unsupported_grant_type', 'authorization_code or refresh_token');
  }
};
