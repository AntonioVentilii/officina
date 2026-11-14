import { branchForLearning } from '@officina/core';
import type { LearningRow, ProjectRecord } from '@officina/db';
import type { GitHubClient, RepoRef } from '@officina/github';
import { taskLink } from '@officina/engine';
import { TaskCommandError } from './tasks';

export type LearningGitHub = Pick<
  GitHubClient,
  'readFile' | 'updateFile' | 'createBranch' | 'openPullRequest' | 'closePullRequestsFrom'
>;

/**
 * The output contract trims the text, so a replaced line would lose the line break that ended it
 * and the next line would join the addition. The break comes back as the replaced line had it, so a
 * file with CRLF line endings keeps them.
 */
const withLineBreakOf = (find: string, text: string) =>
  text.endsWith('\n') ? text : `${text}${/\r?\n$/.exec(find)?.[0] ?? ''}`;

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
  const text = withLineBreakOf(learning.find, learning.text);
  // A function replacer, so `$&` or `$$` in the text land as written rather than as patterns.
  return { ok: true, text: current.replace(learning.find, () => text) };
};

/** Agent docs learnings say so in their scope, so they read as changes to `docs/ai` in the history. */
const titleFor = (learning: LearningRow) => {
  const summary = learning.title.charAt(0).toLowerCase() + learning.title.slice(1);
  const scope = learning.target === 'docs' ? 'ai' : 'learning';
  return `docs(${scope}): ${summary}`.slice(0, 120);
};

/** A learning's pull request, and the commit Officina wrote on its branch when it wrote one. */
export interface OpenedLearning {
  readonly number: number;
  readonly url: string;
  readonly branchCommit?: { readonly sha: string; readonly parentSha: string };
}

/**
 * Renews the decision's claim right before a GitHub write, and throws once another decision has
 * taken it over, so two decisions never write for the same learning one after the other.
 */
export type Hold = () => Promise<void>;

/**
 * Writes the edit on the learning's branch, unless a branch an earlier attempt left already holds
 * it, and returns the commit written and the one it was written on, when GitHub names them.
 */
const writeEdit = async (
  github: LearningGitHub,
  file: RepoRef & { readonly path: string; readonly branch: string },
  edit: { readonly text: string; readonly message: string },
  hold: Hold
): Promise<OpenedLearning['branchCommit']> => {
  const onBranch = await github.readFile(file);
  if (onBranch?.text === edit.text) return undefined;
  await hold();
  const written = await github.updateFile({ ...file, ...edit, sha: onBranch?.sha });
  return written.commitSha && written.parentSha
    ? { sha: written.commitSha, parentSha: written.parentSha }
    : undefined;
};

/**
 * Opens the pull request with exactly the edit people saw; a branch an earlier attempt left is
 * reused. When the default branch changed so the edit no longer applies, nothing is written.
 */
export const openLearningPullRequest = async (
  github: LearningGitHub,
  project: ProjectRecord,
  learning: LearningRow,
  context: { readonly publicUrl: string; readonly note: string | undefined; readonly hold: Hold }
): Promise<{ ok: true; pr: OpenedLearning } | { ok: false; why: string }> => {
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
  const branch = branchForLearning(learning);
  const title = titleFor(learning);
  await context.hold();
  await github.createBranch({ ...ref, branch, from: project.defaultBranch });
  const branchCommit = await writeEdit(
    github,
    { ...ref, path: learning.file, branch },
    { text: edited.text, message: title },
    context.hold
  );
  const link = learning.taskNumber
    ? taskLink(context.publicUrl, project.id, learning.taskNumber)
    : 'an Officina task';
  await context.hold();
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
  return { ok: true, pr: { ...pr, ...(branchCommit ? { branchCommit } : {}) } };
};
