import { hasRole, type Role } from '@officina/core';
import { decideLearning, loadLearning, type LearningRow } from '@officina/db';
import type { GitHubClient } from '@officina/github';
import type { Pool } from 'pg';
import { TaskCommandError } from './tasks';

export type LearningGitHub = Pick<
  GitHubClient,
  'readFile' | 'updateFile' | 'createBranch' | 'openPullRequest'
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

const titleFor = (learning: LearningRow) => {
  const summary = learning.title.charAt(0).toLowerCase() + learning.title.slice(1);
  return `docs(learning): ${summary}`.slice(0, 120);
};

/**
 * Accepting a project learning opens a pull request with exactly the edit people saw; an agent
 * learning is recorded for Officina's maintainers, whose repository Officina does not write to.
 * Either way people merge, never Officina.
 */
export const decide = async (
  pool: Pool,
  github: LearningGitHub | undefined,
  target: Target,
  input: { id: string; decision: 'accept' | 'reject'; note?: string | undefined }
): Promise<LearningRow> => {
  if (!hasRole({ id: target.memberId, role: target.role, domains: [] }, 'maintainer'))
    throw new TaskCommandError('only maintainers and owners decide on learnings');
  const learning = await loadLearning(pool, target.projectId, input.id);
  if (!learning) throw new TaskCommandError('learning not found');
  if (learning.status !== 'proposed')
    throw new TaskCommandError('this learning was already decided');

  let pr: { number: number; url: string } | undefined;
  if (input.decision === 'accept' && learning.target === 'project') {
    if (!github) throw new TaskCommandError('the GitHub App is not configured');
    const { rows } = await pool.query<{
      github_repo: string;
      github_installation_id: number | null;
      default_branch: string;
    }>('select github_repo, github_installation_id, default_branch from projects where id = $1', [
      target.projectId
    ]);
    const project = rows[0]!;
    if (project.github_installation_id === null)
      throw new TaskCommandError('the GitHub App is not installed on this repository');
    const ref = {
      installationId: Number(project.github_installation_id),
      repo: project.github_repo
    };
    const current = await github.readFile({
      ...ref,
      path: learning.file,
      branch: project.default_branch
    });
    const edited = applyEdit(current?.text ?? null, learning);
    if (!edited.ok)
      throw new TaskCommandError(`the edit no longer applies (${edited.why}); reject it instead`);
    const branch = `officina/learning-${learning.id.slice(0, 8)}`;
    const title = titleFor(learning);
    await github.createBranch({ ...ref, branch, from: project.default_branch });
    await github.updateFile({
      ...ref,
      path: learning.file,
      branch,
      text: edited.text,
      sha: current?.sha,
      message: title
    });
    const link = learning.taskNumber
      ? `[Officina task ${learning.taskNumber}](${target.publicUrl.replace(/\/$/, '')}/tasks/${learning.taskNumber})`
      : 'an Officina task';
    pr = await github.openPullRequest({
      ...ref,
      base: project.default_branch,
      branch,
      title,
      body: [
        `A learning from ${link}, accepted on the board.`,
        `**Lesson.** ${learning.lesson}`,
        `**Evidence.** ${learning.evidence}`,
        input.note ? `**Note from the reviewer.** ${input.note}` : null
      ]
        .filter(Boolean)
        .join('\n\n')
    });
  }

  const decided = await decideLearning(pool, {
    id: learning.id,
    status: input.decision === 'accept' ? 'accepted' : 'rejected',
    memberId: target.memberId,
    note: input.note ?? null,
    ...(pr ? { prNumber: pr.number, prUrl: pr.url } : {})
  });
  if (!decided) throw new TaskCommandError('this learning was already decided');
  return (await loadLearning(pool, target.projectId, learning.id))!;
};
