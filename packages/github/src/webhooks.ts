import { statusFailure, suiteFailure, type CheckSuite, type CommitStatus } from './checks';
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
  /** Closed without being merged; a reopened one comes back as a new pull request. */
  | { readonly kind: 'pull_request_closed'; readonly repo: string; readonly prNumber: number }
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
      /** A comment on a pull request's conversation by a bot, such as a review action's summary. */
      readonly kind: 'pull_request_commented';
      readonly repo: string;
      readonly prNumber: number;
      readonly commentId: number;
      readonly by: string;
      readonly body: string;
    }
  | {
      /** A check suite or a commit status failed on a commit, whichever branch holds it. */
      readonly kind: 'checks_failed';
      readonly repo: string;
      readonly headSha: string;
      readonly details: string;
    };

const COMMENT_ACTIONS: ReadonlySet<string> = new Set(['created', 'edited']);
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

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
    if (body.action !== 'closed' || !body.pull_request?.number) return null;
    return {
      kind: body.pull_request.merged === true ? 'pull_request_merged' : 'pull_request_closed',
      repo,
      prNumber: body.pull_request.number
    };
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
        author_association?: string;
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
    const bot = review.user.type === 'Bot';
    // Anyone on GitHub can review a pull request on a public repository, and a review becomes the
    // builder's next brief. Only people who already hold standing on the repository may steer it; a
    // bot can only review where an admin installed it.
    if (!bot && !TRUSTED_ASSOCIATIONS.has(review.author_association ?? '')) return null;
    return {
      kind: 'pull_request_reviewed',
      repo,
      prNumber: body.pull_request.number,
      reviewId: review.id,
      commitId: review.commit_id,
      by: review.user.login,
      bot,
      state,
      body: review.body ?? ''
    };
  }

  if (event === 'issue_comment') {
    const body = payload as {
      action?: string;
      issue?: { number?: number; pull_request?: unknown };
      comment?: { id?: number; body?: string | null; user?: { login?: string; type?: string } };
    };
    const comment = body.comment;
    // A person's comment may only be a question; what a person wants changed comes as a review.
    // An edit counts like a new comment: bots post a placeholder and edit it as they work.
    if (!COMMENT_ACTIONS.has(body.action ?? '') || !body.issue?.pull_request || !body.issue.number)
      return null;
    if (!comment?.id || !comment.user?.login || comment.user.type !== 'Bot') return null;
    return {
      kind: 'pull_request_commented',
      repo,
      prNumber: body.issue.number,
      commentId: comment.id,
      by: comment.user.login,
      body: comment.body ?? ''
    };
  }

  // Found by the commit rather than by pull request: a suite started by a push to the task branch
  // lists no pull request, and a commit status never does.
  if (event === 'check_suite') {
    const body = payload as {
      action?: string;
      check_suite?: CheckSuite & { head_sha?: string };
    };
    const suite = body.check_suite;
    if (body.action !== 'completed' || !suite?.head_sha) return null;
    const details = suiteFailure(suite);
    return details ? { kind: 'checks_failed', repo, headSha: suite.head_sha, details } : null;
  }

  if (event === 'status') {
    const body = payload as CommitStatus & { sha?: string };
    const details = body.sha ? statusFailure(body) : null;
    return details && body.sha ? { kind: 'checks_failed', repo, headSha: body.sha, details } : null;
  }

  return null;
};
