import Anthropic from '@anthropic-ai/sdk';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';
import { TokenCache } from '@anthropic-ai/sdk/lib/credentials/token-cache';
import { mintFlyIdentityToken } from './fly-oidc';

export interface FederationSettings {
  readonly ruleId: string;
  readonly organizationId: string;
  readonly serviceAccountId: string;
  readonly workspaceId?: string;
}

export type AnthropicAuth =
  | { readonly kind: 'federation'; readonly federation: FederationSettings }
  | { readonly kind: 'api_key'; readonly apiKey: string };

/**
 * Chooses how to authenticate: workload identity federation when its identifiers are configured
 * (production on Fly, no stored key), otherwise an API key (local development or any non-Fly host).
 */
export const anthropicAuthFrom = (
  env: Readonly<Partial<Record<string, string>>>
): AnthropicAuth | null => {
  const { ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID, ANTHROPIC_SERVICE_ACCOUNT_ID } =
    env;
  if (ANTHROPIC_FEDERATION_RULE_ID && ANTHROPIC_ORGANIZATION_ID && ANTHROPIC_SERVICE_ACCOUNT_ID) {
    return {
      kind: 'federation',
      federation: {
        ruleId: ANTHROPIC_FEDERATION_RULE_ID,
        organizationId: ANTHROPIC_ORGANIZATION_ID,
        serviceAccountId: ANTHROPIC_SERVICE_ACCOUNT_ID,
        ...(env.ANTHROPIC_WORKSPACE_ID ? { workspaceId: env.ANTHROPIC_WORKSPACE_ID } : {})
      }
    };
  }
  return env.ANTHROPIC_API_KEY ? { kind: 'api_key', apiKey: env.ANTHROPIC_API_KEY } : null;
};

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

const CLIENT_OPTIONS = { maxRetries: 2, timeout: 120_000 } as const;

/**
 * A federated client: the SDK swaps a fresh Fly identity token for a short-lived access token,
 * caches it, and refreshes it before it expires by minting another identity token.
 */
export const createFederatedClient = (
  federation: FederationSettings,
  onRefreshError: (error: unknown) => void = () => {}
): Anthropic => {
  const exchange = oidcFederationProvider({
    identityTokenProvider: () => mintFlyIdentityToken(),
    federationRuleId: federation.ruleId,
    organizationId: federation.organizationId,
    serviceAccountId: federation.serviceAccountId,
    ...(federation.workspaceId ? { workspaceId: federation.workspaceId } : {}),
    baseURL: ANTHROPIC_BASE_URL,
    fetch
  });
  const cache = new TokenCache(exchange, onRefreshError);
  return new Anthropic({
    credentials: async () => ({ token: await cache.getToken(), expiresAt: null }),
    ...CLIENT_OPTIONS
  });
};

export const createAnthropicClient = (
  auth: AnthropicAuth,
  onRefreshError?: (error: unknown) => void
): Anthropic =>
  auth.kind === 'federation'
    ? createFederatedClient(auth.federation, onRefreshError)
    : new Anthropic({ apiKey: auth.apiKey, ...CLIENT_OPTIONS });
