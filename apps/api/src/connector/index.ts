import { listMemberProjects, loadSessionMember, memberForConnectorToken } from '@officina/db';
import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { version } from '../../../../package.json';
import { handleMcp, PROTOCOL_VERSIONS } from './mcp';
import {
  authorizationServerMetadata,
  checkAuthorization,
  exchangeToken,
  mcpResource,
  OAuthError,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  registerClient,
  SCOPE
} from './oauth';

export { checkAuthorization, consentRedirect, LOOPBACK_HOSTS } from './oauth';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
  });

const oauthFailure = (error: unknown) => {
  if (error instanceof OAuthError) return json(error.status, error.body());
  throw error;
};

/**
 * The connector for Claude: OAuth discovery, client registration, the authorization redirect, the
 * token endpoint and the MCP endpoint itself. The consent step needs the board's session, so it
 * lives with the board API (`/api/connector/authorization`).
 */
export const createConnector = (deps: { pool: Pool; publicUrl: string }) => {
  const { pool, publicUrl } = deps;
  const resource = mcpResource(publicUrl);
  const board = publicUrl.replace(/\/$/, '');

  const unauthorized = (invalid: boolean) =>
    json(
      401,
      { error: invalid ? 'invalid_token' : 'unauthorized' },
      {
        'www-authenticate': `Bearer resource_metadata="${protectedResourceMetadataUrl(publicUrl)}", scope="${SCOPE}"${invalid ? ', error="invalid_token"' : ''}`
      }
    );

  const methodNotAllowed = () => json(405, { error: 'use POST' }, { allow: 'POST' });

  return (
    new Elysia()
      .get('/.well-known/oauth-protected-resource', () => protectedResourceMetadata(publicUrl))
      .get('/.well-known/oauth-protected-resource/mcp', () => protectedResourceMetadata(publicUrl))
      .get('/.well-known/oauth-authorization-server', () => authorizationServerMetadata(publicUrl))
      .post('/oauth/register', async ({ body }) => {
        try {
          return json(201, await registerClient(pool, body));
        } catch (error) {
          return oauthFailure(error);
        }
      })
      // Checked here so a bad client or redirect is shown before anyone signs in; the board's
      // consent page checks it again when the person decides.
      .get('/oauth/authorize', async ({ request, query }) => {
        const checked = await checkAuthorization(pool, publicUrl, query);
        if (!checked.ok && !checked.redirectable)
          return Response.redirect(
            `${board}/connect?error=${encodeURIComponent(checked.message)}`,
            302
          );
        if (!checked.ok) return Response.redirect(checked.redirect, 302);
        return Response.redirect(`${board}/connect${new URL(request.url).search}`, 302);
      })
      .post('/oauth/token', async ({ body }) => {
        try {
          return json(200, await exchangeToken(pool, publicUrl, body));
        } catch (error) {
          return oauthFailure(error);
        }
      })
      .get('/mcp', methodNotAllowed)
      .delete('/mcp', methodNotAllowed)
      .post(
        '/mcp',
        async ({ request }) => {
          const header = request.headers.get('authorization');
          const token = header?.match(/^Bearer (\S+)$/i)?.[1];
          if (!token) return unauthorized(false);
          const memberId = await memberForConnectorToken(pool, token, resource);
          if (!memberId) return unauthorized(true);

          let message: unknown;
          try {
            message = JSON.parse(await request.text());
          } catch {
            return json(400, {
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'invalid JSON' }
            });
          }
          const asked = request.headers.get('mcp-protocol-version');
          const initializing =
            Boolean(message) &&
            typeof message === 'object' &&
            (message as { method?: unknown }).method === 'initialize';
          if (asked && !initializing && !(PROTOCOL_VERSIONS as readonly string[]).includes(asked))
            return json(400, {
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32600,
                message: `unsupported protocol version ${asked}`,
                data: { supported: PROTOCOL_VERSIONS }
              }
            });

          const reply = await handleMcp(
            message,
            async () => {
              const member = await loadSessionMember(pool, memberId);
              if (!member) throw new Error('the member behind a live token is gone');
              return {
                pool,
                publicUrl,
                memberId,
                workspaceId: member.workspaceId,
                projects: await listMemberProjects(pool, memberId)
              };
            },
            version
          );
          return reply.status === 202
            ? new Response(null, { status: 202 })
            : json(reply.status, reply.body);
        },
        { parse: 'none' }
      )
  );
};
