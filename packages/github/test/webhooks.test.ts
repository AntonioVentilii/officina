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

  test('a pull request closed without a merge is told apart from a merged one', () => {
    expect(
      parseWebhookEvent('pull_request', {
        action: 'closed',
        pull_request: { merged: false, number: 42 },
        repository
      })
    ).toEqual({ kind: 'pull_request_closed', repo: 'ViciApp/vici-app', prNumber: 42 });
    expect(
      parseWebhookEvent('pull_request', {
        action: 'reopened',
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

  test('a failed check suite names the commit it ran on, with or without a pull request', () => {
    for (const pull_requests of [[{ number: 7 }], []])
      expect(
        parseWebhookEvent('check_suite', {
          action: 'completed',
          check_suite: {
            conclusion: 'failure',
            head_sha: 'abc',
            app: { name: 'GitHub Actions' },
            pull_requests
          },
          repository
        })
      ).toEqual({
        kind: 'checks_failed',
        repo: 'ViciApp/vici-app',
        headSha: 'abc',
        details: 'GitHub Actions: failure'
      });
  });

  test('a failed or errored commit status, with what it says and where to look', () => {
    const status = (state: string, extra: Record<string, unknown> = {}) => ({
      sha: 'abc',
      state,
      context: 'vercel',
      repository,
      ...extra
    });
    expect(
      parseWebhookEvent(
        'status',
        status('failure', { description: 'Build failed', target_url: 'https://ci.example/1' })
      )
    ).toEqual({
      kind: 'checks_failed',
      repo: 'ViciApp/vici-app',
      headSha: 'abc',
      details: 'vercel: failure (Build failed) https://ci.example/1'
    });
    expect(parseWebhookEvent('status', status('error'))).toMatchObject({
      details: 'vercel: error'
    });
    expect(parseWebhookEvent('status', status('pending'))).toBeNull();
    expect(parseWebhookEvent('status', status('success'))).toBeNull();
  });

  test("a bot's comment on a pull request, and nobody else's", () => {
    const comment = (type: string, extra: Record<string, unknown> = {}) => ({
      action: 'created',
      issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/x/pulls/7' } },
      comment: {
        id: 31,
        body: 'Two problems found.',
        updated_at: '2026-11-14T10:00:00Z',
        user: { login: 'coderabbitai[bot]', type }
      },
      repository,
      ...extra
    });
    expect(parseWebhookEvent('issue_comment', comment('Bot'))).toEqual({
      kind: 'pull_request_commented',
      repo: 'ViciApp/vici-app',
      prNumber: 7,
      commentId: 31,
      by: 'coderabbitai[bot]',
      body: 'Two problems found.',
      updatedAt: '2026-11-14T10:00:00Z'
    });
    expect(parseWebhookEvent('issue_comment', comment('User'))).toBeNull();
    // A bot editing its placeholder as it works: the edit is read like a new comment.
    expect(parseWebhookEvent('issue_comment', comment('Bot', { action: 'edited' }))).toMatchObject({
      kind: 'pull_request_commented',
      commentId: 31
    });
    expect(parseWebhookEvent('issue_comment', comment('Bot', { action: 'deleted' }))).toBeNull();
    // A comment on an issue, not a pull request.
    expect(parseWebhookEvent('issue_comment', comment('Bot', { issue: { number: 7 } }))).toBeNull();
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

  test('successful, neutral or commit-less check suites and unknown events are ignored', () => {
    const suite = (conclusion: string, head_sha: string | null = 'abc') => ({
      action: 'completed',
      check_suite: { conclusion, head_sha },
      repository
    });
    expect(parseWebhookEvent('check_suite', suite('success'))).toBeNull();
    expect(parseWebhookEvent('check_suite', suite('neutral'))).toBeNull();
    expect(parseWebhookEvent('check_suite', suite('failure', null))).toBeNull();
    expect(parseWebhookEvent('push', { ref: 'refs/tags/v1', repository })).toBeNull();
    expect(parseWebhookEvent('pull_request', 'not an object')).toBeNull();
  });
});
