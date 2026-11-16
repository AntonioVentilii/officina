-- A spent authorization code remembers the grant it opened, so the code presented again ends that
-- grant, as a spent refresh token does (RFC 6749, 4.1.2).
alter table connector_codes add column grant_id uuid;
