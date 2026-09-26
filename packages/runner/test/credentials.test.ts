import { describe, expect, test } from 'bun:test';
import { anthropicAuthFrom, parseFlyTokenResponse } from '../src';

const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ2aWNpOnZpY2ktb2ZmaWNpbmE6bTEifQ.c2ln';

const federation = {
  ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_1',
  ANTHROPIC_ORGANIZATION_ID: 'org_1',
  ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_1'
};

describe('anthropic credentials', () => {
  test('federation wins over an API key when its identifiers are complete', () => {
    expect(anthropicAuthFrom({ ...federation, ANTHROPIC_API_KEY: 'sk-test' })).toEqual({
      kind: 'federation',
      federation: { ruleId: 'fdrl_1', organizationId: 'org_1', serviceAccountId: 'svac_1' }
    });
  });

  test('the workspace is passed through when set', () => {
    const auth = anthropicAuthFrom({ ...federation, ANTHROPIC_WORKSPACE_ID: 'wrkspc_1' });
    expect(auth).toMatchObject({ federation: { workspaceId: 'wrkspc_1' } });
  });

  test('incomplete federation identifiers fall back to the API key', () => {
    expect(
      anthropicAuthFrom({
        ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_1',
        ANTHROPIC_API_KEY: 'sk-test'
      })
    ).toEqual({ kind: 'api_key', apiKey: 'sk-test' });
  });

  test('no credentials at all is null, so the engine stays off', () => {
    expect(anthropicAuthFrom({})).toBeNull();
  });
});

describe('fly identity tokens', () => {
  test('accepts the raw JWT, a JSON-quoted one and a token object', () => {
    expect(parseFlyTokenResponse(jwt)).toBe(jwt);
    expect(parseFlyTokenResponse(`${jwt}\n`)).toBe(jwt);
    expect(parseFlyTokenResponse(JSON.stringify(jwt))).toBe(jwt);
    expect(parseFlyTokenResponse(JSON.stringify({ token: jwt }))).toBe(jwt);
  });

  test('rejects anything that is not a JWT', () => {
    expect(() => parseFlyTokenResponse('nope')).toThrow('not a JWT');
    expect(() => parseFlyTokenResponse('{"error":"x"}')).toThrow('not a JWT');
    expect(() => parseFlyTokenResponse('{not json')).toThrow('not a JWT');
  });
});
