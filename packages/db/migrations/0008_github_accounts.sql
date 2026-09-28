-- A member's own GitHub account, linked through the GitHub App's user authorization. Tokens are
-- stored encrypted by the API; the database alone never yields a usable token.
create table github_accounts (
  member_id uuid primary key references members (id) on delete cascade,
  github_user_id bigint not null unique,
  login text not null,
  access_token_enc text not null,
  access_expires_at timestamptz,
  refresh_token_enc text,
  refresh_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

-- One-time OAuth round trips. A state is bound to the browser that started it and, when linking,
-- to the member who was signed in.
create table oauth_states (
  state_hash text primary key,
  member_id uuid references members (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
