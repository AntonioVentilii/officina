-- Officina as an OAuth 2.1 authorization server for its connector, so a member can add Officina
-- to Claude and act as themselves from chat. Clients register themselves (dynamic client
-- registration); codes and tokens are stored only as hashes, like sign-in links and sessions.
create table connector_clients (
  id text primary key,
  name text not null,
  redirect_uris text[] not null,
  created_at timestamptz not null default now()
);

-- One authorization code per consent, spent once, bound to the client, the redirect, the PKCE
-- challenge and the resource it was asked for.
create table connector_codes (
  code_hash text primary key,
  client_id text not null references connector_clients (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  resource text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Access and refresh tokens. A refresh token is spent when used and replaced (rotation), and every
-- token of one grant shares `grant_id`, so a replayed refresh token revokes the whole grant.
create table connector_tokens (
  token_hash text primary key,
  kind text not null check (kind in ('access', 'refresh')),
  grant_id uuid not null,
  client_id text not null references connector_clients (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  resource text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index connector_tokens_by_grant on connector_tokens (grant_id);
