import { createHmac, timingSafeEqual } from 'node:crypto';

/** Checks GitHub's `X-Hub-Signature-256` header against the raw request body, in constant time. */
export const verifyWebhookSignature = (
  secret: string,
  rawBody: string,
  signatureHeader: string | null
): boolean => {
  if (!secret || !signatureHeader?.startsWith('sha256=')) return false;
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`
  );
  const received = Buffer.from(signatureHeader);
  return expected.length === received.length && timingSafeEqual(expected, received);
};

export type WebhookAction =
  | {
      readonly kind: 'push';
      readonly repo: string;
      /** Branch name, without `refs/heads/`. */
      readonly branch: string;
      readonly changedPaths: readonly string[];
    }
  | { readonly kind: 'pull_request_merged'; readonly repo: string; readonly prNumber: number }
  | {
      /** A review on a pull request that asks for changes, from a bot such as Copilot or a person. */
      readonly kind: 'pull_request_reviewed';
      readonly repo: string;
      readonly prNumber: number;
      readonly reviewId: number;
      readonly commitId: string;
      readonly by: string;
      readonly bot: boolean;
      readonly state: 'commented' | 'changes_requested';
      readonly body: string;
    }
  | {
      readonly kind: 'checks_failed';
      readonly repo: string;
      readonly prNumbers: readonly number[];
      readonly details: string;
    };

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);

interface RepoPayload {
  repository?: { full_name?: string };
}

/**
 * Reduces a GitHub delivery to the few things the engine acts on. Everything else returns `null`
 * and is acknowledged without effect.
 */
export const parseWebhookEvent = (event: string | null, payload: unknown): WebhookAction | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const repo = (payload as RepoPayload).repository?.full_name;
  if (!repo) return null;

  if (event === 'pull_request') {
    const body = payload as {
      action?: string;
      pull_request?: { merged?: boolean; number?: number };
    };
    if (
      body.action === 'closed' &&
      body.pull_request?.merged === true &&
      body.pull_request.number
    ) {
      return { kind: 'pull_request_merged', repo, prNumber: body.pull_request.number };
    }
    return null;
  }

  if (event === 'push') {
    const body = payload as {
      ref?: string;
      commits?: { added?: string[]; modified?: string[]; removed?: string[] }[];
    };
    if (!body.ref?.startsWith('refs/heads/')) return null;
    const changedPaths = [
      ...new Set(
        (body.commits ?? []).flatMap((commit) => [
          ...(commit.added ?? []),
          ...(commit.modified ?? []),
          ...(commit.removed ?? [])
        ])
      )
    ];
    return { kind: 'push', repo, branch: body.ref.slice('refs/heads/'.length), changedPaths };
  }

  if (event === 'pull_request_review') {
    const body = payload as {
      action?: string;
      review?: {
        id?: number;
        state?: string;
        body?: string | null;
        commit_id?: string;
        user?: { login?: string; type?: string };
      };
      pull_request?: { number?: number };
    };
    const review = body.review;
    // Approvals and dismissals ask for nothing; only a review that may want changes is acted on.
    if (body.action !== 'submitted' || !review?.id || !review.commit_id || !review.user?.login)
      return null;
    const state = review.state?.toLowerCase();
    if (state !== 'commented' && state !== 'changes_requested') return null;
    if (!body.pull_request?.number) return null;
    return {
      kind: 'pull_request_reviewed',
      repo,
      prNumber: body.pull_request.number,
      reviewId: review.id,
      commitId: review.commit_id,
      by: review.user.login,
      bot: review.user.type === 'Bot',
      state,
      body: review.body ?? ''
    };
  }

  if (event === 'check_suite') {
    const body = payload as {
      action?: string;
      check_suite?: {
        conclusion?: string | null;
        app?: { name?: string };
        pull_requests?: { number: number }[];
      };
    };
    const suite = body.check_suite;
    if (body.action !== 'completed' || !suite?.conclusion) return null;
    if (!FAILED_CONCLUSIONS.has(suite.conclusion)) return null;
    const prNumbers = (suite.pull_requests ?? []).map((pr) => pr.number);
    if (prNumbers.length === 0) return null;
    return {
      kind: 'checks_failed',
      repo,
      prNumbers,
      details: `${suite.app?.name ?? 'checks'}: ${suite.conclusion}`
    };
  }

  return null;
};
