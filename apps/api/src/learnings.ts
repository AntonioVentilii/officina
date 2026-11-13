import { editsProject, hasRole, type Role } from '@officina/core';
import {
  decideLearning,
  inTransaction,
  loadLearning,
  loadProject,
  lockLearning,
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
  return { ok: true, text: current.replace(learning.find, learning.text) };
};

/** The one branch a learning's pull request is opened from, so a retry and a reject find it. */
const branchFor = (learning: LearningRow) => `officina/learning-${learning.id.slice(0, 8)}`;

/** Agent docs learnings say so in their scope, so they read as changes to `docs/ai` in the history. */
const titleFor = (learning: LearningRow) => {
  const summary = learning.title.charAt(0).toLowerCase() + learning.title.slice(1);
  const scope = learning.target === 'docs' ? 'ai' : 'learning';
  return `docs(${scope}): ${summary}`.slice(0, 120);
};

/** Opens the pull request with exactly the edit people saw; a branch an earlier attempt left is reused. */
const openLearningPullRequest = async (
  github: LearningGitHub,
  project: ProjectRecord,
  learning: LearningRow,
  context: { readonly publicUrl: string; readonly note: string | undefined }
): Promise<{ number: number; url: string }> => {
  if (project.installationId === null)
    throw new TaskCommandError('the GitHub App is not installed on this repository');
  const ref = { installationId: project.installationId, repo: project.repo };
  const current = await github.readFile({
    ...ref,
    path: learning.file,
    branch: project.defaultBranch
  });
  const edited = applyEdit(current?.text ?? null, learning);
  if (!edited.ok)
    throw new TaskCommandError(`the edit no longer applies (${edited.why}); reject it instead`);
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
  return github.openPullRequest({
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
  await github.closePullRequestsFrom({
    installationId: project.installationId,
    repo: project.repo,
    branch: branchFor(learning)
  });
};

/**
 * Accepting a learning for the project's docs or agent docs opens a pull request with exactly the edit people saw; an agent
 * learning is recorded for Officina's maintainers, whose repository Officina does not write to.
 * Either way people merge, never Officina. The learning stays locked from the first read to the
 * decision, so a second decision made meanwhile waits and then finds this one, and never leaves a
 * pull request for a learning it rejected.
 */
export const decide = async (
  pool: Pool,
  github: LearningGitHub | undefined,
  target: Target,
  input: { id: string; decision: 'accept' | 'reject'; note?: string | undefined }
): Promise<LearningRow> => {
  if (!hasRole({ id: target.memberId, role: target.role, domains: [] }, 'maintainer'))
    throw new TaskCommandError('only maintainers and owners decide on learnings');
  return inTransaction(pool, async (client) => {
    await lockLearning(client, input.id);
    const learning = await loadLearning(client, target.projectId, input.id);
    if (!learning) throw new TaskCommandError('learning not found');
    if (learning.status !== 'proposed')
      throw new TaskCommandError('this learning was already decided');
    let pr: { number: number; url: string } | undefined;
    if (input.decision === 'accept' && editsProject(learning.target)) {
      if (!github) throw new TaskCommandError('the GitHub App is not configured');
      const project = (await loadProject(client, target.projectId))!;
      pr = await openLearningPullRequest(github, project, learning, {
        publicUrl: target.publicUrl,
        note: input.note
      });
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
