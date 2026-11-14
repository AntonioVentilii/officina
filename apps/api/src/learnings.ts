import { can, editsProject, type Role } from '@officina/core';
import {
  decideLearning,
  inTransaction,
  loadLearning,
  loadProject,
  lockLearning,
  requestLearningRewrite,
  type LearningRow,
  type ProjectRecord
} from '@officina/db';
import type { GitHubClient } from '@officina/github';
import { taskLink } from '@officina/engine';
import type { Pool, PoolClient } from 'pg';
import { TaskCommandError } from './tasks';

export type LearningGitHub = Pick<
  GitHubClient,
  'readFile' | 'updateFile' | 'createBranch' | 'openPullRequest' | 'closePullRequestsFrom'
>;

interface Target {
  readonly projectId: string;
  readonly memberId: string;
  readonly role: Role;
  readonly publicUrl: string;
}

/** The file with the learning's edit applied, or why it no longer applies. */
export const applyEdit = (
  current: string | null,
  learning: Pick<LearningRow, 'find' | 'text'>
): { ok: true; text: string } | { ok: false; why: string } => {
  if (learning.find === null) {
    const base = current ?? '';
    const separator =
      base === '' || base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n';
    return { ok: true, text: `${base}${separator}${learning.text.trimEnd()}\n` };
  }
  if (current === null) return { ok: false, why: 'the file no longer exists' };
  const count = current.split(learning.find).length - 1;
  if (count !== 1) return { ok: false, why: `the text to replace now appears ${count} times` };
  // A function replacer, so `$&` or `$$` in the text land as written rather than as patterns.
  return { ok: true, text: current.replace(learning.find, () => learning.text) };
};

/** Agent docs learnings say so in their scope, so they read as changes to `docs/ai` in the history. */
const titleFor = (learning: LearningRow) => {
  const summary = learning.title.charAt(0).toLowerCase() + learning.title.slice(1);
  const scope = learning.target === 'docs' ? 'ai' : 'learning';
  return `docs(${scope}): ${summary}`.slice(0, 120);
};

/**
 * A rewritten edit gets a branch of its own: one an accept left before the rewrite starts from an
 * older default branch, while retries of the same edit keep reusing theirs.
 */
const branchFor = (learning: LearningRow) =>
  `officina/learning-${learning.id.slice(0, 8)}` +
  (learning.rewrittenAt ? `-${learning.rewrittenAt.getTime().toString(36)}` : '');

/**
 * Opens the pull request with exactly the edit people saw; a branch an earlier attempt left is
 * reused. When the default branch changed so the edit no longer applies, nothing is written.
 */
const openLearningPullRequest = async (
  github: LearningGitHub,
  project: ProjectRecord,
  learning: LearningRow,
  context: { readonly publicUrl: string; readonly note: string | undefined }
): Promise<{ ok: true; pr: { number: number; url: string } } | { ok: false; why: string }> => {
  if (project.installationId === null)
    throw new TaskCommandError('the GitHub App is not installed on this repository');
  const ref = { installationId: project.installationId, repo: project.repo };
  const current = await github.readFile({
    ...ref,
    path: learning.file,
    branch: project.defaultBranch
  });
  const edited = applyEdit(current?.text ?? null, learning);
  if (!edited.ok) return edited;
  const branch = branchFor(learning);
  const title = titleFor(learning);
  await github.createBranch({ ...ref, branch, from: project.defaultBranch });
  // A branch an earlier attempt left may already hold the edit; writing it again is skipped.
  const onBranch = await github.readFile({ ...ref, path: learning.file, branch });
  if (onBranch?.text !== edited.text) {
    await github.updateFile({
      ...ref,
      path: learning.file,
      branch,
      text: edited.text,
      sha: onBranch?.sha,
      message: title
    });
  }
  const link = learning.taskNumber
    ? taskLink(context.publicUrl, project.id, learning.taskNumber)
    : 'an Officina task';
  const pr = await github.openPullRequest({
    ...ref,
    base: project.defaultBranch,
    branch,
    title,
    body: [
      `A learning from ${link}, accepted on the board.`,
      `**Lesson.** ${learning.lesson}`,
      `**Evidence.** ${learning.evidence}`,
      context.note ? `**Note from the reviewer.** ${context.note}` : null
    ]
      .filter(Boolean)
      .join('\n\n')
  });
  return { ok: true, pr };
};

/** Why a learning cannot be accepted while its edit is being rewritten, or after that failed. */
const REWRITE_BLOCKS = {
  requested:
    'the learner is rewriting this edit against the current file; decide it once it is back',
  failed: 'the edit no longer applies and the learner could not rewrite it; reject it instead'
} as const;

/**
 * Opens the pull request of a project learning being accepted, or hands an edit the default branch
 * has moved past back to the learner to be rewritten, and then returns null.
 */
const acceptIntoPullRequest = async (
  client: PoolClient,
  learning: LearningRow,
  {
    github,
    target,
    note
  }: {
    readonly github: LearningGitHub | undefined;
    readonly target: Target;
    readonly note: string | undefined;
  }
): Promise<{ number: number; url: string } | null> => {
  if (learning.rewrite) throw new TaskCommandError(REWRITE_BLOCKS[learning.rewrite]);
  if (!github) throw new TaskCommandError('the GitHub App is not configured');
  const project = (await loadProject(client, target.projectId))!;
  const opened = await openLearningPullRequest(github, project, learning, {
    publicUrl: target.publicUrl,
    note
  });
  if (opened.ok) return opened.pr;
  // The learner works per task; a learning without one cannot be rewritten.
  if (learning.taskId === null)
    throw new TaskCommandError(`the edit no longer applies (${opened.why}); reject it instead`);
  await requestLearningRewrite(client, learning.id);
  return null;
};

/**
 * An accept whose decision failed to save may have left its pull request open; rejecting the
 * learning closes it, so nobody merges an edit people turned down.
 */
const closeLeftPullRequest = async (
  client: PoolClient,
  github: LearningGitHub | undefined,
  projectId: string,
  learning: LearningRow
): Promise<void> => {
  if (!github || !editsProject(learning.target)) return;
  const project = (await loadProject(client, projectId))!;
  if (project.installationId === null) return;
  // The branch of the edit as it stands, and the first one, which an accept before a rewrite used.
  const branches = new Set([branchFor(learning), branchFor({ ...learning, rewrittenAt: null })]);
  for (const branch of branches)
    await github.closePullRequestsFrom({
      installationId: project.installationId,
      repo: project.repo,
      branch
    });
};

/**
 * Accepting a learning for the project's docs or agent docs opens a pull request with exactly the edit people saw; an agent
 * learning is recorded for Officina's maintainers, whose repository Officina does not write to.
 * Either way people merge, never Officina. The learning stays locked from the first read to the
 * decision, so a second decision made meanwhile waits and then finds this one, and never leaves a
 * pull request for a learning it rejected. An edit the default branch has moved past goes back to
 * the learner to be rewritten, and the learning stays proposed until people see the new edit.
 */
export const decide = async (
  pool: Pool,
  github: LearningGitHub | undefined,
  target: Target,
  input: { id: string; decision: 'accept' | 'reject'; note?: string | undefined }
): Promise<LearningRow> => {
  if (!can(target, 'decide_learnings'))
    throw new TaskCommandError('only maintainers and owners decide on learnings');
  return inTransaction(pool, async (client) => {
    await lockLearning(client, input.id);
    const learning = await loadLearning(client, target.projectId, input.id);
    if (!learning) throw new TaskCommandError('learning not found');
    if (learning.status !== 'proposed')
      throw new TaskCommandError('this learning was already decided');
    let pr: { number: number; url: string } | undefined;
    if (input.decision === 'accept' && editsProject(learning.target)) {
      const opened = await acceptIntoPullRequest(client, learning, {
        github,
        target,
        note: input.note
      });
      if (!opened) return (await loadLearning(client, target.projectId, learning.id))!;
      pr = opened;
    }
    if (input.decision === 'reject')
      await closeLeftPullRequest(client, github, target.projectId, learning);
    await decideLearning(client, {
      id: learning.id,
      status: input.decision === 'accept' ? 'accepted' : 'rejected',
      memberId: target.memberId,
      note: input.note ?? null,
      ...(pr ? { prNumber: pr.number, prUrl: pr.url } : {})
    });
    return (await loadLearning(client, target.projectId, learning.id))!;
  });
};
