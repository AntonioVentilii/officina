import { describe, expect, test } from 'bun:test';
import { parseWebhookEvent, verifyWebhookSignature } from '../src';

describe('webhook signatures', () => {
  // The example published in GitHub's "Validating webhook deliveries" documentation.
  const secret = "It's a Secret to Everybody";
  const body = 'Hello, World!';
  const signature = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

  test('accepts the documented example', () => {
    expect(verifyWebhookSignature(secret, body, signature)).toBe(true);
  });

  test('rejects a tampered body, a wrong secret, a missing or malformed header', () => {
    expect(verifyWebhookSignature(secret, 'Hello, World?', signature)).toBe(false);
    expect(verifyWebhookSignature('other', body, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, body, null)).toBe(false);
    expect(verifyWebhookSignature(secret, body, signature.replace('sha256=', 'sha1='))).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha256=00')).toBe(false);
    expect(verifyWebhookSignature('', body, signature)).toBe(false);
  });
});

describe('webhook events', () => {
  const repository = { full_name: 'ViciApp/vici-app' };

  test('a merged pull request', () => {
    expect(
      parseWebhookEvent('pull_request', {
        action: 'closed',
        pull_request: { merged: true, number: 42 },
        repository
      })
    ).toEqual({ kind: 'pull_request_merged', repo: 'ViciApp/vici-app', prNumber: 42 });
  });

  test('a closed but unmerged pull request is ignored', () => {
    expect(
      parseWebhookEvent('pull_request', {
        action: 'closed',
        pull_request: { merged: false, number: 42 },
        repository
      })
    ).toBeNull();
  });

  test('a branch push lists the changed paths once', () => {
    expect(
      parseWebhookEvent('push', {
        ref: 'refs/heads/main',
        commits: [
          { added: ['a.ts'], modified: ['.github/officina.yml'], removed: [] },
          { modified: ['.github/officina.yml'] }
        ],
        repository
      })
    ).toEqual({
      kind: 'push',
      repo: 'ViciApp/vici-app',
      branch: 'main',
      changedPaths: ['a.ts', '.github/officina.yml']
    });
  });

  test('a failed check suite on pull requests', () => {
    expect(
      parseWebhookEvent('check_suite', {
        action: 'completed',
        check_suite: {
          conclusion: 'failure',
          app: { name: 'GitHub Actions' },
          pull_requests: [{ number: 7 }]
        },
        repository
      })
    ).toEqual({
      kind: 'checks_failed',
      repo: 'ViciApp/vici-app',
      prNumbers: [7],
      details: 'GitHub Actions: failure'
    });
  });

  test('a submitted review that may want changes, with who left it', () => {
    const review = (state: string, type = 'Bot', association = 'NONE') => ({
      action: 'submitted',
      review: {
        id: 11,
        state,
        body: 'Pull request overview',
        commit_id: 'abc',
        author_association: association,
        user: { login: 'copilot-pull-request-reviewer[bot]', type }
      },
      pull_request: { number: 7 },
      repository
    });
    expect(parseWebhookEvent('pull_request_review', review('commented'))).toEqual({
      kind: 'pull_request_reviewed',
      repo: 'ViciApp/vici-app',
      prNumber: 7,
      reviewId: 11,
      commitId: 'abc',
      by: 'copilot-pull-request-reviewer[bot]',
      bot: true,
      state: 'commented',
      body: 'Pull request overview'
    });
    expect(
      parseWebhookEvent('pull_request_review', review('changes_requested', 'User', 'COLLABORATOR'))
    ).toMatchObject({ bot: false, state: 'changes_requested' });
    // A stranger's review on a public repository must not become the builder's brief.
    for (const association of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', undefined])
      expect(
        parseWebhookEvent('pull_request_review', review('changes_requested', 'User', association))
      ).toBeNull();
    expect(parseWebhookEvent('pull_request_review', review('approved'))).toBeNull();
    expect(
      parseWebhookEvent('pull_request_review', { ...review('commented'), action: 'dismissed' })
    ).toBeNull();
  });

  test('successful, neutral or PR-less check suites and unknown events are ignored', () => {
    const suite = (conclusion: string, pull_requests = [{ number: 7 }]) => ({
      action: 'completed',
      check_suite: { conclusion, pull_requests },
      repository
    });
    expect(parseWebhookEvent('check_suite', suite('success'))).toBeNull();
    expect(parseWebhookEvent('check_suite', suite('neutral'))).toBeNull();
    expect(parseWebhookEvent('check_suite', suite('failure', []))).toBeNull();
    expect(parseWebhookEvent('push', { ref: 'refs/tags/v1', repository })).toBeNull();
    expect(parseWebhookEvent('pull_request', 'not an object')).toBeNull();
  });
});
