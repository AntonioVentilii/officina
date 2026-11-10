import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hashToken, newToken } from './auth';

type Queryable = Pool | PoolClient;

export interface ConnectorClient {
  readonly id: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
}

export const registerConnectorClient = async (
  db: Queryable,
  input: { name: string; redirectUris: readonly string[] }
): Promise<ConnectorClient> => {
  const id = `oc_${randomBytes(18).toString('base64url')}`;
  await db.query('insert into connector_clients (id, name, redirect_uris) values ($1, $2, $3)', [
    id,
    input.name,
    input.redirectUris
  ]);
  return { id, name: input.name, redirectUris: input.redirectUris };
};

export const loadConnectorClient = async (
  db: Queryable,
  id: string
): Promise<ConnectorClient | null> =>
  (
    await db.query<ConnectorClient>(
      `select id, name, redirect_uris as "redirectUris" from connector_clients where id = $1`,
      [id]
    )
  ).rows[0] ?? null;

export interface AuthorizationGrant {
  readonly clientId: string;
  readonly memberId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
}

/** A one-time authorization code for a member's consent; only its hash is stored. */
export const createConnectorCode = async (
  db: Queryable,
  grant: AuthorizationGrant,
  ttlMs: number
): Promise<string> => {
  const code = newToken();
  await db.query(
    `insert into connector_codes
       (code_hash, client_id, member_id, redirect_uri, code_challenge, resource, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
    [
      hashToken(code),
      grant.clientId,
      grant.memberId,
      grant.redirectUri,
      grant.codeChallenge,
      grant.resource,
      ttlMs / 1000
    ]
  );
  return code;
};

/**
 * Spends an authorization code: it works once, before it expires, and only for the client it was
 * issued to. The caller checks the redirect, PKCE verifier and resource against what comes back.
 */
export const spendConnectorCode = async (
  db: Queryable,
  code: string,
  clientId: string
): Promise<AuthorizationGrant | null> =>
  (
    await db.query<AuthorizationGrant>(
      `update connector_codes set used_at = now()
       where code_hash = $1 and client_id = $2 and used_at is null and expires_at > now()
       returning client_id as "clientId", member_id as "memberId", redirect_uri as "redirectUri",
         code_challenge as "codeChallenge", resource`,
      [hashToken(code), clientId]
    )
  ).rows[0] ?? null;

export interface ConnectorTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

/** A fresh access and refresh token for a grant; a new grant when `grantId` is not given. */
export const issueConnectorTokens = async (
  db: Queryable,
  input: {
    clientId: string;
    memberId: string;
    resource: string;
    grantId?: string;
    accessTtlMs: number;
    refreshTtlMs: number;
  }
): Promise<ConnectorTokens> => {
  const grantId = input.grantId ?? randomUUID();
  const accessToken = newToken();
  const refreshToken = newToken();
  await db.query(
    `insert into connector_tokens
       (token_hash, kind, grant_id, client_id, member_id, resource, expires_at)
     values ($1, 'access', $3, $4, $5, $6, now() + make_interval(secs => $7)),
            ($2, 'refresh', $3, $4, $5, $6, now() + make_interval(secs => $8))`,
    [
      hashToken(accessToken),
      hashToken(refreshToken),
      grantId,
      input.clientId,
      input.memberId,
      input.resource,
      input.accessTtlMs / 1000,
      input.refreshTtlMs / 1000
    ]
  );
  return { accessToken, refreshToken };
};

/**
 * Spends a refresh token of the given client. A token presented a second time means it leaked or
 * was replayed, so the whole grant is revoked and both parties must authorize again.
 */
export const spendConnectorRefreshToken = async (
  db: Queryable,
  token: string,
  clientId: string
): Promise<{ grantId: string; memberId: string; resource: string } | null> => {
  const { rows } = await db.query<{
    grantId: string;
    memberId: string;
    resource: string;
    reused: boolean;
  }>(
    `with found as (
       select token_hash, grant_id, member_id, resource, used_at is not null as reused
       from connector_tokens
       where token_hash = $1 and kind = 'refresh' and client_id = $2 and expires_at > now()
     ), spent as (
       update connector_tokens t set used_at = now()
       from found where t.token_hash = found.token_hash and not found.reused
       returning t.token_hash
     )
     select grant_id as "grantId", member_id as "memberId", resource,
       not exists (select 1 from spent) as reused
     from found`,
    [hashToken(token), clientId]
  );
  const found = rows[0];
  if (!found) return null;
  if (found.reused) {
    await db.query('delete from connector_tokens where grant_id = $1', [found.grantId]);
    return null;
  }
  return { grantId: found.grantId, memberId: found.memberId, resource: found.resource };
};

/** The member an access token acts for, when it is live and was issued for `resource`. */
export const memberForConnectorToken = async (
  db: Queryable,
  token: string,
  resource: string
): Promise<string | null> =>
  (
    await db.query<{ member_id: string }>(
      `select member_id from connector_tokens
       where token_hash = $1 and kind = 'access' and resource = $2 and expires_at > now()`,
      [hashToken(token), resource]
    )
  ).rows[0]?.member_id ?? null;

/**
 * Deletes codes and tokens that can no longer be used, and clients that registered but never
 * completed an authorization within a day, since registering needs no account.
 */
export const purgeConnectorCredentials = async (db: Queryable): Promise<number> => {
  const codes = await db.query(
    'delete from connector_codes where expires_at <= now() or used_at is not null'
  );
  const tokens = await db.query(
    `delete from connector_tokens where expires_at <= now()
       or (kind = 'refresh' and used_at < now() - interval '1 day')`
  );
  const clients = await db.query(
    `delete from connector_clients c where c.created_at < now() - interval '1 day'
       and not exists (select 1 from connector_tokens t where t.client_id = c.id)
       and not exists (select 1 from connector_codes k where k.client_id = c.id)`
  );
  return (codes.rowCount ?? 0) + (tokens.rowCount ?? 0) + (clients.rowCount ?? 0);
};
