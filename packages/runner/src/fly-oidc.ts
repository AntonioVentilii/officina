/*
 * Fly.io workload identity. Every Fly Machine can mint a short-lived OIDC JWT from the local agent
 * socket; the JWT says which org, app and machine is calling (sub = "<org>:<app>:<machine>",
 * iss = https://oidc.fly.io/<org>). Anthropic's workload identity federation exchanges that JWT for
 * a short-lived access token, so no static API key exists in production.
 *
 * Each mint returns a fresh token with its own `jti`, which matters: the federation rule accepts a
 * given assertion only once, and the SDK asks for a new one before every exchange.
 */

const FLY_API_SOCKET = '/.fly/api';
const FLY_OIDC_PATH = 'http://localhost/v1/tokens/oidc';

/** The audience the federation rule expects. */
export const ANTHROPIC_AUDIENCE = 'https://api.anthropic.com';

/** Reads the JWT out of the agent's answer, whether raw, JSON-quoted or wrapped in an object. */
export const parseFlyTokenResponse = (body: string): string => {
  const trimmed = body.trim();
  let token: unknown = trimmed;

  if (trimmed.startsWith('"') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      token =
        typeof parsed === 'string'
          ? parsed
          : ((parsed as { token?: unknown; jwt?: unknown } | null)?.token ??
            (parsed as { jwt?: unknown } | null)?.jwt);
    } catch {
      token = undefined;
    }
  }

  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw new Error('fly oidc: response is not a JWT');
  }
  return token;
};

/** Mints a fresh identity token for this machine. Only works on Fly, which is the point. */
export const mintFlyIdentityToken = async (audience = ANTHROPIC_AUDIENCE): Promise<string> => {
  const response = await fetch(FLY_OIDC_PATH, {
    method: 'POST',
    // Bun-specific: route the request over the agent's unix socket.
    unix: FLY_API_SOCKET,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ aud: audience })
  });
  if (!response.ok) {
    throw new Error(`fly oidc: token request failed (${response.status})`);
  }
  return parseFlyTokenResponse(await response.text());
};
