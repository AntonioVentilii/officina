import { branchForTask, ENGINE, parseProjectConfig, taskUrl, type Actor } from '@officina/core';
import {
  appendTaskEvent,
  autoVerified,
  expectedHead,
  forwardedReviewIds,
  handedToGitHub,
  hasEventSinceMerging,
  hasTaskEvent,
  githubLoginOf,
  latestVerifier,
  listStaleAutoMerges,
  loadTask,
  loadTaskContext
} from '@officina/db';
import {
  COPILOT_REVIEWERS,
  type GitHubAsUser,
  type GitHubClient,
  type RepoRef
} from '@officina/github';
import type { Pool } from 'pg';
import { cancelTaskAutoMerge } from './auto-merge';
import { hasPendingBotComments } from './github-feedback';

/**
 * A markdown link to a task. A bare `#N` would link the repository's issue or pull request N.
 */
export const taskLink = (publicUrl: string, projectId: string, taskNumber: number) =>
  `[Officina task ${taskNumber}](${taskUrl(publicUrl, projectId, taskNumber)})`;

/** Acting on GitHub as a member (the verifier, the requester), with their own linked account. */
export interface OnBehalf {
  readonly publicUrl: string;
  /** The member's token, login and GitHub's stable user id, which survives a renamed login. */
  tokenFor(memberId: string): Promise<{ token: string; login: string; userId: number } | null>;
  readonly asUser: Pick<
    GitHubAsUser,
    'pullRequest' | 'reviews' | 'approve' | 'mergeWhenReady' | 'requestCopilotReview'
  >;
}

/** The member whose approval passed the verification, with a usable token of their own. */
const verifierAccount = async (
  pool: Pool,
  onBehalf: OnBehalf,
  taskId: string
): Promise<{ actor: Actor; token: string; login: string } | null> => {
  const verifier = await latestVerifier(pool, taskId);
  if (!verifier) return null;
  const account = await onBehalf.tokenFor(verifier);
  return account ? { actor: { kind: 'member', memberId: verifier }, ...account } : null;
};

/**
 * The verifier's account to approve as. The verifier is read outside the failure path, so only a
 * token refresh GitHub refuses is recorded (once, so it is not retried every pass) and gives none.
 */
const approvingAccount = async (pool: Pool, onBehalf: OnBehalf, taskId: string) => {
  const verifier = await latestVerifier(pool, taskId);
  if (!verifier) return null;
  const actor: Actor = { kind: 'member', memberId: verifier };
  try {
    const linked = await onBehalf.tokenFor(verifier);
    return linked ? { actor, ...linked } : null;
  } catch (error) {
    await appendTaskEvent(pool, {
      taskId,
      actor,
      type: 'github_approval_failed',
      payload: {
        login: (await githubLoginOf(pool, verifier)) ?? 'unknown',
        error: (error as Error).message.slice(0, 500)
      }
    });
    return null;
  }
};

/**
 * Approves exactly the verified head as the member, unless their approval of it is already on
 * GitHub: an approval whose record was lost (the process died, or the write failed, right after
 * GitHub took it) must not be sent twice.
 */
const approveOnce = async (
  onBehalf: OnBehalf,
  account: { token: string; login: string; userId: number },
  input: { repo: string; pullRequest: number; headSha: string; body: string }
) => {
  const reviews = await onBehalf.asUser.reviews(account.token, input.repo, input.pullRequest);
  // The member's latest review of this head is what stands: an approval later followed by a
  // request for changes is not one. Comments change nothing, so they are left out.
  const latest = reviews
    .filter(
      (review) =>
        review.userId === account.userId &&
        review.commitId === input.headSha &&
        review.state !== 'COMMENTED'
    )
    .at(-1);
  if (latest?.state === 'APPROVED') return;
  await onBehalf.asUser.approve(
    account.token,
    input.repo,
    input.pullRequest,
    input.headSha,
    input.body
  );
};

/**
 * Once a task is verified and its spec marked Implemented, approves the pull request on GitHub as
 * the member whose approval passed the gate, so their check counts as a review there. Without that
 * member's linked account nothing happens. It is tried once; a failure is recorded. The approval is
 * recorded outside the failure path: a record that fails is tried again on the next pass, which
 * finds the approval already on GitHub and records it without approving again.
 */
export const approveOnGitHub = async (
  pool: Pool,
  onBehalf: OnBehalf,
  input: {
    taskId: string;
    projectId: string;
    taskNumber: number;
    repo: string;
    pullRequest: number;
  }
) => {
  // Once per time the task reaches merging: a fix round after a GitHub review needs a new approval.
  if (await hasEventSinceMerging(pool, input.taskId, ['github_approved', 'github_approval_failed']))
    return;
  const account = await approvingAccount(pool, onBehalf, input.taskId);
  if (!account) return;
  const { actor } = account;
  let approvedHead: string;
  try {
    const pr = await onBehalf.asUser.pullRequest(account.token, input.repo, input.pullRequest);
    if (pr.merged || pr.state !== 'open') return;
    const expected = await expectedHead(pool, input.taskId);
    // Someone pushed after the verification: approving now would put the member's name on a
    // commit they never checked.
    if (pr.head.sha !== expected) {
      await appendTaskEvent(pool, {
        taskId: input.taskId,
        actor,
        type: 'github_approval_failed',
        payload: {
          login: account.login,
          error: `the pull request head ${pr.head.sha.slice(0, 7)} is not the verified ${expected?.slice(0, 7) ?? 'head'}`,
          expectedHead: expected,
          actualHead: pr.head.sha
        }
      });
      return;
    }
    await approveOnce(onBehalf, account, {
      repo: input.repo,
      pullRequest: input.pullRequest,
      headSha: expected,
      body: `Verified in ${taskLink(onBehalf.publicUrl, input.projectId, input.taskNumber)}.`
    });
    approvedHead = expected;
  } catch (error) {
    await appendTaskEvent(pool, {
      taskId: input.taskId,
      actor,
      type: 'github_approval_failed',
      payload: { login: account.login, error: (error as Error).message.slice(0, 500) }
    });
    return;
  }
  await appendTaskEvent(pool, {
    taskId: input.taskId,
    actor,
    type: 'github_approved',
    payload: { login: account.login, headSha: approvedHead }
  });
};

/**
 * Asks Copilot to review a pull request Officina opened, as the member who requested the task:
 * the App has no Copilot seat, so a branch rule asking for Copilot's review does not start it on the
 * App's pull requests. Tried once per pull request: a review Copilot already left there (asked by
 * an earlier attempt whose record was lost) is recorded instead of asking again, and one still
 * pending answers `already_pending`. Nothing here blocks the task: without the
 * member's linked account, or when GitHub refuses (no seat, no quota), the failure is recorded and
 * the task goes on.
 */
export const askCopilotToReview = async (
  pool: Pool,
  onBehalf: OnBehalf | undefined,
  input: { taskId: string; requesterId: string; repo: string; pullRequest: number }
) => {
  const ofThisPullRequest = { pullRequest: input.pullRequest };
  for (const type of ['github_copilot_review_requested', 'github_copilot_review_failed']) {
    if (await hasTaskEvent(pool, input.taskId, type, ofThisPullRequest)) return;
  }
  const requester: Actor = { kind: 'member', memberId: input.requesterId };
  const failed = (actor: Actor, login: string | null, error: string) =>
    appendTaskEvent(pool, {
      taskId: input.taskId,
      actor,
      type: 'github_copilot_review_failed',
      payload: { pullRequest: input.pullRequest, login, error: error.slice(0, 500) }
    });
  let account: { token: string; login: string } | null = null;
  try {
    account = onBehalf ? await onBehalf.tokenFor(input.requesterId) : null;
  } catch (error) {
    await failed(ENGINE, null, (error as Error).message);
    return;
  }
  if (!onBehalf || !account) {
    await failed(
      ENGINE,
      null,
      onBehalf
        ? 'the requester has not connected GitHub, or their GitHub authorization expired'
        : 'connecting GitHub accounts is not set up on this server'
    );
    return;
  }
  const { token } = account;
  try {
    const reviewed = (await onBehalf.asUser.reviews(token, input.repo, input.pullRequest)).some(
      (review) => COPILOT_REVIEWERS.has(review.login)
    );
    const outcome = reviewed
      ? 'already_reviewed'
      : await onBehalf.asUser.requestCopilotReview(token, input.repo, input.pullRequest);
    await appendTaskEvent(pool, {
      taskId: input.taskId,
      actor: requester,
      type: 'github_copilot_review_requested',
      payload: { pullRequest: input.pullRequest, login: account.login, outcome }
    });
  } catch (error) {
    await failed(requester, account.login, (error as Error).message);
  }
};

/**
 * Asks Copilot to review the linked pull request of each task whose project sets
 * `pull_request.copilot_review`, when no attempt is recorded for it yet. Run on every scheduler
 * pass rather than right after the pull request is opened, so one opened just before a crash is
 * still asked for.
 */
export const requestCopilotReviews = async (
  pool: Pool,
  taskIds: readonly string[],
  onBehalf?: OnBehalf
) => {
  for (const taskId of taskIds) {
    const context = await loadTaskContext(pool, taskId);
    if (!context?.pullRequest) continue;
    const config = parseProjectConfig(context.rawConfig);
    if (!config.ok || !config.config.pullRequest.copilotReview) continue;
    await askCopilotToReview(pool, onBehalf, {
      taskId,
      requesterId: context.task.requesterId,
      repo: context.repo,
      pullRequest: context.pullRequest
    });
  }
};

export type SyncGitHubPort = Pick<
  GitHubClient,
  | 'readFile'
  | 'updateFile'
  | 'pushFacts'
  | 'commitChanges'
  | 'commentOnIssue'
  | 'mergeWhenReady'
  | 'cancelAutoMerge'
  | 'pullRequest'
  | 'resolveReviewThreads'
>;

/**
 * Resolves the pull request threads of the GitHub reviews that were sent back to the builder, once
 * per time the task reaches merging: by then the fixes were reviewed again and verified.
 */
const resolveForwardedThreads = async (
  pool: Pool,
  github: SyncGitHubPort,
  input: { taskId: string; ref: RepoRef; pullRequest: number }
) => {
  if (await hasEventSinceMerging(pool, input.taskId, ['github_threads_resolved'])) return;
  const reviewIds = await forwardedReviewIds(pool, input.taskId);
  if (reviewIds.length === 0) return;
  const resolved = await github.resolveReviewThreads({
    ...input.ref,
    pullRequest: input.pullRequest,
    reviewIds
  });
  await appendTaskEvent(pool, {
    taskId: input.taskId,
    actor: ENGINE,
    type: 'github_threads_resolved',
    payload: { reviewIds, resolved }
  });
};

/**
 * Records that the pull request holds a commit nobody verified, once per such head: it must not be
 * merged until the commits are reviewed, and any auto-merge is turned off (`cancelStaleAutoMerges`).
 */
const holdMerge = async (
  pool: Pool,
  input: { taskId: string; pullRequest: number; head: string }
) => {
  if (await hasTaskEvent(pool, input.taskId, 'merge_held', { headSha: input.head })) return;
  await appendTaskEvent(pool, {
    taskId: input.taskId,
    actor: ENGINE,
    type: 'merge_held',
    payload: { pullRequest: input.pullRequest, headSha: input.head }
  });
};

/**
 * Records, once per time the task reaches merging, that the engine's part is over and GitHub will
 * not merge on its own: the pull request waits for a person to merge it. The board and the
 * timeline say whose turn it is from this.
 */
const awaitMerge = async (pool: Pool, input: { taskId: string; pullRequest: number }) => {
  if (await hasEventSinceMerging(pool, input.taskId, ['awaiting_merge'])) return;
  await appendTaskEvent(pool, {
    taskId: input.taskId,
    actor: ENGINE,
    type: 'awaiting_merge',
    payload: { pullRequest: input.pullRequest }
  });
};

/**
 * Turns on GitHub's auto-merge, pinned to the verified head, so checks, resolved threads and any
 * required review still decide when it lands: as the verifier, or as the App for a result that
 * skipped people's verification. Tried once per time the task reaches merging. A failure may
 * still have turned it on (the request reached GitHub but the answer did not), so it is recorded
 * as unsettled and `cancelStaleAutoMerges` turns it off before a person is asked to merge.
 */
const autoMergeOnGitHub = async (
  pool: Pool,
  input: { taskId: string; actor: Actor; merge: () => Promise<'auto_merge' | 'merged'> }
) => {
  if (
    await hasEventSinceMerging(pool, input.taskId, [
      'github_auto_merge',
      'github_auto_merge_failed'
    ])
  )
    return;
  try {
    const merge = await input.merge();
    await appendTaskEvent(pool, {
      taskId: input.taskId,
      actor: input.actor,
      type: 'github_auto_merge',
      payload: { merge }
    });
  } catch (error) {
    await appendTaskEvent(pool, {
      taskId: input.taskId,
      actor: input.actor,
      type: 'github_auto_merge_failed',
      payload: { error: (error as Error).message.slice(0, 500) }
    });
  }
};

/**
 * Turns auto-merge off, until GitHub confirms it, on every task of a project whose trail may have
 * it on (turned on, or an attempt with an unknown outcome) when it must not be: the task left
 * merging (sent back to building, or cancelled), the attempt failed, or the pull request was held
 * for commits nobody verified. The webhook that moved a task already tried once; this makes it
 * stick when that call failed.
 */
export const cancelStaleAutoMerges = async (
  pool: Pool,
  github: Pick<SyncGitHubPort, 'cancelAutoMerge'>,
  projectId: string
) => {
  const stale = await listStaleAutoMerges(pool, projectId);
  const failures: string[] = [];
  for (const task of stale) {
    try {
      await cancelTaskAutoMerge(pool, github, task);
    } catch (error) {
      failures.push(`${task.repo}#${task.pullRequest}: ${(error as Error).message}`);
    }
  }
  if (failures.length) throw new Error(`auto-merge still on: ${failures.join('; ')}`);
};

/** The spec file a task's branch adds, found by the project's spec directory. */
export const specPathIn = (
  changedPaths: readonly string[],
  specDir: string | null
): string | null => {
  if (!specDir) return null;
  const pattern = new RegExp(
    `^${specDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/$/, '')}/[^/]+\\.md$`
  );
  return changedPaths.find((path) => pattern.test(path)) ?? null;
};

const withStatus = (text: string, status: string) =>
  text.replace(/^Status: .*$/m, `Status: ${status}`);

/**
 * Whether the branch head is the status commit an earlier pass wrote but never recorded (the
 * process died, or GitHub's answer was lost after the write landed): its only parent is the
 * expected head and it changes only the spec file, to the expected head's text with this status.
 */
const isOwnStatusCommit = async (
  github: SyncGitHubPort,
  input: { ref: RepoRef; head: string; expected: string; path: string; status: string }
): Promise<boolean> => {
  const commit = await github.commitChanges({ ...input.ref, sha: input.head });
  if (commit.parents.length !== 1 || commit.parents[0] !== input.expected) return false;
  if (commit.paths.length !== 1 || commit.paths[0] !== input.path) return false;
  const at = (sha: string) => github.readFile({ ...input.ref, path: input.path, branch: sha });
  const [before, after] = await Promise.all([at(input.expected), at(input.head)]);
  if (!before || !after || after.text === before.text) return false;
  return after.text === withStatus(before.text, input.status);
};

/**
 * Records the status on a branch whose head is not the expected one. Officina's own status commit,
 * written by an earlier pass whose record was lost, stands for the task's head like any other.
 * Anything else holds commits nobody verified, and a status commit on top of them must not stand
 * for the task's head: recorded once, so the approval that follows sees the mismatch and skips.
 */
const recordUnexpectedHead = async (
  pool: Pool,
  github: SyncGitHubPort,
  input: {
    taskId: string;
    ref: RepoRef;
    status: string;
    head: string;
    expected: string | null;
    path: string | null;
  }
): Promise<'updated' | 'moved'> => {
  const { taskId, status, head, expected, path } = input;
  const own =
    expected !== null &&
    path !== null &&
    (await isOwnStatusCommit(github, { ref: input.ref, head, expected, path, status }));
  await appendTaskEvent(pool, {
    taskId,
    actor: ENGINE,
    type: 'spec_status_set',
    payload: own
      ? { status, path, commitSha: head }
      : { status, path: null, commitSha: null, branchMoved: head }
  });
  return own ? 'updated' : 'moved';
};

/**
 * Sets the spec's `Status:` line on the task branch, once per status. The builder cannot do it: it
 * does not know the pull request number when it pushes.
 */
export const syncSpecStatus = async (
  pool: Pool,
  github: SyncGitHubPort,
  input: {
    readonly taskId: string;
    readonly ref: RepoRef;
    readonly branch: string;
    readonly base: string;
    readonly specDir: string | null;
    readonly status: string;
  }
): Promise<'updated' | 'unchanged' | 'no_spec' | 'moved'> => {
  if (await hasTaskEvent(pool, input.taskId, 'spec_status_set', { status: input.status })) {
    return 'unchanged';
  }
  const facts = await github.pushFacts({ ...input.ref, base: input.base, branch: input.branch });
  const expected = await expectedHead(pool, input.taskId);
  const path = specPathIn(facts.changedPaths, input.specDir);
  if (facts.headSha !== expected) {
    return recordUnexpectedHead(pool, github, { ...input, head: facts.headSha, expected, path });
  }
  if (!path) return 'no_spec';
  const file = await github.readFile({ ...input.ref, path, branch: input.branch });
  if (!file) return 'no_spec';
  const text = withStatus(file.text, input.status);
  let commitSha: string | null = null;
  let unverified: string | null = null;
  if (text !== file.text) {
    const written = await github.updateFile({
      ...input.ref,
      path,
      branch: input.branch,
      text,
      sha: file.sha,
      message: `docs(spec): mark ${path.split('/').pop()!.replace(/\.md$/, '')} ${input.status}`
    });
    // A push between reading the branch and writing would put the commit on top of it instead.
    if (written?.commitSha && written.parentSha === expected) commitSha = written.commitSha;
    else if (written?.commitSha) unverified = written.commitSha;
  }
  // The commit is recorded so a review of it counts as a review of the task's head: it only
  // changes the spec's status line on top of the work that was reviewed.
  await appendTaskEvent(pool, {
    taskId: input.taskId,
    actor: ENGINE,
    type: 'spec_status_set',
    payload: { status: input.status, path, commitSha, ...(unverified ? { unverified } : {}) }
  });
  return text === file.text ? 'unchanged' : 'updated';
};

interface ChooserResult {
  readonly checklist?: readonly string[];
  readonly beforeAfter?: readonly { key: string; locale: string; before: string; after: string }[];
}

const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');

/** The verification checklist as markdown, for the pull request and for people reading it there. */
export const checklistMarkdown = (result: unknown, taskLink: string): string | null => {
  const chosen = result as ChooserResult | null;
  if (!chosen?.checklist?.length) return null;
  const lines = [
    `### Verification checklist for ${taskLink}`,
    '',
    ...chosen.checklist.map((item) => `- [ ] ${item}`)
  ];
  if (chosen.beforeAfter?.length) {
    lines.push('', '| Key | Locale | Before | After |', '| --- | --- | --- | --- |');
    for (const row of chosen.beforeAfter) {
      lines.push(
        `| \`${cell(row.key)}\` | ${cell(row.locale)} | ${cell(row.before)} | ${cell(row.after)} |`
      );
    }
  }
  return lines.join('\n');
};

/** Posts the chooser's checklist on the pull request, once. */
export const postChecklist = async (
  pool: Pool,
  github: SyncGitHubPort,
  input: { taskId: string; ref: RepoRef; pullRequest: number; taskLink: string; result: unknown }
) => {
  if (
    await hasTaskEvent(pool, input.taskId, 'checklist_posted', { pullRequest: input.pullRequest })
  )
    return;
  const body = checklistMarkdown(input.result, input.taskLink);
  if (!body) return;
  await github.commentOnIssue({ ...input.ref, issueNumber: input.pullRequest, body });
  await appendTaskEvent(pool, {
    taskId: input.taskId,
    actor: ENGINE,
    type: 'checklist_posted',
    payload: { pullRequest: input.pullRequest }
  });
};

/**
 * Marks the spec Implemented once the result is verified, by people or, in a green lane that opts
 * in, automatically: the final commit before merge, as the spec workflow asks. Then approves as the
 * verifier and hands the merge to GitHub or to a person (`autoMergeOnGitHub`, `awaitMerge`).
 */
const finishVerifiedSpec = async (
  pool: Pool,
  github: SyncGitHubPort,
  taskId: string,
  onBehalf?: OnBehalf
) => {
  const context = await loadTaskContext(pool, taskId);
  if (
    !context ||
    context.task.stage !== 'merging' ||
    !context.pullRequest ||
    !context.installationId
  )
    return;
  const config = parseProjectConfig(context.rawConfig);
  if (!config.ok) return;
  const ref: RepoRef = { installationId: context.installationId, repo: context.repo };
  // Merged or closed already, its webhook missed or not here yet: nothing is written to its branch
  // or threads, and the scheduler's catch-up applies what the webhook would have.
  const opened = await github.pullRequest({ ...ref, pullRequest: context.pullRequest });
  if (opened.state !== 'open') return;
  await syncSpecStatus(pool, github, {
    taskId,
    ref,
    branch: branchForTask(context.number),
    base: context.defaultBranch,
    specDir: config.config.docs.specDir,
    status: `Implemented (#${context.pullRequest})`
  });
  await resolveForwardedThreads(pool, github, {
    taskId,
    ref,
    pullRequest: context.pullRequest
  }).catch(() => undefined);
  // A review may have sent the task back while the GitHub calls above ran; acting on the
  // context loaded before them would approve a head that is no longer accepted.
  const current = await loadTask(pool, taskId);
  if (current?.task.stage !== 'merging' || current.task.headSha !== context.task.headSha) return;
  const pullRequest = context.pullRequest;
  // Checked on every pass, not once: a push after the verification (by anyone, at any time while
  // the task waits to merge) holds the pull request and gets auto-merge turned off, since
  // GitHub's auto-merge would land whatever the branch holds once its checks pass.
  const expected = await expectedHead(pool, taskId);
  // Read again: the status commit above moved the head, and the pull request may have closed since.
  const pr = await github.pullRequest({ ...ref, pullRequest });
  if (pr.state !== 'open') return;
  const head = pr.head.sha;
  if (!expected || head !== expected) {
    await holdMerge(pool, { taskId, pullRequest, head });
    return;
  }
  // A review bot's comment still settling may send the work back: nothing is handed to GitHub yet.
  if (await hasPendingBotComments(pool, context)) return;
  // GitHub merges on its own only when the project allows it and the chooser chose it for this
  // result; anything else is merged by a person.
  const autoMerge =
    config.config.pullRequest.autoMerge && current.task.approvalPlans.verifying?.merge === 'auto';
  // After the status commit, so the approval covers the final head. A result that skipped
  // people's verification has no verifier to approve as.
  if (await autoVerified(pool, taskId)) {
    if (autoMerge)
      await autoMergeOnGitHub(pool, {
        taskId,
        actor: ENGINE,
        merge: () => github.mergeWhenReady({ ...ref, pullRequest, expectedHead: expected })
      });
  } else if (onBehalf) {
    await approveOnGitHub(pool, onBehalf, {
      taskId,
      projectId: context.projectId,
      taskNumber: context.number,
      repo: context.repo,
      pullRequest
    });
    // Only on top of the verifier's own approval, so it never stands in for a missing review.
    const approved = await hasTaskEvent(pool, taskId, 'github_approved', { headSha: expected });
    const account = autoMerge && approved ? await verifierAccount(pool, onBehalf, taskId) : null;
    if (account)
      await autoMergeOnGitHub(pool, {
        taskId,
        actor: account.actor,
        merge: () =>
          onBehalf.asUser.mergeWhenReady(account.token, context.repo, pullRequest, expected)
      });
  }
  if (!(await handedToGitHub(pool, taskId))) await awaitMerge(pool, { taskId, pullRequest });
};

/** Finishes each task on its own: one that fails is reported and the others still go ahead. */
export const finishVerifiedSpecs = async (
  pool: Pool,
  github: SyncGitHubPort,
  taskIds: readonly string[],
  onBehalf?: OnBehalf
): Promise<{ taskId: string; error: string }[]> => {
  const failures: { taskId: string; error: string }[] = [];
  for (const taskId of taskIds) {
    await finishVerifiedSpec(pool, github, taskId, onBehalf).catch((error: unknown) =>
      failures.push({ taskId, error: (error as Error).message })
    );
  }
  return failures;
};
